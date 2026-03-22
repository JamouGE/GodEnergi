const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ─── State ────────────────────────────────────────────────────────────────────
const chargers = {};        // chargerId → charger object
const sessions = {};        // transactionId → session
const alarms = [];          // alarm log (max 200)
const pendingCmds = {};     // msgId → { resolve, reject, timeout }
const ocpiLocations = {};   // locationId → location
const ocpiSessions = {};    // sessionId → session

const AUTHORIZED_TAGS = (process.env.AUTHORIZED_TAGS || 'TAG001,TAG002,GODENERGY01').split(',');
const OCPI_TOKEN_A = process.env.OCPI_TOKEN_A || 'godenergy-token-abc123';
const OCPI_TOKEN_B = process.env.OCPI_TOKEN_B || 'spirii-token-xyz789';

// ─── Alarm helper ─────────────────────────────────────────────────────────────
function addAlarm(chargerId, level, message, data = {}) {
  const alarm = { id: Date.now(), ts: new Date().toISOString(), chargerId, level, message, data, acknowledged: false };
  alarms.unshift(alarm);
  if (alarms.length > 200) alarms.pop();
  console.log(`[ALARM][${level}] ${chargerId}: ${message}`);
  return alarm;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const urlObj = new URL(req.url, 'http://localhost');
  const url = urlObj.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.end();

  const json = (data, code = 200) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data, null, 2));
  };

  // Dashboard
  if (url === '/' || url === '/dashboard') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'));
      res.setHeader('Content-Type', 'text/html');
      return res.end(html);
    } catch {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<h1>dashboard.html mangler — læg den i samme mappe som server.js</h1>');
    }
  }

  // Status API
  if (url === '/status') {
    return json({
      ocpp: {
        ladere: Object.entries(chargers).map(([id, c]) => ({
          id, online: true,
          vendor: c.vendor || null, model: c.model || null, firmware: c.firmware || null,
          ocppVersion: c.ocppVersion || null, connectors: c.connectors || {},
          activeTransaction: c.activeTransaction || null,
          lastHeartbeat: c.lastHeartbeat || null,
          config: c.config || {},
        })),
        sessioner: Object.values(sessions),
      },
      ocpi: {
        evses: Object.values(ocpiLocations),
        sessioner: Object.values(ocpiSessions),
      },
      alarmer: alarms.slice(0, 50),
    });
  }

  // Acknowledge alarm
  if (url.startsWith('/alarm/ack/')) {
    const alarmId = parseInt(url.split('/')[3]);
    const alarm = alarms.find(a => a.id === alarmId);
    if (alarm) alarm.acknowledged = true;
    return json({ ok: true });
  }

  // OCPI endpoints
  if (url.startsWith('/ocpi')) {
    const header = req.headers['authorization'] || '';
    const token = header.replace(/^(Token|Bearer)\s+/i, '').trim();
    const b64 = Buffer.from(OCPI_TOKEN_A).toString('base64');
    if (token !== OCPI_TOKEN_A && token !== b64) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ status_code: 2001, status_message: 'Unauthorized', timestamp: new Date() }));
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => handleOcpi(req, res, url, body));
    return;
  }

  // OCPP command routes
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch {}
    handleHttpCommand(url, payload, json);
  });
});

// ─── OCPP command dispatcher ──────────────────────────────────────────────────
async function handleHttpCommand(url, payload, json) {
  const parts = url.split('/').filter(Boolean);
  const cmd = parts[0];
  const chargerId = parts[1];

  if (!chargerId) return json({ error: 'Mangler charger ID' }, 400);
  const charger = chargers[chargerId];
  if (!charger) return json({ error: `Lader '${chargerId}' ikke forbundet` }, 404);

  try {
    switch (cmd) {

      // ── Start session ──────────────────────────────────────────────────────
      case 'start': {
        const connectorId = parseInt(parts[2]) || 1;
        const idTag = payload.idTag || 'GODENERGY01';
        const r = await sendCmd(chargerId, 'RemoteStartTransaction', { connectorId, idTag });
        return json({ ok: true, besked: `Start sendt — ${r.status}`, status: r.status });
      }

      // ── Stop session ───────────────────────────────────────────────────────
      case 'stop': {
        if (!charger.activeTransaction) return json({ error: 'Ingen aktiv session' }, 400);
        const txId = payload.transactionId || charger.activeTransaction;
        const r = await sendCmd(chargerId, 'RemoteStopTransaction', { transactionId: txId });
        return json({ ok: true, besked: `Stop sendt — ${r.status}`, status: r.status });
      }

      // ── Soft/Hard Reset ────────────────────────────────────────────────────
      case 'restart': {
        const type = (parts[2] === 'hard' || payload.type === 'Hard') ? 'Hard' : 'Soft';
        const r = await sendCmd(chargerId, 'Reset', { type });
        return json({ ok: true, besked: `${type} reset sendt — ${r.status}`, status: r.status });
      }

      // ── Unlock connector ───────────────────────────────────────────────────
      case 'unlock': {
        const connectorId = parseInt(parts[2] || payload.connectorId) || 1;
        const r = await sendCmd(chargerId, 'UnlockConnector', { connectorId });
        return json({ ok: true, besked: `Unlock sendt — ${r.status}`, status: r.status });
      }

      // ── Change availability ────────────────────────────────────────────────
      case 'availability': {
        const connectorId = parseInt(parts[2] ?? payload.connectorId ?? 0);
        const type = parts[3] || payload.type || 'Operative';
        const r = await sendCmd(chargerId, 'ChangeAvailability', { connectorId, type });
        return json({ ok: true, besked: `Availability sat til ${type} — ${r.status}`, status: r.status });
      }

      // ── Get configuration ──────────────────────────────────────────────────
      case 'getconfig': {
        const key = parts[2] || payload.key || undefined;
        const r = await sendCmd(chargerId, 'GetConfiguration', key ? { key: [key] } : {});
        if (r.configurationKey) {
          charger.config = charger.config || {};
          r.configurationKey.forEach(k => { charger.config[k.key] = { value: k.value, readonly: k.readonly }; });
        }
        return json({ ok: true, configuration: r.configurationKey || [], unknown: r.unknownKey || [] });
      }

      // ── Set configuration ──────────────────────────────────────────────────
      case 'setconfig': {
        const { key, value } = payload;
        if (!key || value === undefined) return json({ error: 'key og value påkrævet' }, 400);
        const r = await sendCmd(chargerId, 'ChangeConfiguration', { key, value: String(value) });
        return json({ ok: true, besked: `${key} sat til ${value} — ${r.status}`, status: r.status });
      }

      // ── Clear cache ────────────────────────────────────────────────────────
      case 'clearcache': {
        const r = await sendCmd(chargerId, 'ClearCache', {});
        return json({ ok: true, besked: `Cache ryddet — ${r.status}`, status: r.status });
      }

      // ── Trigger message ────────────────────────────────────────────────────
      case 'trigger': {
        const requestedMessage = parts[2] || payload.message || 'Heartbeat';
        const connectorId = payload.connectorId ? parseInt(payload.connectorId) : undefined;
        const p = { requestedMessage };
        if (connectorId) p.connectorId = connectorId;
        const r = await sendCmd(chargerId, 'TriggerMessage', p);
        return json({ ok: true, besked: `TriggerMessage(${requestedMessage}) — ${r.status}`, status: r.status });
      }

      // ── Set charging profile (power limit) ────────────────────────────────
      case 'setpower': {
        const connectorId = parseInt(parts[2] || payload.connectorId || 0);
        const limitW = parseFloat(payload.limitW || payload.limit || 22000);
        const r = await sendCmd(chargerId, 'SetChargingProfile', {
          connectorId,
          csChargingProfiles: {
            chargingProfileId: Date.now(),
            stackLevel: 0,
            chargingProfilePurpose: connectorId === 0 ? 'ChargePointMaxProfile' : 'TxDefaultProfile',
            chargingProfileKind: 'Absolute',
            chargingSchedule: {
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW }],
            },
          },
        });
        return json({ ok: true, besked: `Power limit sat til ${(limitW/1000).toFixed(1)} kW — ${r.status}`, status: r.status });
      }

      // ── Clear charging profile ─────────────────────────────────────────────
      case 'clearpower': {
        const connectorId = parseInt(parts[2] || payload.connectorId || 0);
        const r = await sendCmd(chargerId, 'ClearChargingProfile', {
          connectorId,
          chargingProfilePurpose: 'ChargePointMaxProfile',
          stackLevel: 0,
        });
        return json({ ok: true, besked: `Power limit fjernet — ${r.status}`, status: r.status });
      }

      // ── Reserve connector ──────────────────────────────────────────────────
      case 'reserve': {
        const connectorId = parseInt(parts[2] || payload.connectorId || 1);
        const idTag = payload.idTag || 'GODENERGY01';
        const expiryDate = payload.expiryDate || new Date(Date.now() + 3600000).toISOString();
        const reservationId = payload.reservationId || Date.now();
        const r = await sendCmd(chargerId, 'ReserveNow', { connectorId, expiryDate, idTag, reservationId });
        return json({ ok: true, besked: `Reserveret connector ${connectorId} — ${r.status}`, status: r.status, reservationId });
      }

      // ── Cancel reservation ─────────────────────────────────────────────────
      case 'cancelreserve': {
        const reservationId = parseInt(parts[2] || payload.reservationId);
        if (!reservationId) return json({ error: 'reservationId påkrævet' }, 400);
        const r = await sendCmd(chargerId, 'CancelReservation', { reservationId });
        return json({ ok: true, besked: `Reservation ${reservationId} annulleret — ${r.status}`, status: r.status });
      }

      // ── Send local list ────────────────────────────────────────────────────
      case 'sendlist': {
        const updateType = payload.updateType || 'Full';
        const localAuthorizationList = (payload.tags || AUTHORIZED_TAGS).map(tag => ({
          idTag: tag, idTagInfo: { status: 'Accepted' }
        }));
        const r = await sendCmd(chargerId, 'SendLocalList', {
          listVersion: Date.now(),
          updateType,
          localAuthorizationList,
        });
        return json({ ok: true, besked: `Local list sendt (${localAuthorizationList.length} tags) — ${r.status}`, status: r.status });
      }

      // ── Get local list version ─────────────────────────────────────────────
      case 'getlistversion': {
        const r = await sendCmd(chargerId, 'GetLocalListVersion', {});
        return json({ ok: true, listVersion: r.listVersion });
      }

      // ── Get diagnostics ────────────────────────────────────────────────────
      case 'getdiag': {
        const location = payload.location || 'ftp://diagnostics.godenergi.dk/';
        const r = await sendCmd(chargerId, 'GetDiagnostics', {
          location,
          startTime: payload.startTime,
          stopTime: payload.stopTime,
        });
        return json({ ok: true, besked: `Diagnostik anmodet`, fileName: r.fileName });
      }

      // ── Update firmware ────────────────────────────────────────────────────
      case 'updatefw': {
        if (!payload.location) return json({ error: 'location (firmware URL) påkrævet' }, 400);
        await sendCmd(chargerId, 'UpdateFirmware', {
          location: payload.location,
          retrieveDate: payload.retrieveDate || new Date().toISOString(),
        });
        return json({ ok: true, besked: `Firmware opdatering anmodet` });
      }

      // ── Data transfer (vendor specific) ───────────────────────────────────
      case 'datatransfer': {
        const { vendorId, messageId, data } = payload;
        if (!vendorId) return json({ error: 'vendorId påkrævet' }, 400);
        const r = await sendCmd(chargerId, 'DataTransfer', { vendorId, messageId, data });
        return json({ ok: true, status: r.status, data: r.data });
      }

      default:
        return json({ error: `Ukendt kommando: ${cmd}` }, 404);
    }
  } catch (e) {
    console.error(`[CMD ERROR] ${cmd} → ${chargerId}:`, e.message);
    return json({ error: e.message }, 500);
  }
}

// ─── Send command to charger and await response ───────────────────────────────
function sendCmd(chargerId, action, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const c = chargers[chargerId];
    if (!c || c.ws.readyState !== 1) return reject(new Error('Lader ikke forbundet'));
    const msgId = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const timeout = setTimeout(() => {
      delete pendingCmds[msgId];
      reject(new Error(`Timeout: ${action} svarede ikke inden ${timeoutMs}ms`));
    }, timeoutMs);
    pendingCmds[msgId] = { resolve, reject, timeout, action };
    c.ws.send(JSON.stringify([2, msgId, action, payload]));
    console.log(`[${chargerId}] 📤 ${action}`);
  });
}

// ─── OCPI handler ─────────────────────────────────────────────────────────────
function ocpiOk(data) {
  return JSON.stringify({ status_code: 1000, status_message: 'OK', data, timestamp: new Date() });
}

function handleOcpi(req, res, url, body) {
  res.setHeader('Content-Type', 'application/json');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${req.headers.host}`;
  const method = req.method;
  console.log(`[OCPI] ${method} ${url}`);

  if (url === '/ocpi/versions' && method === 'GET')
    return res.end(ocpiOk([{ version: '2.2.1', url: `${base}/ocpi/2.2.1` }]));

  if (url === '/ocpi/2.2.1' && method === 'GET')
    return res.end(ocpiOk({
      version: '2.2.1',
      endpoints: [
        { identifier: 'credentials', role: 'RECEIVER', url: `${base}/ocpi/2.2.1/credentials` },
        { identifier: 'locations',   role: 'RECEIVER', url: `${base}/ocpi/2.2.1/receiver/locations` },
        { identifier: 'sessions',    role: 'RECEIVER', url: `${base}/ocpi/2.2.1/receiver/sessions` },
        { identifier: 'cdrs',        role: 'RECEIVER', url: `${base}/ocpi/2.2.1/receiver/cdrs` },
        { identifier: 'tariffs',     role: 'RECEIVER', url: `${base}/ocpi/2.2.1/receiver/tariffs` },
        { identifier: 'tokens',      role: 'SENDER',   url: `${base}/ocpi/2.2.1/sender/tokens` },
      ]
    }));

  if (url === '/ocpi/2.2.1/credentials') {
    const d = parseBody(body);
    if (d && method !== 'GET') console.log('[OCPI] Credentials exchange:', d.token?.substring(0, 20));
    return res.end(ocpiOk({
      token: OCPI_TOKEN_B,
      url: `${base}/ocpi/versions`,
      roles: [{ role: 'EMSP', party_id: 'GDE', country_code: 'DK' }]
    }));
  }

  // Locations / EVSEs
  const locMatch = url.match(/^\/ocpi\/2\.2\.1\/receiver\/locations\/(.+?)(?:\/evses\/([^\/]+))?(?:\/connectors\/([^\/]+))?$/);
  if (locMatch) {
    const [, locationId, evseUid, connectorId] = locMatch;
    const d = parseBody(body);
    if (d) {
      if (evseUid && connectorId) {
        const loc = ocpiLocations[locationId];
        if (loc?.evses) {
          const evse = loc.evses.find(e => e.uid === evseUid);
          if (evse?.connectors) {
            const conn = evse.connectors.find(c => c.id === connectorId);
            if (conn) Object.assign(conn, d);
          }
        }
      } else if (evseUid) {
        const loc = ocpiLocations[locationId];
        if (loc?.evses) {
          const evse = loc.evses.find(e => e.uid === evseUid);
          if (evse) Object.assign(evse, d);
          else loc.evses.push({ ...d, uid: evseUid });
        } else {
          ocpiLocations[evseUid] = { ...d, updated_at: new Date() };
        }
        console.log(`[OCPI] EVSE ${evseUid} → ${d.status || '?'}`);
      } else {
        ocpiLocations[locationId] = method === 'PUT'
          ? { ...d, updated_at: new Date() }
          : { ...ocpiLocations[locationId], ...d, updated_at: new Date() };
        console.log(`[OCPI] Location ${locationId}: ${d.name || d.evse_id || '?'}`);
      }
    }
    return res.end(ocpiOk(null));
  }

  // Sessions
  const sesMatch = url.match(/^\/ocpi\/2\.2\.1\/receiver\/sessions\/([^\/]+)/);
  if (sesMatch) {
    const d = parseBody(body);
    if (d) {
      ocpiSessions[sesMatch[1]] = { ...d, updated_at: new Date() };
      console.log(`[OCPI] Session ${sesMatch[1]}: ${d.status} ${d.kwh || 0} kWh`);
    }
    return res.end(ocpiOk(null));
  }

  // CDRs
  const cdrMatch = url.match(/^\/ocpi\/2\.2\.1\/receiver\/cdrs/);
  if (cdrMatch) {
    const d = parseBody(body);
    if (d) console.log(`[OCPI] CDR modtaget: ${d.id} — ${d.total_energy} kWh`);
    return res.end(ocpiOk(null));
  }

  // Tokens (sender — respond with list)
  if (url.startsWith('/ocpi/2.2.1/sender/tokens')) {
    return res.end(ocpiOk(AUTHORIZED_TAGS.map(tag => ({
      uid: tag, type: 'RFID', auth_method: 'AUTH_REQUEST',
      issuer: 'GodEnergi', valid: true, whitelist: 'ALLOWED',
      last_updated: new Date().toISOString(),
    }))));
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ status_code: 2000, status_message: 'Not found', timestamp: new Date() }));
}

function parseBody(body) {
  try { return body ? JSON.parse(body) : null; } catch { return null; }
}

// ─── WebSocket server (OCPP) ──────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  handleProtocols: (protocols) => {
    const list = [...protocols];
    console.log(`[OCPP] Subprotokol:`, list);
    for (const p of list) { if (p.toLowerCase().startsWith('ocpp')) return p; }
    return list[0] || false;
  }
});

httpServer.on('upgrade', (req) => {
  console.log(`[OCPP UPGRADE] ${req.url} — ${req.headers['sec-websocket-protocol'] || 'ingen'}`);
});

wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const chargerId = decodeURIComponent(urlParts[urlParts.length - 1]) || 'unknown';

  chargers[chargerId] = {
    ws, ocppVersion: ws.protocol,
    connectors: {}, model: null, vendor: null, firmware: null,
    activeTransaction: null, lastHeartbeat: null, config: {},
  };

  console.log(`\n🔌 [${chargerId}] Forbundet (${ws.protocol}) — ${new Date().toLocaleTimeString()}`);
  addAlarm(chargerId, 'info', 'Lader forbundet');

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const [msgType, msgId, ...rest] = msg;

    if (msgType === 2) {
      // CALL from charger
      handleOcppCall(chargerId, msgId, rest[0], rest[1] || {}, ws);
    } else if (msgType === 3) {
      // CALLRESULT — response to our command
      const pending = pendingCmds[msgId];
      if (pending) {
        clearTimeout(pending.timeout);
        delete pendingCmds[msgId];
        pending.resolve(rest[0] || {});
      }
    } else if (msgType === 4) {
      // CALLERROR
      const pending = pendingCmds[msgId];
      if (pending) {
        clearTimeout(pending.timeout);
        delete pendingCmds[msgId];
        pending.reject(new Error(`${rest[0]}: ${rest[1]}`));
      }
      console.log(`[${chargerId}] ❌ CALLERROR:`, rest);
      addAlarm(chargerId, 'error', `OCPP fejl: ${rest[1] || rest[0]}`, { msgId, error: rest });
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`\n🔴 [${chargerId}] Afbrudt (${code}) — ${new Date().toLocaleTimeString()}`);
    addAlarm(chargerId, 'warning', `Lader afbrudt (kode ${code})`);
    // Cancel pending commands
    Object.entries(pendingCmds).forEach(([mid, p]) => {
      if (chargers[chargerId]?.ws === ws) {
        clearTimeout(p.timeout);
        p.reject(new Error('Lader afbrudt'));
        delete pendingCmds[mid];
      }
    });
    delete chargers[chargerId];
  });

  ws.on('error', (err) => {
    console.log(`[${chargerId}] WebSocket fejl: ${err.message}`);
    addAlarm(chargerId, 'error', `WebSocket fejl: ${err.message}`);
  });
});

// ─── Handle incoming OCPP messages from charger ───────────────────────────────
function handleOcppCall(chargerId, msgId, action, payload, ws) {
  const charger = chargers[chargerId];
  const is16 = !charger?.ocppVersion?.includes('2.0');
  console.log(`[${chargerId}] 📨 ${action}`);

  const respond = (data) => ws.send(JSON.stringify([3, msgId, data]));
  const err = (code, desc) => ws.send(JSON.stringify([4, msgId, code, desc, {}]));

  switch (action) {

    // ── Boot ────────────────────────────────────────────────────────────────
    case 'BootNotification': {
      if (is16) {
        charger.vendor = payload.chargePointVendor;
        charger.model = payload.chargePointModel;
        charger.firmware = payload.firmwareVersion;
        charger.iccid = payload.iccid;
        charger.imsi = payload.imsi;
      } else {
        charger.vendor = payload.chargingStation?.vendorName;
        charger.model = payload.chargingStation?.model;
        charger.firmware = payload.chargingStation?.firmwareVersion;
      }
      console.log(`   ${charger.vendor} ${charger.model} fw:${charger.firmware}`);
      respond({ currentTime: new Date().toISOString(), interval: 30, status: 'Accepted' });
      break;
    }

    // ── Heartbeat ───────────────────────────────────────────────────────────
    case 'Heartbeat': {
      charger.lastHeartbeat = new Date().toISOString();
      respond({ currentTime: new Date().toISOString() });
      break;
    }

    // ── Status notification ─────────────────────────────────────────────────
    case 'StatusNotification': {
      if (is16) {
        const { connectorId, status, errorCode, info, vendorErrorCode } = payload;
        if (!charger.connectors[1]) charger.connectors[1] = {};
        charger.connectors[1][connectorId] = status;
        console.log(`   ${statusIcon(status)} C${connectorId}: ${status}${errorCode !== 'NoError' ? ` [${errorCode}]` : ''}`);
        if (errorCode && errorCode !== 'NoError') {
          addAlarm(chargerId, 'error', `Connector ${connectorId} fejl: ${errorCode}`, { connectorId, status, errorCode, info, vendorErrorCode });
        }
        if (status === 'Faulted') {
          addAlarm(chargerId, 'error', `Connector ${connectorId} i fejltilstand`, { connectorId, errorCode });
        }
      } else {
        const { evseId, connectorId, connectorStatus } = payload;
        if (!charger.connectors[evseId]) charger.connectors[evseId] = {};
        charger.connectors[evseId][connectorId || 0] = connectorStatus;
        console.log(`   ${statusIcon(connectorStatus)} EVSE ${evseId}/${connectorId}: ${connectorStatus}`);
      }
      respond({});
      break;
    }

    // ── Authorize ───────────────────────────────────────────────────────────
    case 'Authorize': {
      const tag = is16 ? payload.idTag : payload.idToken?.idToken;
      const ok = AUTHORIZED_TAGS.includes(tag);
      console.log(`   🔑 ${tag} → ${ok ? '✅ OK' : '❌ Afvist'}`);
      if (!ok) addAlarm(chargerId, 'warning', `Afvist RFID tag: ${tag}`, { tag });
      if (is16) {
        respond({ idTagInfo: { status: ok ? 'Accepted' : 'Invalid' } });
      } else {
        respond({ idTokenInfo: { status: ok ? 'Accepted' : 'Invalid' } });
      }
      break;
    }

    // ── Start transaction (OCPP 1.6) ─────────────────────────────────────────
    case 'StartTransaction': {
      const txId = Date.now();
      sessions[txId] = {
        id: txId, chargerId, connector: payload.connectorId,
        idTag: payload.idTag, meterStart: payload.meterStart || 0,
        start: new Date().toISOString(), kWh: 0, status: 'ACTIVE',
      };
      charger.activeTransaction = txId;
      console.log(`   ⚡ Session startet: ${txId} (tag: ${payload.idTag})`);
      addAlarm(chargerId, 'info', `Session startet på connector ${payload.connectorId}`, { txId, idTag: payload.idTag });
      respond({ transactionId: txId, idTagInfo: { status: 'Accepted' } });
      break;
    }

    // ── Stop transaction (OCPP 1.6) ──────────────────────────────────────────
    case 'StopTransaction': {
      const txId = payload.transactionId;
      if (sessions[txId]) {
        const meterStop = payload.meterStop || 0;
        sessions[txId].kWh = ((meterStop - (sessions[txId].meterStart || 0)) / 1000);
        sessions[txId].status = 'COMPLETED';
        sessions[txId].slut = new Date().toISOString();
        sessions[txId].reason = payload.reason || 'Local';
        console.log(`   🏁 Session afsluttet: ${txId} — ${sessions[txId].kWh.toFixed(3)} kWh (${payload.reason || 'Local'})`);
        addAlarm(chargerId, 'info', `Session afsluttet: ${sessions[txId].kWh.toFixed(2)} kWh`, { txId, reason: payload.reason });
      }
      charger.activeTransaction = null;
      respond({ idTagInfo: { status: 'Accepted' } });
      break;
    }

    // ── Meter values ─────────────────────────────────────────────────────────
    case 'MeterValues': {
      const txId = payload.transactionId;
      const kwh = extractKwh16(payload.meterValue);
      if (sessions[txId] && kwh !== null) {
        const meterStart = sessions[txId].meterStart || 0;
        sessions[txId].kWh = kwh - meterStart / 1000;
        sessions[txId].lastMeter = kwh;
        console.log(`   📊 ${txId}: ${sessions[txId].kWh.toFixed(3)} kWh`);
      }
      respond({});
      break;
    }

    // ── Transaction event (OCPP 2.0.1) ──────────────────────────────────────
    case 'TransactionEvent': {
      const { eventType, transactionInfo, meterValue, evse } = payload;
      const txId = transactionInfo?.transactionId;
      if (eventType === 'Started') {
        sessions[txId] = {
          id: txId, chargerId, evse: evse?.id,
          start: new Date().toISOString(), kWh: 0, status: 'ACTIVE',
        };
        charger.activeTransaction = txId;
        console.log(`   ⚡ ${txId}`);
      } else if (eventType === 'Updated') {
        const kwh = extractKwh201(meterValue);
        if (sessions[txId] && kwh !== null) { sessions[txId].kWh = kwh; console.log(`   📊 ${kwh} kWh`); }
      } else if (eventType === 'Ended') {
        const kwh = extractKwh201(meterValue);
        if (sessions[txId]) {
          sessions[txId].kWh = kwh ?? sessions[txId].kWh;
          sessions[txId].status = 'COMPLETED';
          sessions[txId].slut = new Date().toISOString();
        }
        charger.activeTransaction = null;
        console.log(`   🏁 ${sessions[txId]?.kWh} kWh`);
      }
      respond({});
      break;
    }

    // ── Diagnostics status ───────────────────────────────────────────────────
    case 'DiagnosticsStatusNotification': {
      console.log(`   🔧 Diagnostik: ${payload.status}`);
      addAlarm(chargerId, 'info', `Diagnostik status: ${payload.status}`);
      respond({});
      break;
    }

    // ── Firmware status ──────────────────────────────────────────────────────
    case 'FirmwareStatusNotification': {
      console.log(`   💾 Firmware: ${payload.status}`);
      addAlarm(chargerId, payload.status === 'InstallationFailed' ? 'error' : 'info',
        `Firmware opdatering: ${payload.status}`);
      respond({});
      break;
    }

    // ── Data transfer from charger ───────────────────────────────────────────
    case 'DataTransfer': {
      console.log(`   📦 DataTransfer fra ${payload.vendorId}: ${payload.messageId}`);
      respond({ status: 'Accepted' });
      break;
    }

    // ── Security event (OCPP 2.0.1) ─────────────────────────────────────────
    case 'SecurityEventNotification': {
      console.log(`   🔒 Security event: ${payload.type}`);
      addAlarm(chargerId, 'warning', `Security event: ${payload.type}`, payload);
      respond({});
      break;
    }

    // ── Log status (OCPP 2.0.1) ─────────────────────────────────────────────
    case 'LogStatusNotification': {
      console.log(`   📋 Log status: ${payload.status}`);
      respond({});
      break;
    }

    // ── Reservation status ───────────────────────────────────────────────────
    case 'ReservationStatusUpdate': {
      console.log(`   📅 Reservation ${payload.reservationId}: ${payload.reservationUpdateStatus}`);
      respond({});
      break;
    }

    // ── Unknown ──────────────────────────────────────────────────────────────
    default: {
      console.log(`   ⚪ Ukendt: ${action}`);
      respond({});
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractKwh16(meterValues) {
  if (!meterValues) return null;
  for (const mv of meterValues) {
    for (const sv of (mv.sampledValue || [])) {
      if (!sv.measurand || sv.measurand === 'Energy.Active.Import.Register') {
        const val = parseFloat(sv.value);
        if (isNaN(val)) continue;
        return (sv.unit || 'Wh') === 'kWh' ? val : val / 1000;
      }
    }
  }
  return null;
}

function extractKwh201(meterValues) {
  if (!meterValues) return null;
  const values = Array.isArray(meterValues) ? meterValues : [meterValues];
  for (const mv of values) {
    for (const sv of (mv.sampledValue || [])) {
      if (!sv.measurand || sv.measurand === 'Energy.Active.Import.Register') {
        const val = parseFloat(sv.value);
        if (isNaN(val)) continue;
        return (sv.unitOfMeasure?.unit || sv.unit || 'Wh') === 'kWh' ? val : val / 1000;
      }
    }
  }
  return null;
}

function statusIcon(s) {
  return { Available: '🟢', Charging: '⚡', Occupied: '⚡', Preparing: '🟡',
    Finishing: '🟡', Unavailable: '🔴', Faulted: '❌', Reserved: '🔵',
    SuspendedEV: '🟠', SuspendedEVSE: '🟠' }[s] || '⚪';
}

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n⚡ GodEnergi Charge Control v2.0 — port ${PORT}`);
  console.log(`   Dashboard:    http://localhost:${PORT}/`);
  console.log(`   Status API:   http://localhost:${PORT}/status`);
  console.log(`   OCPI:         http://localhost:${PORT}/ocpi/versions`);
  console.log(`   OCPP WS:      ws://localhost:${PORT}/<CHARGER_ID>\n`);
  console.log(`   Kommandoer:`);
  console.log(`   POST /start/:id/:connector    { idTag }`);
  console.log(`   POST /stop/:id                { transactionId }`);
  console.log(`   POST /restart/:id/soft|hard`);
  console.log(`   POST /unlock/:id/:connector`);
  console.log(`   POST /availability/:id/:connector/Operative|Inoperative`);
  console.log(`   GET  /getconfig/:id/:key?`);
  console.log(`   POST /setconfig/:id           { key, value }`);
  console.log(`   POST /setpower/:id/:connector { limitW }`);
  console.log(`   POST /clearpower/:id/:connector`);
  console.log(`   POST /trigger/:id/:message`);
  console.log(`   POST /reserve/:id/:connector  { idTag, expiryDate }`);
  console.log(`   POST /cancelreserve/:id/:reservationId`);
  console.log(`   POST /sendlist/:id            { tags[], updateType }`);
  console.log(`   GET  /getlistversion/:id`);
  console.log(`   POST /clearcache/:id`);
  console.log(`   POST /datatransfer/:id        { vendorId, messageId, data }\n`);
  console.log(`   TOKEN_A: ${OCPI_TOKEN_A}`);
});

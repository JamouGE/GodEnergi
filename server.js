const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ─── State ────────────────────────────────────────────────────────────────────
const chargers = {};
const sessions = {};
const alarms = [];
const pendingCmds = {};
const ocpiLocations = {};
const ocpiSessions = {};

// ChargEye OCPI connection — populated after credentials exchange
const chargeEye = {
  token: process.env.CHARGEYE_TOKEN || null,
  versionsUrl: process.env.CHARGEYE_VERSIONS_URL || null,
  commandsUrl: null,
  credentialsUrl: null,
};

const AUTHORIZED_TAGS = (process.env.AUTHORIZED_TAGS || 'TAG001,TAG002,GODENERGY01').split(',');
const OCPI_TOKEN_A = process.env.OCPI_TOKEN_A || 'godenergy-token-abc123';
const OCPI_TOKEN_B = process.env.OCPI_TOKEN_B || 'spirii-token-xyz789';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function addAlarm(chargerId, level, message, data = {}) {
  const alarm = { id: Date.now() + Math.random(), ts: new Date().toISOString(), chargerId, level, message, data, acknowledged: false };
  alarms.unshift(alarm);
  if (alarms.length > 200) alarms.pop();
  console.log(`[ALARM][${level.toUpperCase()}] ${chargerId}: ${message}`);
  return alarm;
}

function parseBody(body) {
  try { return body ? JSON.parse(body) : null; } catch { return null; }
}

function statusIcon(s) {
  return { Available: '🟢', Charging: '⚡', Occupied: '⚡', Preparing: '🟡',
    Finishing: '🟡', Unavailable: '🔴', Faulted: '❌', Reserved: '🔵',
    SuspendedEV: '🟠', SuspendedEVSE: '🟠' }[s] || '⚪';
}

// Extract location name from EVSE ID — e.g. "GDE-UDLEJNING-01*01" → "UDLEJNING"
function locationFromEvseId(evseId) {
  if (!evseId) return 'Ukendt';
  const parts = evseId.split('-');
  if (parts.length >= 2) return parts.slice(1, -1).join('-').replace(/-\d+$/, '');
  return evseId.split('*')[0] || evseId;
}

// ─── OCPI Pull — hent data fra ChargEye ved opstart ─────────────────────────────
async function pullFromChargeEye() {
  if (!chargeEye.token || !chargeEye.versionsUrl) return;
  console.log('[OCPI PULL] Henter data fra ChargEye...');

  try {
    // Hent version detail for at finde locations + sessions endpoints
    const versionData = await ocpiGet(chargeEye.versionsUrl);
    const versions = versionData?.data || [];
    const v221 = versions.find(v => v.version === '2.2.1') || versions[0];
    if (!v221) return console.log('[OCPI PULL] Ingen 2.2.1 version fundet');

    const detailData = await ocpiGet(v221.url);
    const endpoints = detailData?.data?.endpoints || [];

    // Find locations endpoint (SENDER rolle hos ChargEye = de ejer data)
    const locEndpoint = endpoints.find(e => e.identifier === 'locations' && e.role === 'SENDER');
    const sesEndpoint = endpoints.find(e => e.identifier === 'sessions' && e.role === 'SENDER');

    if (locEndpoint) {
      try {
        const locData = await ocpiGet(locEndpoint.url);
        const locations = locData?.data || [];
        console.log(`[OCPI PULL] Modtaget ${locations.length} lokationer`);
        locations.forEach(loc => {
          (loc.evses || []).forEach(evse => {
            ocpiLocations[evse.uid] = { ...evse, updated_at: new Date() };
            console.log(`[OCPI PULL] EVSE ${evse.evse_id || evse.uid}: ${evse.status}`);
          });
        });
      } catch (e) { console.log('[OCPI PULL] Locations fejl:', e.message); }
    } else {
      // Prøv direkte locations URL
      try {
        const base = chargeEye.versionsUrl.replace('/versions', '');
        const locData = await ocpiGet(`${base}/2.2.1/cpo/locations`);
        const locations = locData?.data || [];
        locations.forEach(loc => {
          (loc.evses || []).forEach(evse => {
            ocpiLocations[evse.uid] = { ...evse, updated_at: new Date() };
          });
        });
        console.log(`[OCPI PULL] ${locations.length} lokationer via direkte URL`);
      } catch {}
    }

    if (sesEndpoint) {
      try {
        const sesData = await ocpiGet(sesEndpoint.url);
        const sesses = sesData?.data || [];
        console.log(`[OCPI PULL] Modtaget ${sesses.length} sessioner`);
        sesses.forEach(s => {
          if (s.status === 'ACTIVE') {
            ocpiSessions[s.id] = { ...s, _id: s.id, updated_at: new Date() };
            console.log(`[OCPI PULL] Session ${s.id}: ${s.status} ${s.kwh} kWh`);
          }
        });
      } catch (e) { console.log('[OCPI PULL] Sessions fejl:', e.message); }
    }

  } catch (e) {
    console.log('[OCPI PULL] Fejl:', e.message);
  }
}

// ─── OCPI → ChargEye commands ─────────────────────────────────────────────────
async function fetchChargeEyeEndpoints() {
  if (!chargeEye.versionsUrl || !chargeEye.token) return;
  try {
    const versionData = await ocpiGet(chargeEye.versionsUrl);
    const versions = versionData?.data || [];
    const v221 = versions.find(v => v.version === '2.2.1') || versions[0];
    if (!v221) return;

    const detailData = await ocpiGet(v221.url);
    const endpoints = detailData?.data?.endpoints || [];
    const cmds = endpoints.find(e => e.identifier === 'commands');
    const creds = endpoints.find(e => e.identifier === 'credentials');
    if (cmds) { chargeEye.commandsUrl = cmds.url; console.log('[OCPI] ChargEye commands URL:', cmds.url); }
    if (creds) { chargeEye.credentialsUrl = creds.url; }
  } catch (e) {
    console.log('[OCPI] Kunne ikke hente ChargEye endpoints:', e.message);
  }
}

function ocpiGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'Authorization': `Token ${chargeEye.token}` } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

function ocpiPost(url, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search, method: 'POST',
      headers: { 'Authorization': `Token ${chargeEye.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function sendOcpiCommand(commandType, params) {
  if (!chargeEye.commandsUrl) {
    await fetchChargeEyeEndpoints();
    if (!chargeEye.commandsUrl) throw new Error('ChargEye commands URL ikke tilgængelig — lav credentials exchange først');
  }
  const responseUrl = `${process.env.BASE_URL || 'https://godenergi-production.up.railway.app'}/ocpi/commands/response`;
  const body = { ...params, response_url: responseUrl };
  console.log(`[OCPI CMD] ${commandType}:`, JSON.stringify(body).substring(0, 120));
  return await ocpiPost(`${chargeEye.commandsUrl}/${commandType}`, body);
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
    } catch { res.setHeader('Content-Type','text/html'); return res.end('<h1>dashboard.html mangler</h1>'); }
  }

  // Status
  if (url === '/status') {
    // Group EVSEs by location
    const evseList = Object.values(ocpiLocations);
    const locationMap = {};
    evseList.forEach(evse => {
      const loc = locationFromEvseId(evse.evse_id);
      if (!locationMap[loc]) locationMap[loc] = { name: loc, evses: [], sessions: [] };
      locationMap[loc].evses.push(evse);
    });
    Object.values(ocpiSessions).forEach(sess => {
      const evse = evseList.find(e => e.uid === sess.evse_uid);
      if (evse) {
        const loc = locationFromEvseId(evse.evse_id);
        if (locationMap[loc]) locationMap[loc].sessions.push(sess);
      }
    });

    return json({
      ocpp: {
        ladere: Object.entries(chargers).map(([id, c]) => ({
          id, online: true, vendor: c.vendor, model: c.model, firmware: c.firmware,
          ocppVersion: c.ocppVersion, connectors: c.connectors,
          activeTransaction: c.activeTransaction, lastHeartbeat: c.lastHeartbeat, config: c.config,
        })),
        sessioner: Object.values(sessions),
      },
      ocpi: {
        evses: evseList,
        sessioner: Object.values(ocpiSessions),
        lokationer: Object.values(locationMap),
      },
      alarmer: alarms.slice(0, 100),
      chargeEye: {
        connected: !!chargeEye.token,
        commandsAvailable: !!chargeEye.commandsUrl,
        versionsUrl: chargeEye.versionsUrl,
      },
    });
  }

  // Alarm ack
  if (url.startsWith('/alarm/ack/')) {
    const id = parseFloat(url.split('/')[3]);
    const a = alarms.find(x => x.id === id);
    if (a) a.acknowledged = true;
    return json({ ok: true });
  }

  // OCPI endpoints
  if (url.startsWith('/ocpi')) {
    const header = req.headers['authorization'] || '';
    const token = header.replace(/^(Token|Bearer)\s+/i, '').trim();
    const b64 = Buffer.from(OCPI_TOKEN_A).toString('base64');

    // Command response callback from ChargEye
    if (url === '/ocpi/commands/response') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        const d = parseBody(body);
        console.log('[OCPI CMD RESPONSE]', JSON.stringify(d));
        addAlarm('ChargEye', 'info', `OCPI kommando svar: ${d?.result || d?.status || 'OK'}`, d || {});
      });
      return res.end(JSON.stringify({ status_code: 1000, status_message: 'OK', timestamp: new Date() }));
    }

    if (token !== OCPI_TOKEN_A && token !== b64) {
      console.log(`[OCPI AUTH] Afvist: ${token.substring(0, 20)}...`);
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ status_code: 2001, status_message: 'Unauthorized', timestamp: new Date() }));
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => handleOcpi(req, res, url, body));
    return;
  }

  // OCPP + OCPI commands
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
  const id = parts[1];

  // OCPI commands (via ChargEye)
  if (cmd === 'ocpi-cmd') {
    const action = parts[2];
    try {
      let result;
      switch (action) {
        case 'start': {
          const evseUid = payload.evseUid || parts[3];
          const locationId = payload.locationId || 'Udlej';
          result = await sendOcpiCommand('START_SESSION', {
            location_id: locationId,
            evse_uid: evseUid,
            token: { uid: payload.idTag || 'GODENERGY01', type: 'RFID', contract_id: '1',
                     country_code: 'DK', party_id: 'GDE' },
          });
          break;
        }
        case 'stop': {
          const sessionId = payload.sessionId || parts[3];
          result = await sendOcpiCommand('STOP_SESSION', { session_id: sessionId });
          break;
        }
        case 'unlock': {
          const locationId = payload.locationId;
          const evseUid = payload.evseUid || parts[3];
          const connectorId = payload.connectorId || parts[4] || '11';
          result = await sendOcpiCommand('UNLOCK_CONNECTOR', {
            location_id: locationId, evse_uid: evseUid, connector_id: connectorId,
          });
          break;
        }
        case 'reserve': {
          result = await sendOcpiCommand('RESERVE_NOW', {
            location_id: payload.locationId, evse_uid: payload.evseUid,
            expiry_date: payload.expiryDate || new Date(Date.now() + 3600000).toISOString(),
            reservation_id: Date.now(),
            token: { uid: payload.idTag || 'GODENERGY01', type: 'RFID', contract_id: '1',
                     country_code: 'DK', party_id: 'GDE' },
          });
          break;
        }
        case 'cancel-reserve': {
          result = await sendOcpiCommand('CANCEL_RESERVATION', { reservation_id: parseInt(payload.reservationId) });
          break;
        }
        case 'fetch-endpoints': {
          await fetchChargeEyeEndpoints();
          return json({ ok: true, commandsUrl: chargeEye.commandsUrl, versionsUrl: chargeEye.versionsUrl });
        }
        default:
          return json({ error: `Ukendt OCPI kommando: ${action}` }, 400);
      }
      return json({ ok: true, result });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // OCPP commands
  if (!id) return json({ error: 'Mangler charger ID' }, 400);
  const charger = chargers[id];
  if (!charger) return json({ error: `Lader '${id}' ikke forbundet` }, 404);

  try {
    switch (cmd) {
      case 'start': {
        const connectorId = parseInt(parts[2]) || 1;
        const r = await sendCmd(id, 'RemoteStartTransaction', { connectorId, idTag: payload.idTag || 'GODENERGY01' });
        return json({ ok: true, besked: `Start sendt — ${r.status}`, status: r.status });
      }
      case 'stop': {
        if (!charger.activeTransaction && !payload.transactionId) return json({ error: 'Ingen aktiv session' }, 400);
        const r = await sendCmd(id, 'RemoteStopTransaction', { transactionId: payload.transactionId || charger.activeTransaction });
        return json({ ok: true, besked: `Stop sendt — ${r.status}`, status: r.status });
      }
      case 'restart': {
        const type = parts[2] === 'hard' ? 'Hard' : 'Soft';
        const r = await sendCmd(id, 'Reset', { type });
        return json({ ok: true, besked: `${type} reset sendt — ${r.status}`, status: r.status });
      }
      case 'unlock': {
        const connectorId = parseInt(parts[2] || payload.connectorId) || 1;
        const r = await sendCmd(id, 'UnlockConnector', { connectorId });
        return json({ ok: true, besked: `Unlock sendt — ${r.status}`, status: r.status });
      }
      case 'availability': {
        const connectorId = parseInt(parts[2] ?? payload.connectorId ?? 0);
        const type = parts[3] || payload.type || 'Operative';
        const r = await sendCmd(id, 'ChangeAvailability', { connectorId, type });
        return json({ ok: true, besked: `Availability → ${type} — ${r.status}`, status: r.status });
      }
      case 'getconfig': {
        const key = parts[2] || payload.key;
        const r = await sendCmd(id, 'GetConfiguration', key ? { key: [key] } : {});
        if (r.configurationKey) {
          charger.config = charger.config || {};
          r.configurationKey.forEach(k => { charger.config[k.key] = { value: k.value, readonly: k.readonly }; });
        }
        return json({ ok: true, configuration: r.configurationKey || [], unknown: r.unknownKey || [] });
      }
      case 'setconfig': {
        const { key, value } = payload;
        if (!key || value === undefined) return json({ error: 'key og value påkrævet' }, 400);
        const r = await sendCmd(id, 'ChangeConfiguration', { key, value: String(value) });
        return json({ ok: true, besked: `${key} = ${value} — ${r.status}`, status: r.status });
      }
      case 'clearcache': {
        const r = await sendCmd(id, 'ClearCache', {});
        return json({ ok: true, besked: `Cache ryddet — ${r.status}`, status: r.status });
      }
      case 'trigger': {
        const requestedMessage = parts[2] || payload.message || 'Heartbeat';
        const p = { requestedMessage };
        if (payload.connectorId) p.connectorId = parseInt(payload.connectorId);
        const r = await sendCmd(id, 'TriggerMessage', p);
        return json({ ok: true, besked: `Trigger(${requestedMessage}) — ${r.status}`, status: r.status });
      }
      case 'setpower': {
        const connectorId = parseInt(parts[2] || payload.connectorId || 0);
        const limitW = parseFloat(payload.limitW || 22000);
        const r = await sendCmd(id, 'SetChargingProfile', {
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
        return json({ ok: true, besked: `Power limit ${(limitW/1000).toFixed(1)} kW — ${r.status}`, status: r.status });
      }
      case 'clearpower': {
        const connectorId = parseInt(parts[2] || payload.connectorId || 0);
        const r = await sendCmd(id, 'ClearChargingProfile', { connectorId, stackLevel: 0 });
        return json({ ok: true, besked: `Power limit fjernet — ${r.status}`, status: r.status });
      }
      case 'reserve': {
        const connectorId = parseInt(parts[2] || payload.connectorId || 1);
        const reservationId = Date.now();
        const r = await sendCmd(id, 'ReserveNow', {
          connectorId, idTag: payload.idTag || 'GODENERGY01', reservationId,
          expiryDate: payload.expiryDate || new Date(Date.now() + 3600000).toISOString(),
        });
        return json({ ok: true, besked: `Reserveret C${connectorId} — ${r.status}`, reservationId, status: r.status });
      }
      case 'cancelreserve': {
        const reservationId = parseInt(parts[2] || payload.reservationId);
        if (!reservationId) return json({ error: 'reservationId påkrævet' }, 400);
        const r = await sendCmd(id, 'CancelReservation', { reservationId });
        return json({ ok: true, besked: `Reservation annulleret — ${r.status}`, status: r.status });
      }
      case 'sendlist': {
        const tags = payload.tags || AUTHORIZED_TAGS;
        const r = await sendCmd(id, 'SendLocalList', {
          listVersion: Date.now(),
          updateType: payload.updateType || 'Full',
          localAuthorizationList: tags.map(t => ({ idTag: t, idTagInfo: { status: 'Accepted' } })),
        });
        return json({ ok: true, besked: `Local list sendt (${tags.length} tags) — ${r.status}`, status: r.status });
      }
      case 'getlistversion': {
        const r = await sendCmd(id, 'GetLocalListVersion', {});
        return json({ ok: true, listVersion: r.listVersion });
      }
      case 'datatransfer': {
        const { vendorId, messageId, data } = payload;
        if (!vendorId) return json({ error: 'vendorId påkrævet' }, 400);
        const r = await sendCmd(id, 'DataTransfer', { vendorId, messageId, data });
        return json({ ok: true, status: r.status, data: r.data });
      }
      default:
        return json({ error: `Ukendt kommando: ${cmd}` }, 404);
    }
  } catch (e) {
    console.error(`[CMD ERROR] ${cmd}/${id}:`, e.message);
    return json({ error: e.message }, 500);
  }
}

// ─── Send OCPP command and await response ─────────────────────────────────────
function sendCmd(chargerId, action, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const c = chargers[chargerId];
    if (!c || c.ws.readyState !== 1) return reject(new Error('Lader ikke forbundet'));
    const msgId = `${action}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const timeout = setTimeout(() => {
      delete pendingCmds[msgId];
      reject(new Error(`Timeout: ${action} svarede ikke`));
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
        { identifier: 'commands',    role: 'RECEIVER', url: `${base}/ocpi/2.2.1/receiver/commands` },
      ]
    }));

  // Credentials exchange — save ChargEye's token and URL
  if (url === '/ocpi/2.2.1/credentials') {
    const d = parseBody(body);
    if (d && method !== 'GET') {
      console.log('[OCPI] Credentials exchange — ChargEye token:', d.token?.substring(0, 20));
      if (d.token) {
        chargeEye.token = d.token;
        chargeEye.versionsUrl = d.url;
        console.log('[OCPI] ✅ ChargEye token gemt! Henter endpoints...');
        fetchChargeEyeEndpoints().then(() => pullFromChargeEye());
      }
    }
    return res.end(ocpiOk({
      token: OCPI_TOKEN_B,
      url: `${base}/ocpi/versions`,
      roles: [{ role: 'EMSP', party_id: 'GDE', country_code: 'DK' }]
    }));
  }

  // Locations / EVSEs
  const locMatch = url.match(/^\/ocpi\/2\.2\.1\/receiver\/locations\/(.+?)(?:\/evses\/([^\/]+))?(?:\/connectors\/([^\/]+))?$/);
  if (locMatch) {
    const [, locationId, evseUid] = locMatch;
    const d = parseBody(body);
    if (d) {
      if (evseUid) {
        const existing = ocpiLocations[evseUid];
        ocpiLocations[evseUid] = existing
          ? { ...existing, ...d, updated_at: new Date() }
          : { ...d, uid: evseUid, updated_at: new Date() };
        console.log(`[OCPI] EVSE ${evseUid} → ${d.status || '?'}`);
      } else {
        const key = `loc-${locationId}`;
        ocpiLocations[key] = method === 'PUT'
          ? { ...d, _locationId: locationId, updated_at: new Date() }
          : { ...ocpiLocations[key], ...d, _locationId: locationId, updated_at: new Date() };
        console.log(`[OCPI] Location ${locationId}: ${d.name || '?'}`);
      }
    }
    return res.end(ocpiOk(null));
  }

  // Sessions
  const sesMatch = url.match(/^\/ocpi\/2\.2\.1\/receiver\/sessions\/(.+)$/);
  if (sesMatch) {
    const d = parseBody(body);
    const sessionId = sesMatch[1].split('/').pop();
    if (d) {
      ocpiSessions[sessionId] = { ...d, _id: sessionId, updated_at: new Date() };
      console.log(`[OCPI] Session ${sessionId}: ${d.status} ${d.kwh || 0} kWh`);
    }
    return res.end(ocpiOk(null));
  }

  // CDRs
  if (url.startsWith('/ocpi/2.2.1/receiver/cdrs')) {
    const d = parseBody(body);
    if (d) console.log(`[OCPI] CDR: ${d.id} — ${d.total_energy} kWh`);
    return res.end(ocpiOk(null));
  }

  // Commands receiver (async responses from ChargEye)
  if (url.startsWith('/ocpi/2.2.1/receiver/commands')) {
    const d = parseBody(body);
    if (d) {
      console.log(`[OCPI CMD] Modtaget:`, JSON.stringify(d).substring(0, 100));
      addAlarm('ChargEye', 'info', `OCPI kommando: ${d.result || d.command || 'OK'}`, d);
    }
    return res.end(ocpiOk(null));
  }

  // Tokens sender
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

// ─── WebSocket (OCPP) ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  handleProtocols: (protocols) => {
    const list = [...protocols];
    for (const p of list) { if (p.toLowerCase().startsWith('ocpp')) return p; }
    return list[0] || false;
  }
});

wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const chargerId = decodeURIComponent(urlParts[urlParts.length - 1]) || 'unknown';
  chargers[chargerId] = { ws, ocppVersion: ws.protocol, connectors: {}, model: null, vendor: null, firmware: null, activeTransaction: null, lastHeartbeat: null, config: {} };
  console.log(`\n🔌 [${chargerId}] Forbundet (${ws.protocol})`);
  addAlarm(chargerId, 'info', 'Lader forbundet');

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    const [msgType, msgId, ...rest] = msg;
    if (msgType === 2) handleOcppCall(chargerId, msgId, rest[0], rest[1] || {}, ws);
    else if (msgType === 3) {
      const p = pendingCmds[msgId];
      if (p) { clearTimeout(p.timeout); delete pendingCmds[msgId]; p.resolve(rest[0] || {}); }
    } else if (msgType === 4) {
      const p = pendingCmds[msgId];
      if (p) { clearTimeout(p.timeout); delete pendingCmds[msgId]; p.reject(new Error(`${rest[0]}: ${rest[1]}`)); }
      addAlarm(chargerId, 'error', `OCPP fejl: ${rest[1] || rest[0]}`, { msgId, error: rest });
    }
  });

  ws.on('close', (code) => {
    console.log(`\n🔴 [${chargerId}] Afbrudt (${code})`);
    addAlarm(chargerId, 'warning', `Lader afbrudt (kode ${code})`);
    Object.entries(pendingCmds).forEach(([mid, p]) => {
      if (chargers[chargerId]?.ws === ws) { clearTimeout(p.timeout); p.reject(new Error('Afbrudt')); delete pendingCmds[mid]; }
    });
    delete chargers[chargerId];
  });

  ws.on('error', (err) => { addAlarm(chargerId, 'error', `WS fejl: ${err.message}`); });
});

function handleOcppCall(chargerId, msgId, action, payload, ws) {
  const charger = chargers[chargerId];
  const is16 = !charger?.ocppVersion?.includes('2.0');
  const respond = (d) => ws.send(JSON.stringify([3, msgId, d]));
  console.log(`[${chargerId}] 📨 ${action}`);

  switch (action) {
    case 'BootNotification':
      if (is16) { charger.vendor=payload.chargePointVendor; charger.model=payload.chargePointModel; charger.firmware=payload.firmwareVersion; }
      else { charger.vendor=payload.chargingStation?.vendorName; charger.model=payload.chargingStation?.model; charger.firmware=payload.chargingStation?.firmwareVersion; }
      console.log(`   ${charger.vendor} ${charger.model} fw:${charger.firmware}`);
      respond({ currentTime: new Date().toISOString(), interval: 30, status: 'Accepted' });
      break;

    case 'Heartbeat':
      charger.lastHeartbeat = new Date().toISOString();
      respond({ currentTime: new Date().toISOString() });
      break;

    case 'StatusNotification':
      if (is16) {
        const { connectorId, status, errorCode, info, vendorErrorCode } = payload;
        if (!charger.connectors[1]) charger.connectors[1] = {};
        charger.connectors[1][connectorId] = status;
        console.log(`   ${statusIcon(status)} C${connectorId}: ${status}`);
        if (errorCode && errorCode !== 'NoError')
          addAlarm(chargerId, 'error', `C${connectorId} fejl: ${errorCode}`, { connectorId, status, errorCode, info, vendorErrorCode });
        if (status === 'Faulted')
          addAlarm(chargerId, 'error', `C${connectorId} i fejltilstand`, { connectorId });
      } else {
        const { evseId, connectorId, connectorStatus } = payload;
        if (!charger.connectors[evseId]) charger.connectors[evseId] = {};
        charger.connectors[evseId][connectorId || 0] = connectorStatus;
      }
      respond({});
      break;

    case 'Authorize': {
      const tag = is16 ? payload.idTag : payload.idToken?.idToken;
      const ok = AUTHORIZED_TAGS.includes(tag);
      if (!ok) addAlarm(chargerId, 'warning', `Afvist RFID: ${tag}`);
      respond(is16 ? { idTagInfo: { status: ok ? 'Accepted' : 'Invalid' } } : { idTokenInfo: { status: ok ? 'Accepted' : 'Invalid' } });
      break;
    }

    case 'StartTransaction': {
      const txId = Date.now();
      sessions[txId] = { id: txId, chargerId, connector: payload.connectorId, idTag: payload.idTag, meterStart: payload.meterStart || 0, start: new Date().toISOString(), kWh: 0, status: 'ACTIVE' };
      charger.activeTransaction = txId;
      console.log(`   ⚡ Session: ${txId}`);
      addAlarm(chargerId, 'info', `Session startet C${payload.connectorId}`, { txId });
      respond({ transactionId: txId, idTagInfo: { status: 'Accepted' } });
      break;
    }

    case 'StopTransaction': {
      const txId = payload.transactionId;
      if (sessions[txId]) {
        sessions[txId].kWh = ((payload.meterStop || 0) - (sessions[txId].meterStart || 0)) / 1000;
        sessions[txId].status = 'COMPLETED';
        sessions[txId].slut = new Date().toISOString();
        sessions[txId].reason = payload.reason;
        addAlarm(chargerId, 'info', `Session afsluttet: ${sessions[txId].kWh.toFixed(2)} kWh`, { txId, reason: payload.reason });
      }
      charger.activeTransaction = null;
      respond({ idTagInfo: { status: 'Accepted' } });
      break;
    }

    case 'MeterValues': {
      const txId = payload.transactionId;
      const kwh = extractKwh16(payload.meterValue);
      if (sessions[txId] && kwh !== null) {
        sessions[txId].kWh = kwh - (sessions[txId].meterStart || 0) / 1000;
        sessions[txId].lastMeter = kwh;
      }
      respond({});
      break;
    }

    case 'TransactionEvent': {
      const { eventType, transactionInfo, meterValue, evse } = payload;
      const txId = transactionInfo?.transactionId;
      if (eventType === 'Started') {
        sessions[txId] = { id: txId, chargerId, evse: evse?.id, start: new Date().toISOString(), kWh: 0, status: 'ACTIVE' };
        charger.activeTransaction = txId;
      } else if (eventType === 'Updated') {
        const kwh = extractKwh201(meterValue);
        if (sessions[txId] && kwh !== null) sessions[txId].kWh = kwh;
      } else if (eventType === 'Ended') {
        const kwh = extractKwh201(meterValue);
        if (sessions[txId]) { sessions[txId].kWh = kwh ?? sessions[txId].kWh; sessions[txId].status = 'COMPLETED'; sessions[txId].slut = new Date().toISOString(); }
        charger.activeTransaction = null;
      }
      respond({});
      break;
    }

    case 'DiagnosticsStatusNotification':
      addAlarm(chargerId, 'info', `Diagnostik: ${payload.status}`);
      respond({});
      break;

    case 'FirmwareStatusNotification':
      addAlarm(chargerId, payload.status === 'InstallationFailed' ? 'error' : 'info', `Firmware: ${payload.status}`);
      respond({});
      break;

    case 'DataTransfer':
      respond({ status: 'Accepted' });
      break;

    case 'SecurityEventNotification':
      addAlarm(chargerId, 'warning', `Security: ${payload.type}`, payload);
      respond({});
      break;

    default:
      respond({});
  }
}

function extractKwh16(meterValues) {
  if (!meterValues) return null;
  for (const mv of meterValues)
    for (const sv of (mv.sampledValue || []))
      if (!sv.measurand || sv.measurand === 'Energy.Active.Import.Register') {
        const v = parseFloat(sv.value); if (isNaN(v)) continue;
        return (sv.unit || 'Wh') === 'kWh' ? v : v / 1000;
      }
  return null;
}

function extractKwh201(meterValues) {
  if (!meterValues) return null;
  const values = Array.isArray(meterValues) ? meterValues : [meterValues];
  for (const mv of values)
    for (const sv of (mv.sampledValue || []))
      if (!sv.measurand || sv.measurand === 'Energy.Active.Import.Register') {
        const v = parseFloat(sv.value); if (isNaN(v)) continue;
        return (sv.unitOfMeasure?.unit || sv.unit || 'Wh') === 'kWh' ? v : v / 1000;
      }
  return null;
}

httpServer.listen(PORT, () => {
  console.log(`\n⚡ GodEnergi Charge Control v2.1 — port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/`);
  console.log(`   Status:    http://localhost:${PORT}/status`);
  console.log(`   TOKEN_A:   ${OCPI_TOKEN_A}\n`);
  if (chargeEye.token) { console.log('[OCPI] ChargEye token fra env — henter endpoints...'); fetchChargeEyeEndpoints().then(() => pullFromChargeEye()); }
  // Periodisk pull hvert 5. minut som backup
  setInterval(() => { if (chargeEye.token) pullFromChargeEye(); }, 5 * 60 * 1000);
});

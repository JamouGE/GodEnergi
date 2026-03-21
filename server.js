const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ─── State ────────────────────────────────────────────────────────────────────
const ocppChargers = {};
const ocppSessions = {};
const ocpiState = { locations: {}, sessions: {} };
const AUTHORIZED_TAGS = ['TAG001', 'TAG002', 'GODENERGY01', '04A1B2C3D4E5F6'];

// Set disse som environment variables i Railway
const OCPI_TOKEN_A = process.env.OCPI_TOKEN_A || 'godenergy-token-abc123';
const OCPI_TOKEN_B = process.env.OCPI_TOKEN_B || 'spirii-token-xyz789';

// ─── HTTP server ──────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url = req.url;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.end();

  // Dashboard
  if (url === '/' || url === '/dashboard') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'));
      res.setHeader('Content-Type', 'text/html');
      return res.end(html);
    } catch {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<h1>dashboard.html mangler — læg den i samme mappe</h1>');
    }
  }

  // Status API
  if (url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    const ladere = Object.entries(ocppChargers).map(([id, c]) => ({
      id, online: true, model: c.model || 'Ukendt', vendor: c.vendor || 'Ukendt',
      firmware: c.firmware || 'Ukendt', connectors: c.connectors || {},
      aktiv_transaktion: c.activeTransaction || null, ocppVersion: c.ocppVersion,
    }));
    const ocpiLokationer = Object.values(ocpiState.locations);
    return res.end(JSON.stringify({
      ocpp: { ladere, sessioner: Object.values(ocppSessions) },
      ocpi: { lokationer: ocpiLokationer, sessioner: Object.values(ocpiState.sessions) },
    }, null, 2));
  }

  // Remote start
  if (url.startsWith('/start/')) {
    res.setHeader('Content-Type', 'application/json');
    const parts = url.split('/');
    const chargerId = parts[2];
    const connectorId = parseInt(parts[3]) || 1;
    const charger = ocppChargers[chargerId];
    if (!charger) return res.end(JSON.stringify({ error: 'Lader ikke fundet' }));
    sendToCharger(chargerId, 'RequestStartTransaction', {
      remoteStartId: Date.now(),
      idToken: { idToken: 'GODENERGY01', type: 'ISO14443' },
      evseId: connectorId,
    });
    return res.end(JSON.stringify({ besked: `Start sendt til ${chargerId}` }));
  }

  // Remote stop
  if (url.startsWith('/stop/')) {
    res.setHeader('Content-Type', 'application/json');
    const chargerId = url.split('/')[2];
    const charger = ocppChargers[chargerId];
    if (!charger || !charger.activeTransaction) return res.end(JSON.stringify({ error: 'Ingen aktiv session' }));
    sendToCharger(chargerId, 'RequestStopTransaction', { transactionId: charger.activeTransaction });
    return res.end(JSON.stringify({ besked: `Stop sendt til ${chargerId}` }));
  }

  // OCPI endpoints
  if (url.startsWith('/ocpi')) {
    const header = req.headers['authorization'] || '';
    const token = header.replace('Token ', '').replace('Bearer ', '').trim();
    const b64 = Buffer.from(OCPI_TOKEN_A).toString('base64');
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

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ service: 'GodEnergi Charge Control', version: '1.0.0' }));
});

// ─── OCPI ─────────────────────────────────────────────────────────────────────
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
      ]
    }));

  if (url === '/ocpi/2.2.1/credentials' && (method === 'POST' || method === 'PUT' || method === 'GET'))
    return res.end(ocpiOk({
      token: OCPI_TOKEN_B,
      url: `${base}/ocpi/versions`,
      roles: [{ role: 'EMSP', party_id: 'GDE', country_code: 'DK' }]
    }));

  const locMatch = url.match(/^\/ocpi\/2\.2\.1\/receiver\/locations\/(.+?)(?:\/evses\/([^\/]+))?$/);
  if (locMatch) {
    const [, locationId, evseUid] = locMatch;
    try {
      const d = JSON.parse(body);
      if (evseUid) {
        const loc = ocpiState.locations[locationId];
        if (loc?.evses) { const evse = loc.evses.find(e => e.uid === evseUid); if (evse) Object.assign(evse, d); }
        console.log(`[OCPI] EVSE ${evseUid} → ${d.status || '?'}`);
      } else {
        ocpiState.locations[locationId] = method === 'PUT'
          ? { ...d, updated_at: new Date() }
          : { ...ocpiState.locations[locationId], ...d, updated_at: new Date() };
        console.log(`[OCPI] Location ${locationId}: ${d.name || '?'}`);
      }
    } catch {}
    return res.end(ocpiOk(null));
  }

  const sesMatch = url.match(/^\/ocpi\/2\.2\.1\/receiver\/sessions\/([^\/]+)/);
  if (sesMatch) {
    try {
      const d = JSON.parse(body);
      ocpiState.sessions[sesMatch[1]] = { ...d, updated_at: new Date() };
      console.log(`[OCPI] Session ${sesMatch[1]}: ${d.status} ${d.kwh || 0} kWh`);
    } catch {}
    return res.end(ocpiOk(null));
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ status_code: 2000, status_message: 'Not found', timestamp: new Date() }));
}

// ─── OCPP WebSocket ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  handleProtocols: (protocols) => {
    const list = [...protocols];
    console.log(`[OCPP] Protokol:`, list);
    for (const p of list) { if (p.toLowerCase().startsWith('ocpp')) return p; }
    return list[0] || false;
  }
});

httpServer.on('upgrade', (req) => {
  console.log(`[OCPP UPGRADE] ${req.url} — ${req.headers['sec-websocket-protocol'] || 'ingen'}`);
});

wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const chargerId = urlParts[urlParts.length - 1] || 'unknown';
  ocppChargers[chargerId] = { ws, connectors: {}, model: null, vendor: null, firmware: null, activeTransaction: null, ocppVersion: ws.protocol };
  console.log(`\n🔌 [${chargerId}] Forbundet (${ws.protocol}) — ${new Date().toLocaleTimeString()}`);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const [msgType, msgId, ...rest] = msg;
    if (msgType === 2) handleOcppCall(chargerId, msgId, rest[0], rest[1], ws);
    else if (msgType === 3) console.log(`[${chargerId}] ✅`, JSON.stringify(rest[0]).substring(0, 80));
    else if (msgType === 4) console.log(`[${chargerId}] ❌`, rest);
  });

  ws.on('close', (code) => { console.log(`\n🔴 [${chargerId}] Afbrudt (${code})`); delete ocppChargers[chargerId]; });
  ws.on('error', (err) => console.log(`[${chargerId}] Fejl: ${err.message}`));
});

function handleOcppCall(chargerId, msgId, action, payload, ws) {
  const charger = ocppChargers[chargerId];
  const is16 = charger?.ocppVersion === 'ocpp1.6' || charger?.ocppVersion === 'ocpp1.6j';
  console.log(`[${chargerId}] 📨 ${action}`);

  switch (action) {
    case 'BootNotification':
      charger.vendor = is16 ? payload.chargePointVendor : payload.chargingStation?.vendorName;
      charger.model = is16 ? payload.chargePointModel : payload.chargingStation?.model;
      charger.firmware = is16 ? payload.firmwareVersion : payload.chargingStation?.firmwareVersion;
      console.log(`   ${charger.vendor} ${charger.model} fw:${charger.firmware}`);
      ocppRes(ws, msgId, { currentTime: new Date().toISOString(), interval: 30, status: 'Accepted' });
      break;

    case 'Heartbeat':
      ocppRes(ws, msgId, { currentTime: new Date().toISOString() });
      break;

    case 'StatusNotification':
      if (is16) {
        const cid = payload.connectorId || 0;
        if (!charger.connectors[1]) charger.connectors[1] = {};
        charger.connectors[1][cid] = payload.status;
        console.log(`   ${statusIcon(payload.status)} C${cid}: ${payload.status}`);
      } else {
        if (!charger.connectors[payload.evseId]) charger.connectors[payload.evseId] = {};
        charger.connectors[payload.evseId][payload.connectorId || 0] = payload.connectorStatus;
        console.log(`   ${statusIcon(payload.connectorStatus)} EVSE ${payload.evseId}: ${payload.connectorStatus}`);
      }
      ocppRes(ws, msgId, {});
      break;

    case 'Authorize': {
      const tag = is16 ? payload.idTag : payload.idToken?.idToken;
      const ok = AUTHORIZED_TAGS.includes(tag);
      console.log(`   🔑 ${tag} → ${ok ? '✅' : '❌'}`);
      ocppRes(ws, msgId, is16
        ? { idTagInfo: { status: ok ? 'Accepted' : 'Invalid' } }
        : { idTokenInfo: { status: ok ? 'Accepted' : 'Invalid' } });
      break;
    }

    case 'StartTransaction': {
      const txId = Date.now();
      ocppSessions[txId] = { id: txId, chargerId, evse: payload.connectorId, start: new Date().toISOString(), kWh: 0, status: 'ACTIVE' };
      charger.activeTransaction = txId;
      console.log(`   ⚡ Session: ${txId}`);
      ocppRes(ws, msgId, { transactionId: txId, idTagInfo: { status: 'Accepted' } });
      break;
    }

    case 'StopTransaction': {
      const txId = payload.transactionId;
      if (ocppSessions[txId]) {
        ocppSessions[txId].kWh = payload.meterStop ? payload.meterStop / 1000 : ocppSessions[txId].kWh;
        ocppSessions[txId].status = 'COMPLETED';
        ocppSessions[txId].slut = new Date().toISOString();
      }
      charger.activeTransaction = null;
      console.log(`   🏁 ${ocppSessions[txId]?.kWh} kWh`);
      ocppRes(ws, msgId, { idTagInfo: { status: 'Accepted' } });
      break;
    }

    case 'MeterValues': {
      const txId = payload.transactionId;
      const kwh = extractKwh16(payload.meterValue);
      if (ocppSessions[txId] && kwh !== null) { ocppSessions[txId].kWh = kwh; console.log(`   📊 ${kwh} kWh`); }
      ocppRes(ws, msgId, {});
      break;
    }

    case 'TransactionEvent': {
      const { eventType, transactionInfo, meterValue, evse } = payload;
      const txId = transactionInfo?.transactionId;
      if (eventType === 'Started') {
        ocppSessions[txId] = { id: txId, chargerId, evse: evse?.id, start: new Date().toISOString(), kWh: 0, status: 'ACTIVE' };
        charger.activeTransaction = txId;
        console.log(`   ⚡ ${txId}`);
      } else if (eventType === 'Updated') {
        const kwh = extractKwh201(meterValue);
        if (ocppSessions[txId] && kwh !== null) { ocppSessions[txId].kWh = kwh; console.log(`   📊 ${kwh} kWh`); }
      } else if (eventType === 'Ended') {
        const kwh = extractKwh201(meterValue);
        if (ocppSessions[txId]) { ocppSessions[txId].kWh = kwh ?? ocppSessions[txId].kWh; ocppSessions[txId].status = 'COMPLETED'; ocppSessions[txId].slut = new Date().toISOString(); }
        charger.activeTransaction = null;
        console.log(`   🏁 ${ocppSessions[txId]?.kWh} kWh`);
      }
      ocppRes(ws, msgId, {});
      break;
    }

    default:
      ocppRes(ws, msgId, {});
  }
}

function sendToCharger(chargerId, action, payload) {
  const c = ocppChargers[chargerId];
  if (!c || c.ws.readyState !== 1) return console.log(`[${chargerId}] Ikke forbundet`);
  c.ws.send(JSON.stringify([2, `cmd-${Date.now()}`, action, payload]));
  console.log(`[${chargerId}] 📤 ${action}`);
}

function ocppRes(ws, msgId, payload) { ws.send(JSON.stringify([3, msgId, payload])); }

function extractKwh16(meterValues) {
  if (!meterValues) return null;
  for (const mv of meterValues)
    for (const sv of (mv.sampledValue || []))
      if (!sv.measurand || sv.measurand === 'Energy.Active.Import.Register') {
        const val = parseFloat(sv.value);
        return (sv.unit || 'Wh') === 'kWh' ? val : val / 1000;
      }
  return null;
}

function extractKwh201(meterValues) {
  if (!meterValues) return null;
  const values = Array.isArray(meterValues) ? meterValues : [meterValues];
  for (const mv of values)
    for (const sv of (mv.sampledValue || []))
      if (!sv.measurand || sv.measurand === 'Energy.Active.Import.Register') {
        const val = parseFloat(sv.value);
        return (sv.unitOfMeasure?.unit || sv.unit || 'Wh') === 'kWh' ? val : val / 1000;
      }
  return null;
}

function statusIcon(s) {
  return { Available: '🟢', Charging: '⚡', Occupied: '⚡', Preparing: '🟡', Finishing: '🟡', Unavailable: '🔴', Faulted: '❌' }[s] || '⚪';
}

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n⚡ GodEnergi Charge Control — port ${PORT}`);
  console.log(`   Dashboard:  http://localhost:${PORT}/`);
  console.log(`   Status:     http://localhost:${PORT}/status`);
  console.log(`   OCPI:       http://localhost:${PORT}/ocpi/versions`);
  console.log(`   OCPP WS:    ws://localhost:${PORT}/<CHARGER_ID>`);
  console.log(`   TOKEN_A:    ${OCPI_TOKEN_A}\n`);
});

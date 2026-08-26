// ============================================================
// New CRM (O2D Task Tracker) — standalone Node/Express server
// Same pattern as CEO Dashboard: Express + googleapis + service account
// Local dev first — deploy to Render later.
//
// REAL STRUCTURE (confirmed from the live sheets, not a single combined tab):
//   NEW FMS        — one row per ORDER    — 2 steps: Confirm Order, Coordinate Delivery
//   NEW Split_FMS  — one row per INVOICE  — 5 steps: Dispatch Intimation, Confirm Product
//                    Delivery, Next Follow-up For Payment, Part/Full Payment Recd, Payment Complete
//   OLD FMS        — one row per ORDER    — 4 steps: Acknowledgement, Stock Checking,
//                    Update Order Status, Dispatch (Dispatch is auto-filled by its own
//                    separate script — never touched here)
//   OLD Split_FMS  — one row per INVOICE  — Dispatch Intimation, LR Details, GRN/POD,
//                    Send Feedback Form, Payment Follow Up 1-3 (only Dispatch Intimation
//                    and LR Details are cross-synced — everything else is old-only)
//
// CS Orders and Dispatch_Ledger sync into BOTH new and old sheets (same 22 Aug 2026
// cutoff on both sides — old sheets already have their pre-22-Aug history pasted in).
//
// CROSS-SYNC (4 steps, order-level matched by Order ID, invoice-level matched by
// Order ID + Invoice No): completing a step on either side (new or old) writes the
// Actual date to the matching step on the other side.
//   Confirm Order        (new FMS)       <-> Acknowledgement of Order (old FMS)
//   Coordinate Delivery   (new FMS)       <-> Update Order Status      (old FMS)
//   Dispatch Intimation   (new Split_FMS) <-> Dispatch Intimation      (old Split_FMS)
//   Confirm Product Delivery & Receipt... (new Split_FMS) <-> LR Details (old Split_FMS)
// ============================================================

const express = require('express');
const { google } = require('googleapis');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Sheet IDs ──────────────────────────────────────────────────────────────
const CS_ORDERS_ID  = '1I3dyyipJ0ZGYGJ6Bd4SFwewSH3bZWZaoGd70t4TX5Nw';
const CS_TAB         = 'CS Orders';
const DISPATCH_ID   = '1I3dyyipJ0ZGYGJ6Bd4SFwewSH3bZWZaoGd70t4TX5Nw'; // same spreadsheet as CS Orders
const DISPATCH_TAB   = 'Dispatch_Ledger';

const NEW_ID   = '1WOLL5u8n4m0tgsMa0A0LMAxdq59p1kVGK8H4esp_1gU'; // CRM_TRACKING_FMS
const NEW_FMS_TAB   = 'FMS';
const NEW_SPLIT_TAB = 'Split_FMS';

const OLD_ID   = '13-W9nT1m8eRQTHck5Se_QWoe4-clu-BW4rr7AIbhjNE'; // OLD_FMS_New_Order_To_Delivery
const OLD_FMS_TAB   = 'FMS';
const OLD_SPLIT_TAB = 'Split_FMS';

const DATA_START_ROW = 7; // all four sheets: row 1-5=meta, row 6=headers, row 7+=data
const SYNC_CUTOFF = new Date(2026, 7, 22, 0, 0, 0); // 22 August 2026 — same on old and new

// ── Base (non-stage) columns — 1-based, confirmed via live read ─────────────
// FMS-type sheets (one row per order): Timestamp..Lead Time
const FMS_BASE   = { TIMESTAMP:1, ORDER_ID:2, CUST_NAME:3, CONTACT:4, PHONE:5, PAY_TERMS:6, LEAD_TIME:7 };
// Split_FMS-type sheets (one row per invoice): Timestamp..Qty
const SPLIT_BASE = { TIMESTAMP:1, ORDER_ID:2, CUST_NAME:3, DEL_STATUS:4, PAY_TERMS:5, INVOICE_NO:6, INVOICE_AMT:7, QTY:8 };

// CS Orders columns (0-based array index, from getValues())
const CS = { ORDER_ID:0, TIMESTAMP:1, CUST_NAME:2, CONTACT:5, PHONE:6, LEAD_TIME:9, PAY_TERMS:10 };

// ── Stage column maps ────────────────────────────────────────────────────────
// NEW FMS (2 steps)
const NEW_FMS_STAGES = {
  confirmOrder:       { plan:11, actual:12, status:13, delay:14, doer:15, link:16 }, // O2D1
  coordinateDelivery: { plan:17, actual:18, status:19, delay:20, doer:21 },          // O2D2
};
// NEW Split_FMS (5 steps)
const NEW_SPLIT_STAGES = {
  dispatchIntimation:   { plan:10, actual:11, status:12, delay:13, doer:14 },                          // O2D3
  confirmDelivery:      { plan:15, actual:16, status:17, delay:18, doer:19 },                          // O2D4
  paymentFollowUp1:     { plan:20, actual:21, status:22, delay:23, payStatus:24, doer:25 },             // O2D5
  partFullPayment:      { plan:26, actual:27, status:28, delay:29, doer:30, payStatus:31 },             // O2D6
  paymentComplete:      { plan:32, actual:33, status:34, delay:35, doer:36, payStatus:37 },             // O2D7
};
// OLD FMS (4 steps — Dispatch is auto-filled elsewhere, not part of any sync here)
const OLD_FMS_STAGES = {
  acknowledgement:   { plan:11, actual:12, status:13, delay:14, doer:15, link:16 }, // O2D1
  stockChecking:     { plan:17, actual:18, status:19, delay:20, doer:21 },          // O2D2 (old-only)
  updateOrderStatus: { plan:22, actual:23, status:24, delay:25, doer:26 },          // O2D3
};
// OLD Split_FMS (only the 2 cross-synced steps modeled here — GRN/POD, Feedback,
// Payment Follow Ups 1-3 exist in the sheet but are intentionally old-only, unmapped)
const OLD_SPLIT_STAGES = {
  dispatchIntimation: { plan:16, actual:17, status:18, delay:19, doer:20 }, // O2D6
  lrDetails:          { plan:21, actual:22, status:23, delay:24, doer:25 }, // O2D7
};

// ── Cross-sync map: new step key -> old step key + match granularity ────────
const CROSS_SYNC = [
  { newSheet:'fms',   newKey:'confirmOrder',       oldSheet:'fms',   oldKey:'acknowledgement',   matchInvoice:false, label:'Confirm Order / Acknowledgement of Order' },
  { newSheet:'fms',   newKey:'coordinateDelivery', oldSheet:'fms',   oldKey:'updateOrderStatus', matchInvoice:false, label:'Coordinate Delivery / Update Order Status' },
  { newSheet:'split', newKey:'dispatchIntimation', oldSheet:'split', oldKey:'dispatchIntimation',matchInvoice:true,  label:'Dispatch Intimation' },
  { newSheet:'split', newKey:'confirmDelivery',    oldSheet:'split', oldKey:'lrDetails',         matchInvoice:true,  label:'Confirm Product Delivery / LR Details' },
];

// ── Google Auth (same pattern as CEO Dashboard — needs Editor access) ───────
const authConfig = process.env.GOOGLE_CREDENTIALS
  ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS), scopes: ['https://www.googleapis.com/auth/spreadsheets'] }
  : { keyFile: path.join(__dirname, 'credentials.json'),        scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
const auth = new google.auth.GoogleAuth(authConfig);

async function getSheets() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// ── 5-minute in-memory cache (same pattern as CEO Dashboard) ────────────────
const _cache = {};
const CACHE_TTL = 5 * 60 * 1000;

async function readSheet(sheets, spreadsheetId, range) {
  const key = `${spreadsheetId}::${range}`;
  const now = Date.now();
  if (_cache[key] && now - _cache[key].ts < CACHE_TTL) return _cache[key].data;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId, range,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const data = res.data.values || [];
    _cache[key] = { data, ts: now };
    return data;
  } catch (e) {
    console.error(`[error] ${range}:`, e.message);
    return [];
  }
}

// Bypasses the cache — always use this right before a write, so row lookups
// are never based on stale data.
async function readRaw(sheets, spreadsheetId, range) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId, range,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    return res.data.values || [];
  } catch (e) {
    console.error(`[readRaw error] ${range}:`, e.message);
    return [];
  }
}

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function formatDT(d) {
  if (!d) return '';
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth()+1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

// Parses the sheet's "dd/MM/yyyy HH:mm:ss" text back into a Date.
function parseDMY(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh='0', mi='0', ss='0'] = m;
  return new Date(+yyyy, +mm-1, +dd, +hh, +mi, +ss);
}

function calcDelay(planned, actual) {
  if (!planned || !actual) return '';
  const ms = actual - planned;
  if (ms <= 0) return '';
  const h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000);
  return (h>=24 ? Math.floor(h/24)+'d '+(h%24)+'h ' : h+'h ') + m+'m';
}

// Finds ONE row (absolute sheet row number) matching orderId (+ invoiceNo if invoiceCol given).
function findRow(rows, orderCol, invoiceCol, orderId, invoiceNo) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    if (String(r[orderCol-1]||'').trim() !== String(orderId||'').trim()) continue;
    if (invoiceCol && String(r[invoiceCol-1]||'').trim() !== String(invoiceNo||'').trim()) continue;
    return DATA_START_ROW + i;
  }
  return -1;
}

async function writeCells(sheets, spreadsheetId, tab, rowNum, colValueMap) {
  const data = Object.entries(colValueMap).map(([col, value]) => ({
    range: `${tab}!${colLetter(+col)}${rowNum}`, values: [[value]],
  }));
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

// Writes cells across MANY rows in a single API call (avoids the per-minute
// write-quota limit that one-call-per-row blows through on bulk syncs).
async function writeCellsBatch(sheets, spreadsheetId, tab, updatesByRow) {
  const data = [];
  for (const [rowNum, colValueMap] of Object.entries(updatesByRow)) {
    for (const [col, value] of Object.entries(colValueMap)) {
      data.push({ range: `${tab}!${colLetter(+col)}${rowNum}`, values: [[value]] });
    }
  }
  if (!data.length) return;
  const CHUNK = 900; // Sheets API caps batchUpdate at 1000 ranges per call
  for (let i = 0; i < data.length; i += CHUNK) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: data.slice(i, i + CHUNK) },
    });
  }
}

// ================================================================
// CS ORDERS -> FMS sync (both new and old, same cutoff)
// ================================================================
async function syncCSToFMS(spreadsheetId, tab, label) {
  const sheets = await getSheets();
  const fmsRows = await readRaw(sheets, spreadsheetId, `${tab}!A${DATA_START_ROW}:G`);
  const csRows  = await readRaw(sheets, CS_ORDERS_ID, `${CS_TAB}!A1:L`);

  const existingRows = {}; // orderId -> row number
  fmsRows.forEach((r, i) => { const id = String(r[FMS_BASE.ORDER_ID-1]||'').trim(); if (id) existingRows[id] = DATA_START_ROW + i; });

  const cellUpdates = {};
  const appendRows = [];
  const seen = new Set();
  let added = 0, updated = 0;

  csRows.slice(1).forEach(r => {
    const orderId = String(r[CS.ORDER_ID]||'').trim();
    if (!orderId || seen.has(orderId)) return;
    seen.add(orderId);

    const custName = r[CS.CUST_NAME]||'', contact = r[CS.CONTACT]||'', phone = r[CS.PHONE]||'';
    const payTerms = r[CS.PAY_TERMS]||'', leadTime = parseInt(r[CS.LEAD_TIME]||1);

    if (existingRows[orderId]) {
      cellUpdates[existingRows[orderId]] = {
        [FMS_BASE.CUST_NAME]: custName, [FMS_BASE.CONTACT]: contact, [FMS_BASE.PHONE]: phone,
        [FMS_BASE.PAY_TERMS]: payTerms, [FMS_BASE.LEAD_TIME]: leadTime,
      };
      updated++;
      return;
    }

    // Sheet timestamps are DD/MM/YYYY text — parseDMY(), NOT new Date(string) which
    // assumes MM/DD/YYYY and silently produces Invalid Date for day>12 (that bug let
    // unparseable rows slip past the cutoff check entirely — NaN < cutoff is false).
    const ts = parseDMY(r[CS.TIMESTAMP]);
    if (!ts || isNaN(ts.getTime()) || ts < SYNC_CUTOFF) return; // skip unparseable or pre-cutoff rows

    appendRows.push([formatDT(ts), orderId, custName, contact, phone, payTerms, leadTime]);
    added++;
  });

  await writeCellsBatch(sheets, spreadsheetId, tab, cellUpdates);
  if (appendRows.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: `${tab}!A${DATA_START_ROW}`,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appendRows },
    });
  }
  console.log(`[syncCSToFMS:${label}] added ${added}, updated ${updated}`);
  return { added, updated };
}

// ================================================================
// DISPATCH_LEDGER -> Split_FMS sync (both new and old, same cutoff)
// ================================================================
async function syncDispatchToSplitFMS(spreadsheetId, tab, label) {
  const sheets = await getSheets();
  const dlRows = await readRaw(sheets, DISPATCH_ID, `${DISPATCH_TAB}!A1:Z`);
  if (!dlRows.length) return { added: 0, updated: 0, error: 'Dispatch_Ledger empty/unreadable' };

  const headers = dlRows[0].map(h => String(h).toLowerCase().trim());
  const ci = name => headers.indexOf(name);
  const iTS = ci('timestamp'), iOID = ci('order id'), iCN = ci('customer name');
  const iDS = ci('product dispatch status') >= 0 ? ci('product dispatch status') : ci('delivery status');
  const iPT = ci('payment terms'), iIN = ci('invoice no');
  const iIA = ci('invoice amt'); // optional, -1 if absent
  const iQT = ci('dispatched qty') >= 0 ? ci('dispatched qty') : ci('qty');

  const missing = [];
  if (iTS<0) missing.push('Timestamp'); if (iOID<0) missing.push('Order ID');
  if (iCN<0) missing.push('Customer Name'); if (iDS<0) missing.push('Dispatch/Delivery Status');
  if (iPT<0) missing.push('Payment Terms'); if (iIN<0) missing.push('Invoice No'); if (iQT<0) missing.push('Qty');
  if (missing.length) return { added: 0, updated: 0, error: `Missing Dispatch_Ledger columns: ${missing.join(', ')}` };

  const splitRows = await readRaw(sheets, spreadsheetId, `${tab}!A${DATA_START_ROW}:H`);
  const existingRows = {}; // invoiceNo -> row number
  splitRows.forEach((r, i) => { const inv = String(r[SPLIT_BASE.INVOICE_NO-1]||'').trim(); if (inv) existingRows[inv] = DATA_START_ROW + i; });

  const cellUpdates = {};
  const appendRows = [];
  const seen = new Set();
  let added = 0, updated = 0;

  dlRows.slice(1).forEach(r => {
    const invoiceNo = String(r[iIN]||'').trim();
    if (!invoiceNo || seen.has(invoiceNo)) return;
    seen.add(invoiceNo);

    const custName = String(r[iCN]||'').trim(), delStatus = String(r[iDS]||'').trim();
    const payTerms = String(r[iPT]||'').trim(), invoiceAmt = iIA >= 0 ? (r[iIA]||'') : '', qty = r[iQT]||'';

    if (existingRows[invoiceNo]) {
      cellUpdates[existingRows[invoiceNo]] = {
        [SPLIT_BASE.CUST_NAME]: custName, [SPLIT_BASE.DEL_STATUS]: delStatus, [SPLIT_BASE.PAY_TERMS]: payTerms,
        [SPLIT_BASE.INVOICE_AMT]: invoiceAmt, [SPLIT_BASE.QTY]: qty,
      };
      updated++;
      return;
    }

    if (delStatus === 'Cancelled' || delStatus === 'Balance Cancelled') return;
    // Same DD/MM/YYYY fix as syncCSToFMS — parseDMY(), not new Date(string).
    const ts = parseDMY(r[iTS]);
    if (!ts || isNaN(ts.getTime()) || ts < SYNC_CUTOFF) return;

    appendRows.push([formatDT(ts), String(r[iOID]||'').trim(), custName, delStatus, payTerms, invoiceNo, invoiceAmt, qty]);
    added++;
  });

  await writeCellsBatch(sheets, spreadsheetId, tab, cellUpdates);
  if (appendRows.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: `${tab}!A${DATA_START_ROW}`,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appendRows },
    });
  }
  console.log(`[syncDispatchToSplitFMS:${label}] added ${added}, updated ${updated}`);
  return { added, updated };
}

// ── Combined sync — call this on a schedule or via /api/sync-now ────────────
async function syncAll() {
  const results = {};
  results.newFMS   = await syncCSToFMS(NEW_ID, NEW_FMS_TAB, 'new-fms');
  results.oldFMS    = await syncCSToFMS(OLD_ID, OLD_FMS_TAB, 'old-fms');
  results.newSplit = await syncDispatchToSplitFMS(NEW_ID, NEW_SPLIT_TAB, 'new-split');
  results.oldSplit  = await syncDispatchToSplitFMS(OLD_ID, OLD_SPLIT_TAB, 'old-split');
  return results;
}

// ================================================================
// CROSS-SYNC — completing a step on either side writes the Actual date
// to the matching step on the other side (4 mapped steps only).
// ================================================================
function sheetInfo(which, side) {
  // which: 'fms' | 'split', side: 'new' | 'old'
  if (which === 'fms') {
    return side === 'new'
      ? { id: NEW_ID, tab: NEW_FMS_TAB, base: FMS_BASE, stages: NEW_FMS_STAGES }
      : { id: OLD_ID, tab: OLD_FMS_TAB, base: FMS_BASE, stages: OLD_FMS_STAGES };
  }
  return side === 'new'
    ? { id: NEW_ID, tab: NEW_SPLIT_TAB, base: SPLIT_BASE, stages: NEW_SPLIT_STAGES }
    : { id: OLD_ID, tab: OLD_SPLIT_TAB, base: SPLIT_BASE, stages: OLD_SPLIT_STAGES };
}

// Writes the Actual date for one mapped step into the OTHER side's matching row.
// direction: 'new-to-old' or 'old-to-new'. Returns {synced:boolean, reason?}.
async function crossSyncStage(sheets, mapping, orderId, invoiceNo, actual, direction, doer) {
  const fromSide = direction === 'new-to-old' ? 'new' : 'old';
  const toSide   = direction === 'new-to-old' ? 'old' : 'new';
  const fromKey  = direction === 'new-to-old' ? mapping.newKey : mapping.oldKey;
  const toKey    = direction === 'new-to-old' ? mapping.oldKey : mapping.newKey;
  const which    = mapping.newSheet; // 'fms' or 'split' — same shape on both sides

  const to = sheetInfo(which, toSide);
  const toCols = to.stages[toKey];
  if (!toCols) return { synced: false, reason: 'no matching stage on target side' };

  const rows = await readRaw(sheets, to.id, `${to.tab}!A${DATA_START_ROW}:${colLetter(50)}`);
  const invoiceCol = mapping.matchInvoice ? to.base.INVOICE_NO : null;
  const rowNum = findRow(rows, to.base.ORDER_ID, invoiceCol, orderId, invoiceNo);
  if (rowNum === -1) return { synced: false, reason: `row not found on ${toSide} side` };

  const updates = { [toCols.actual]: formatDT(actual) };
  if (toCols.doer && doer) updates[toCols.doer] = doer;
  await writeCells(sheets, to.id, to.tab, rowNum, updates);
  return { synced: true };
}

// ── API: complete a stage, writing to the primary side + cross-syncing ──────
// body: { side:'new'|'old', which:'fms'|'split', stageKey, orderId, invoiceNo?,
//         actualTime?, doer?, status?, payStatus? }
app.post('/api/complete-stage', async (req, res) => {
  try {
    const { side, which, stageKey, orderId, invoiceNo, actualTime, doer, status, payStatus } = req.body || {};
    if (!side || !which || !stageKey || !orderId) return res.json({ success:false, error:'side, which, stageKey, orderId required' });

    const sheets = await getSheets();
    const actual = actualTime ? new Date(actualTime) : new Date();
    const info = sheetInfo(which, side);
    const cols = info.stages[stageKey];
    if (!cols) return res.json({ success:false, error:`Unknown stage "${stageKey}" for ${side}/${which}` });

    const rows = await readRaw(sheets, info.id, `${info.tab}!A${DATA_START_ROW}:${colLetter(50)}`);
    const invoiceCol = which === 'split' ? info.base.INVOICE_NO : null;
    const rowNum = findRow(rows, info.base.ORDER_ID, invoiceCol, orderId, invoiceNo);
    if (rowNum === -1) return res.json({ success:false, error:`Row not found for ${orderId}${invoiceNo?'/'+invoiceNo:''}` });

    const plannedRaw = rows[rowNum - DATA_START_ROW][cols.plan - 1];
    const planned = parseDMY(plannedRaw);
    const delay = calcDelay(planned, actual);

    const updates = { [cols.actual]: formatDT(actual) };
    if (cols.status && status)       updates[cols.status] = status;
    if (cols.doer && doer)           updates[cols.doer] = doer;
    if (cols.payStatus && payStatus) updates[cols.payStatus] = payStatus;
    await writeCells(sheets, info.id, info.tab, rowNum, updates);

    // Cross-sync if this stage is one of the 4 mapped steps
    const mapping = CROSS_SYNC.find(m => m.newSheet === which && (side === 'new' ? m.newKey === stageKey : m.oldKey === stageKey));
    let cross = { synced: false, reason: 'not a cross-synced stage' };
    if (mapping) {
      cross = await crossSyncStage(sheets, mapping, orderId, invoiceNo, actual, side === 'new' ? 'new-to-old' : 'old-to-new', doer);
    }

    res.json({ success:true, delay, cross });
  } catch (e) {
    res.json({ success:false, error: e.message });
  }
});

// ================================================================
// STAGE META (What / Who / How / When) — read from rows 2-5 of each sheet,
// which hold that documentation per stage group (row 1 has the O2D-n label,
// row 6 has the real data headers, row 7+ is data). Some cells have a plain-text
// "label : https://..." URL baked in (not a real hyperlink) — linkifyMeta() on
// the frontend turns that into a clickable link, text kept alongside it.
// The label isn't always in the stage's first (plan) column — on a couple of
// blocks it's one column over — so this scans the stage's WHOLE column span
// (min..max of all its defined columns) and takes the first non-empty cell
// per row, which safely covers every case seen in the live sheets.
// ================================================================
function stageSpan(cols) {
  const vals = Object.values(cols);
  return [Math.min(...vals), Math.max(...vals)];
}

async function getStageMeta(sheets, spreadsheetId, tab, stageMap) {
  const metaRows = await readSheet(sheets, spreadsheetId, `${tab}!A2:${colLetter(50)}5`); // rows 2-5
  const [whatRow, whoRow, howRow, whenRow] = metaRows;
  const firstNonEmpty = (row, min, max) => {
    if (!row) return '';
    for (let c = min; c <= max; c++) { const v = row[c - 1]; if (v) return String(v).trim(); }
    return '';
  };
  const meta = {};
  for (const [key, cols] of Object.entries(stageMap)) {
    const [min, max] = stageSpan(cols);
    meta[key] = {
      what: firstNonEmpty(whatRow, min, max),
      who:  firstNonEmpty(whoRow, min, max),
      how:  firstNonEmpty(howRow, min, max),
      when: firstNonEmpty(whenRow, min, max),
    };
  }
  return meta;
}

// ── API: list orders from a given sheet (new/old, fms/split) ────────────────
app.get('/api/orders', async (req, res) => {
  try {
    const side = req.query.side === 'old' ? 'old' : 'new';
    const which = req.query.which === 'split' ? 'split' : 'fms';
    const sheets = await getSheets();
    const info = sheetInfo(which, side);
    const rows = await readSheet(sheets, info.id, `${info.tab}!A${DATA_START_ROW}:${colLetter(50)}`);
    const meta = await getStageMeta(sheets, info.id, info.tab, info.stages);

    const orders = rows
      .map((r, i) => ({ r, rowIdx: DATA_START_ROW + i }))
      .filter(x => x.r[info.base.ORDER_ID-1])
      .map(({ r, rowIdx }) => {
        const out = {
          rowIdx,
          orderId:  String(r[info.base.ORDER_ID-1]||'').trim(),
          custName: r[info.base.CUST_NAME-1]||'',
        };
        if (which === 'fms') {
          out.contact = r[info.base.CONTACT-1]||''; out.phone = String(r[info.base.PHONE-1]||'');
          out.payTerms = r[info.base.PAY_TERMS-1]||''; out.leadTime = r[info.base.LEAD_TIME-1]||'';
        } else {
          out.invoiceNo = String(r[info.base.INVOICE_NO-1]||'').trim();
          out.invoiceAmt = r[info.base.INVOICE_AMT-1]||''; out.qty = r[info.base.QTY-1]||'';
          out.delStatus = r[info.base.DEL_STATUS-1]||''; out.payTerms = r[info.base.PAY_TERMS-1]||'';
        }
        out.stages = Object.entries(info.stages).map(([key, c]) => ({
          key,
          planned: r[c.plan-1]||'', actual: r[c.actual-1]||'',
          status: c.status ? (r[c.status-1]||'') : '', delay: c.delay ? (r[c.delay-1]||'') : '',
          doer: c.doer ? (r[c.doer-1]||'') : '', payStatus: c.payStatus ? (r[c.payStatus-1]||'') : '',
          completed: !!(r[c.actual-1]),
        }));
        return out;
      });
    res.json({ success:true, side, which, orders, meta });
  } catch (e) {
    res.json({ success:false, error: e.message });
  }
});

// ── API: trigger CS Orders/Dispatch_Ledger sync into all 4 sheets ───────────
app.post('/api/sync-now', async (req, res) => {
  try {
    const results = await syncAll();
    res.json({ success:true, results });
  } catch (e) {
    res.json({ success:false, error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.json({ ok: true, t: Date.now() }));

// NOTE: the automatic every-5-min pull (CS Orders/Dispatch_Ledger -> the 4 FMS
// sheets) does NOT run in this Node process anymore. It moved to a separate,
// standalone Google Apps Script project (see ../sheet-sync-agent/Code.gs),
// scheduled with its own time-based trigger. That runs on Google's servers,
// so it keeps working even when this app is asleep on Render's free tier —
// a setInterval() in here would stop firing the moment Render spins the
// process down from inactivity, silently breaking "automatic" sync.
// /api/sync-now below still exists as a manual on-demand button in the UI.

app.listen(PORT, () => {
  console.log(`\n New CRM (O2D Tracker) → http://localhost:${PORT}\n`);
  console.log(` GET  /api/orders?side=new|old&which=fms|split`);
  console.log(` POST /api/complete-stage  { side, which, stageKey, orderId, invoiceNo?, actualTime?, doer?, status?, payStatus? }`);
  console.log(` POST /api/sync-now\n`);
});

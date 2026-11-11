#!/usr/bin/env node
/**
 * Example 4 - follow your orders by asking ResellingKori (polling). Use this when you cannot receive webhooks,
 * or as a slow safety net next to them (every few hours).
 *
 *   RK_KEY_ID=rkk_... RK_SECRET=rks_... node 04_follow_orders.js [--loop=600] [--full] [--dir=./rk-data]
 *
 * Without --loop it asks once and stops - run it from cron every 5 to 15 minutes.
 * With --loop=SECONDS it keeps running and asks again after that many seconds.
 *
 * What it does
 *   1. asks for the orders that changed since the previous poll (the first poll asks for all of them),
 *   2. applies a change only when its "sequence" is higher than the one it already holds (never go backwards),
 *   3. prints every change, and lists orders that were deleted on ResellingKori's side ("gone"),
 *   4. only then saves <dir>/orders.state.json { "cursor": <server_time>, "last_full": ..., "orders": { "<your reference>": {...} } }.
 *
 * Once a day (and with --full) it asks for ALL orders instead of only the changed ones. Only that full poll can
 * tell you about an order that was deleted on ResellingKori's side: a deleted order does not "change", it is just gone.
 *
 * The cursor is the "server_time" that ResellingKori reported at the START of the poll, so an order that changes
 * while you are still reading the pages is simply received again next time.
 *
 * In your own system replace the part marked APPLY by an update of YOUR order (status, tracking number, e-mail).
 * Exit code 0 = fine, 1 = ResellingKori refused or was not reachable, 2 = configuration problem.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ResellingKoriClient, ResellingKoriError } = require('../../clients/node/resellingkori-client');

function loadState(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && typeof d === 'object' && d.orders && typeof d.orders === 'object') return d;
  } catch (e) { /* first run */ }
  return { cursor: null, orders: {} };
}

function saveState(file, state) {
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

const stamp = (iso) => new Date(iso).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';

/** One poll. Resolves to the number of changes applied; rejects with ResellingKoriError. */
async function poll(rk, stateFile, forceFull) {
  const state = loadState(stateFile);
  const full = forceFull || !state.cursor || Date.now() / 1000 - Number(state.last_full || 0) > 86400;
  const since = full ? null : state.cursor;
  if (full) console.log("Full poll: asking for every order (once a day, and with --full; only a full poll can tell you about orders deleted on ResellingKori's side).");
  let next = null;
  let changes = 0;
  const gone = new Set();
  let page = 1;
  let pages = 1;
  do {
    const res = await rk.listOrders({ page, per_page: 100, order: 'asc', updated_after: since });
    if (next === null) next = Number(res.server_time);
    for (const o of res.orders) {
      const ref = String(o.external_order_id);
      const have = state.orders[ref];
      if (have && Number(o.sequence) <= Number(have.sequence)) continue;   // Same or older than what we already applied: ignore.
      const track = o.tracking.number ? `${o.tracking.courier} ${o.tracking.number}`.trim() : '';
      // APPLY: update YOUR order here (status, tracking number, notify your customer).
      console.log(`[${stamp(o.updated_at)}] ${ref} (ResellingKori #${o.number}): ${have ? have.status : '(new to this script)'} -> ${o.status}` +
        (track ? ` | tracking ${track}${o.tracking.url ? ' ' + o.tracking.url : ''}` : '') +
        (o.error ? ` | NEEDS ATTENTION: ${o.error}` : '') +
        (o.cancellable ? ' | can still be cancelled' : ''));
      state.orders[ref] = { id: o.id, status: o.status, sequence: Number(o.sequence), tracking: track };
      changes++;
    }
    for (const ref of res.gone) gone.add(String(ref));
    pages = Number(res.total_pages);
    page++;
  } while (page <= pages);

  for (const ref of gone) console.log(`Order ${ref} was deleted on ResellingKori's side. Contact ResellingKori if you did not expect this.`);
  state.cursor = next;                                   // Saved only now: a crash above simply repeats this poll.
  if (full) state.last_full = next;
  saveState(stateFile, state);
  return changes;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const keyId = process.env.RK_KEY_ID;
  const secret = process.env.RK_SECRET;
  if (!keyId || !secret) { console.error('Set RK_KEY_ID and RK_SECRET first (see START-HERE.md).'); return 2; }
  let loop = 0;
  let force = false;
  let dir = process.env.RK_DATA_DIR || path.join(__dirname, 'rk-data');
  for (const arg of process.argv.slice(2)) {
    const m = /^--loop=(\d+)$/.exec(arg);
    if (m && Number(m[1]) >= 60) loop = Number(m[1]);
    else if (arg === '--full') force = true;
    else if (arg.startsWith('--dir=')) dir = arg.slice(6);
    else { console.error(`Unknown option ${arg}. Usage: node 04_follow_orders.js [--loop=600 (at least 60)] [--full] [--dir=./rk-data]`); return 2; }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(dir, 'orders.state.json');
  const rk = new ResellingKoriClient(keyId, secret, process.env.RK_BASE_URL ? { baseUrl: process.env.RK_BASE_URL } : {});
  do {
    try {
      const n = await poll(rk, stateFile, force);
      force = false;                                     // --full applies to the first poll; later polls decide for themselves.
      console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC: ${n} change(s). Asking again ${loop ? 'in ' + loop + ' s' : 'next time you run this script'}.`);
    } catch (e) {
      if (!(e instanceof ResellingKoriError)) throw e;
      console.error(`POLL FAILED: ${e.apiCode} (HTTP ${e.httpStatus}) ${e.message}`);
      if (!e.retryable || !loop) return 1;
      console.error('  Will try again.');
    }
    if (loop) await sleep(loop * 1000);
  } while (loop);
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });

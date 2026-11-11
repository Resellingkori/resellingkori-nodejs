#!/usr/bin/env node
/**
 * Example 5 - receive ResellingKori's webhooks (order status changes). Plain Node.js, nothing to install.
 *
 *   Try it on your computer:
 *     RK_KEY_ID=rkk_... RK_SECRET=rks_... node 05_webhook_receiver.js          (listens on 127.0.0.1:8099)
 *
 *   In production run it behind a reverse proxy that serves https on your own domain, for example
 *     https://api.example.com/resellingkori/webhook   ->   http://127.0.0.1:8099/resellingkori/webhook
 *   and register that address with 06_register_webhook.js. Use any path you like (RK_WEBHOOK_PATH), but no "?query".
 *
 * For every request the receiver
 *   1. accepts POST on the webhook path only and reads the RAW body (never parse and re-serialise the JSON first),
 *   2. verifies the key, the time (+-300 s) and the signature - a request that fails is answered 401/400 and ignored,
 *   3. answers the registration challenge ("callback.verify") with the proof,
 *   4. ignores a repeated nonce or an event it has already processed (it still answers 200, so that no retry follows),
 *   5. ignores an event whose "sequence" is not higher than the one already applied for that order,
 *   6. stores the event and answers 200 quickly.
 *
 * Do the real work (update your shop's order, e-mail your customer) in a worker that reads what step 6 stored:
 * ResellingKori waits at most 10 seconds for your answer. Any 2xx counts as delivered; network errors, 5xx, 408, 425
 * and 429 are retried after 1, 3, 9, 27 and 81 minutes; other 4xx are not retried.
 *
 * Stored in <data folder> (default ./rk-data): orders/<id>.json = latest state of each order, webhook-events.ndjson =
 * one line per applied event, seen/ = the nonces and event ids already handled (old ones are removed after a day).
 * This example runs as ONE process, so its file steps cannot interleave. With several processes or servers keep the
 * "seen" and "sequence" bookkeeping in your database inside a transaction instead.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ResellingKoriClient, ResellingKoriError } = require('../../clients/node/resellingkori-client');

const KEY_ID = process.env.RK_KEY_ID;
const SECRET = process.env.RK_SECRET;
const DIR = process.env.RK_DATA_DIR || path.join(__dirname, 'rk-data');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8099);
const HOOK_PATH = process.env.RK_WEBHOOK_PATH || '/resellingkori/webhook';
const MAX_BODY = 262144;

if (!KEY_ID || !SECRET) {
  console.error('Set RK_KEY_ID and RK_SECRET first (see START-HERE.md).');
  process.exit(2);
}
for (const sub of ['', 'seen', 'orders']) fs.mkdirSync(path.join(DIR, sub), { recursive: true, mode: 0o700 });

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

function reply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** True the first time a value is seen, false every later time. Atomic: the file is created exclusively. */
function firstTime(kind, value) {
  try {
    fs.closeSync(fs.openSync(path.join(DIR, 'seen', `${kind}-${sha(value)}`), 'wx'));
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

const alreadyDone = (eventId) => fs.existsSync(path.join(DIR, 'seen', `event-${sha(eventId)}`));

/** Remove remembered nonces/event ids older than a day (called now and then). */
function prune() {
  const dir = path.join(DIR, 'seen');
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    try { if (fs.statSync(file).mtimeMs < Date.now() - 86400000) fs.unlinkSync(file); } catch (e) { /* already gone */ }
  }
}

/** Keep the order only if its sequence is higher than the one already stored. Returns true when it was applied. */
function applyIfNewer(order) {
  const file = path.join(DIR, 'orders', `${parseInt(order.id, 10)}.json`);
  let old = null;
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { old = null; }
  const fresh = !old || Number(order.sequence) > Number(old.sequence);
  if (fresh) {
    const tmp = `${file}.tmp${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(order, null, 2));
    fs.renameSync(tmp, file);
  }
  return fresh;
}

function handle(req, res, raw) {
  let event;
  try {
    event = ResellingKoriClient.verifyWebhook(KEY_ID, SECRET, req.headers, raw);          // 2. key, time, signature
  } catch (e) {
    if (!(e instanceof ResellingKoriError)) throw e;
    console.error('ResellingKori webhook rejected: ' + e.message);
    return reply(res, e.httpStatus || 401, { ok: false });
  }
  if (event.type === 'callback.verify') {                                                  // 3. the registration challenge
    console.error('ResellingKori webhook: registration challenge answered.');
    return reply(res, 200, ResellingKoriClient.challengeProof(SECRET, event));
  }
  if (Math.random() < 0.01) prune();
  const nonce = String(req.headers['x-rk-nonce'] || '');                                   // 4. repeats
  if (!firstTime('nonce', nonce) || alreadyDone(event.id)) return reply(res, 200, { ok: true, duplicate: true });
  // Every event has data.order. An event type you do not know yet still means "this order changed": use data.order.
  const order = event.data && event.data.order;
  if (!order || typeof order !== 'object') return reply(res, 200, { ok: true, ignored: 'no_order' });
  let applied;
  try {
    applied = applyIfNewer(order);                                                         // 5. never go backwards
    if (applied) {
      fs.appendFileSync(path.join(DIR, 'webhook-events.ndjson'), JSON.stringify({
        received_at: new Date().toISOString(), event_id: event.id, type: event.type, sequence: order.sequence,
        reference: order.external_order_id, status: order.status, order,
      }) + '\n');
    }
    firstTime('event', event.id);                          // Marked only after the event was stored: a crash above means a retry is processed.
  } catch (e) {
    console.error('ResellingKori webhook: could not store the event: ' + e.message);
    return reply(res, 500, { ok: false, error: 'storage_failed' });                        // 5xx: ResellingKori will send it again later.
  }
  console.error(`ResellingKori webhook: ${event.type} order ${order.external_order_id} (#${order.number}) is now "${order.status}" (sequence ${order.sequence})${applied ? '' : ' - old news, ignored'}`);
  return reply(res, 200, { ok: true, applied });                                           // 6. fast answer
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0];
  if (pathname !== HOOK_PATH) return reply(res, 404, { ok: false, error: 'not_found' });
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'post_only' });   // 1.
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { tooBig = true; return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) return reply(res, 413, { ok: false, error: 'too_large' });
    try { handle(req, res, Buffer.concat(chunks)); } catch (e) {
      console.error('ResellingKori webhook: unexpected error: ' + (e && e.stack ? e.stack : e));
      if (!res.headersSent) reply(res, 500, { ok: false, error: 'receiver_error' });
    }
  });
  req.on('error', () => { if (!res.headersSent) reply(res, 400, { ok: false }); });
});
server.requestTimeout = 15000;
server.listen(PORT, HOST, () => console.error(`Listening on http://${HOST}:${PORT}${HOOK_PATH} - register the PUBLIC https address of this endpoint with 06_register_webhook.js`));

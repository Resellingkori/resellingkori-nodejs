#!/usr/bin/env node
/**
 * Example 2 - copy the ResellingKori catalogue to your side and keep it up to date.
 *
 *   RK_KEY_ID=rkk_... RK_SECRET=rks_... node 02_sync_catalogue.js [--full] [--dir=./rk-data]
 *
 * First run (or --full): every product is downloaded. Later runs: only the products that changed since the newest
 * "date_modified" you already have. Run with --full about once a day: an incremental run cannot tell you that a
 * product has disappeared from ResellingKori's catalogue, a full run can (it lists them as "removed").
 *
 * Writes   <dir>/catalogue.json        { "<product id>": Product, ... }
 *          <dir>/catalogue.state.json  { "cursor": <unix seconds>, "last_full": <unix seconds> }
 *
 * This example keeps the data in a JSON file so that it runs anywhere. In your own system replace the two "SAVE"
 * places by writes to your database (key = the product "id"; update it when it is received again - that is normal).
 *
 * Exit code 0 = synchronised, 1 = ResellingKori refused or was not reachable, 2 = configuration problem.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ResellingKoriClient, ResellingKoriError } = require('../../clients/node/resellingkori-client');

function loadJson(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' ? d : {}; } catch (e) { return {}; }
}

/** Write a JSON file so that a crash can never leave half a file behind. */
function saveJson(file, data) {
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

async function main() {
  const keyId = process.env.RK_KEY_ID;
  const secret = process.env.RK_SECRET;
  if (!keyId || !secret) { console.error('Set RK_KEY_ID and RK_SECRET first (see START-HERE.md).'); return 2; }
  let full = false;
  let dir = process.env.RK_DATA_DIR || path.join(__dirname, 'rk-data');
  for (const arg of process.argv.slice(2)) {
    if (arg === '--full') full = true;
    else if (arg.startsWith('--dir=')) dir = arg.slice(6);
    else { console.error(`Unknown option ${arg}. Usage: node 02_sync_catalogue.js [--full] [--dir=./rk-data]`); return 2; }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const catalogueFile = path.join(dir, 'catalogue.json');
  const stateFile = path.join(dir, 'catalogue.state.json');
  const before = loadJson(catalogueFile);
  const catalogue = full ? {} : { ...before };
  const state = loadJson(stateFile);
  const cursor = !full && Object.keys(catalogue).length && state.cursor ? Number(state.cursor) : null;

  const rk = new ResellingKoriClient(keyId, secret, process.env.RK_BASE_URL ? { baseUrl: process.env.RK_BASE_URL } : {});
  console.log(cursor === null ? 'Full download of the catalogue...' : `Incremental sync: products changed since ${new Date(cursor * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC...`);

  const seen = new Set();
  let added = 0;
  let updated = 0;
  let max = cursor || 0;
  try {
    for await (const product of rk.eachProduct(cursor, 100)) {
      const id = String(product.id);
      if (catalogue[id]) updated++; else added++;
      catalogue[id] = product;                          // SAVE (1): insert or update by id.
      seen.add(id);
      max = Math.max(max, Math.floor(Date.parse(product.date_modified) / 1000) || 0);
    }
  } catch (e) {
    if (!(e instanceof ResellingKoriError)) throw e;
    console.error(`STOPPED: ${e.apiCode} (HTTP ${e.httpStatus}) ${e.message}`);
    if (e.apiCode === 'rkapi_scope_denied') console.error('  Your key has no catalog:read permission. Ask ResellingKori.');
    console.error('  Nothing was saved; the next run starts from the same point.');
    return 1;
  }

  // A full download is the complete truth: whatever was stored before and was not received now is gone.
  let removed = [];
  if (cursor === null) {
    removed = Object.keys(before).filter((id) => !seen.has(id));
    for (const id of removed) delete catalogue[id];     // SAVE (2): delete or hide it in your shop.
  }

  saveJson(catalogueFile, catalogue);
  saveJson(stateFile, {
    cursor: max,                                        // The newest change received; the next run asks "since then".
    last_full: cursor === null ? Math.floor(Date.now() / 1000) : Number(state.last_full || 0),
  });

  const all = Object.values(catalogue);
  const orderable = all.filter((p) => p.stock_status !== 'outofstock' && p.purchasable).length;
  const variable = all.filter((p) => p.type === 'variable').length;
  console.log(`Done. Received ${seen.size} product(s): ${added} new, ${updated} changed or unchanged-but-resent.`);
  if (cursor === null) console.log(`      No longer in ResellingKori's catalogue: ${removed.length}${removed.length ? ' (ids ' + removed.slice(0, 10).join(', ') + (removed.length > 10 ? ', ...' : '') + ')' : ''}`);
  console.log(`Your copy now holds ${all.length} product(s): ${orderable} can be ordered now, ${variable} have variations (order those with rk_variation_id).`);
  console.log(`Saved in ${dir}`);
  for (const p of all.slice(0, 5)) {
    console.log(`  #${String(p.id).padEnd(7)} ${String(p.sku).padEnd(14)} base price ${String(p.base_price).padStart(10)}  ${String(p.stock_status).padEnd(9)} ${p.name}`);
  }
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });

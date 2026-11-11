#!/usr/bin/env node
/**
 * Example 1 - check the connection.
 *
 *   RK_KEY_ID=rkk_... RK_SECRET=rks_... node 01_check_connection.js
 *
 * Optional: RK_BASE_URL (default https://resellingkori.com/wp-json/rk/v1).
 * Exit code 0 = everything is fine, 1 = ResellingKori refused or was not reachable, 2 = credentials missing.
 * Needs Node.js 18 or newer. No packages to install.
 */
'use strict';
const { ResellingKoriClient, ResellingKoriError } = require('../../clients/node/resellingkori-client');

const hints = {
  rkapi_auth_invalid: 'The signature does not match: a wrong secret or key id, or what you sign is not what you send (route, query, body).',
  rkapi_auth_missing: 'The X-RK-* headers did not arrive. A proxy, firewall or hosting layer may be removing them.',
  rkapi_auth_expired: 'Your server clock is off by more than five minutes. Fix the time (NTP) on your server.',
  rkapi_key_revoked: 'This key was revoked or rotated. Ask ResellingKori for the new key.',
  rkapi_store_disabled: 'Your store is switched off at ResellingKori. Contact ResellingKori.',
  rkapi_ip_denied: 'Your key only works from the server addresses registered with ResellingKori.',
  rkapi_locked: 'Too many failed sign-ins from this address. Wait a few minutes, then fix the credentials.',
  network: 'ResellingKori could not be reached. Check the internet connection, firewall and RK_BASE_URL.',
};

async function main() {
  const keyId = process.env.RK_KEY_ID;
  const secret = process.env.RK_SECRET;
  if (!keyId || !secret) {
    console.error('Set RK_KEY_ID and RK_SECRET first (see START-HERE.md).');
    return 2;
  }
  let rk;
  try {
    rk = new ResellingKoriClient(keyId, secret, process.env.RK_BASE_URL ? { baseUrl: process.env.RK_BASE_URL } : {});
  } catch (e) {
    console.error('Configuration problem: ' + e.message);
    return 2;
  }
  let me;
  try {
    me = await rk.ping();
  } catch (e) {
    if (!(e instanceof ResellingKoriError)) throw e;
    console.error(`NOT CONNECTED: ${e.apiCode} (HTTP ${e.httpStatus}) ${e.message}`);
    if (hints[e.apiCode]) console.error('  What to do: ' + hints[e.apiCode]);
    if (e.apiCode === 'rkapi_ip_denied' && e.data.ip) console.error('  ResellingKori saw your server as ' + e.data.ip);
    return 1;
  }
  console.log('Connected.');
  console.log(`  Store        : ${me.store.name} (platform: ${me.store.platform})`);
  console.log(`  Key          : ${me.store.key_id} (${me.store.key_status})`);
  console.log(`  Permissions  : ${me.store.scopes.join(', ')}`);
  console.log(`  IP-restricted: ${me.store.ip_restricted ? 'yes' : 'no'}`);
  console.log(`  Sales agent  : ${me.agent.name} (${me.agent.valid ? 'valid' : 'NOT VALID - orders will be refused, contact ResellingKori'})`);
  console.log(`  Webhook      : ${me.callback.state}${me.callback.url ? ' - ' + me.callback.url : ''}`);
  console.log(`  Clock        : your server differs from ResellingKori by ${me.server_time - Math.floor(Date.now() / 1000)} s (the client corrects this automatically)`);
  console.log(`  Limits       : ${me.limits.requests_per_minute} requests/minute, up to ${me.limits.max_lines} order lines, order total up to ${me.limits.max_order_amount}, cash to collect up to ${me.limits.max_cod_amount}`);
  const missing = ['catalog:read', 'orders:read', 'orders:write'].filter((s) => !me.store.scopes.includes(s));
  if (missing.length) console.log(`  Note: this key cannot use: ${missing.join(', ')}. Ask ResellingKori if your integration needs them.`);
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });

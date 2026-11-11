#!/usr/bin/env node
/**
 * Example 6 - tell ResellingKori where to send webhooks, or switch webhooks off.
 *
 *   RK_KEY_ID=rkk_... RK_SECRET=rks_... node 06_register_webhook.js https://api.example.com/resellingkori/webhook
 *   RK_KEY_ID=rkk_... RK_SECRET=rks_... node 06_register_webhook.js --remove
 *   RK_KEY_ID=rkk_... RK_SECRET=rks_... node 06_register_webhook.js            (only shows the current state)
 *
 * Before you register: your receiver (05_webhook_receiver.js or your own) must already be reachable at that address,
 * because ResellingKori sends a signed "callback.verify" challenge to it at once and your receiver must answer it.
 *
 * Rules for the address: https, a public host name (not an IP address, not localhost, not a private network), port 443,
 * any path but no "?query", no redirects. Your key needs the permission webhooks:manage.
 * You may register 12 times per hour; fix the problem before you try again.
 *
 * Exit code 0 = webhook verified / removed / state shown, 1 = not verified or refused, 2 = wrong usage or configuration.
 */
'use strict';
const { ResellingKoriClient, ResellingKoriError } = require('../../clients/node/resellingkori-client');

const hints = {
  verified: 'ResellingKori reached your receiver and it answered the challenge correctly. Status changes will now be sent to it.',
  rejected: 'The ADDRESS is not allowed (see the message). Fix the address - nothing was sent to it.',
  unreachable: 'ResellingKori could not connect (or got no answer within the time limit). Is the receiver online, on port 443, with a valid certificate?',
  failed: 'Your receiver answered, but not with the correct proof. It must verify the signature and answer HTTP 200 with {"proof": ...} - use ResellingKoriClient.challengeProof().',
  removed: 'The webhook is switched off. Follow your orders by polling (04_follow_orders.js).',
};

async function main() {
  const keyId = process.env.RK_KEY_ID;
  const secret = process.env.RK_SECRET;
  if (!keyId || !secret) { console.error('Set RK_KEY_ID and RK_SECRET first (see START-HERE.md).'); return 2; }
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== '--remove' && args[0].startsWith('--'))) {
    console.error('Usage: node 06_register_webhook.js [https://your-address | --remove]');
    return 2;
  }
  let res;
  try {
    const rk = new ResellingKoriClient(keyId, secret, process.env.RK_BASE_URL ? { baseUrl: process.env.RK_BASE_URL } : {});
    if (!args.length) {
      const me = await rk.ping();
      console.log(`Webhook state: ${me.callback.state}${me.callback.url ? ' - ' + me.callback.url : ''}`);
      console.log('  (none = nothing registered, pending = registered but the challenge has not been answered, verified = working)');
      return 0;
    }
    res = args[0] === '--remove' ? await rk.removeWebhook() : await rk.registerWebhook(args[0]);
  } catch (e) {
    if (e instanceof TypeError) { console.error('Configuration problem: ' + e.message); return 2; }
    if (!(e instanceof ResellingKoriError)) throw e;
    console.error(`REFUSED: ${e.apiCode} (HTTP ${e.httpStatus}) ${e.message}`);
    if (e.apiCode === 'rkapi_scope_denied') console.error('  Your key has no webhooks:manage permission. Ask ResellingKori to add it.');
    else if (e.apiCode === 'rkapi_rate_limited') console.error('  You registered too often. Wait an hour (or the time in Retry-After) and fix the problem first.');
    return 1;
  }
  const r = res.callback_result;
  const state = r ? r.state : 'none';
  console.log(`Result: ${state}`);
  if (r && r.message) console.log(`  ResellingKori says: ${r.message}`);
  if (hints[state]) console.log(`  ${hints[state]}`);
  console.log(`Registered address now: ${res.callback.url ? res.callback.url + ' (' + res.callback.state + ')' : '(none)'}`);
  return ['verified', 'removed'].includes(state) ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });

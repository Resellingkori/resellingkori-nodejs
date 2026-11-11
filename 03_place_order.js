#!/usr/bin/env node
/**
 * Example 3 - check an order, place it exactly once, cancel it.
 *
 *   Check only (safe: nothing is created, nothing is reserved):
 *     RK_KEY_ID=rkk_... RK_SECRET=rks_... node 03_place_order.js [--sku=AW-Y526] [--qty=1] [--price=830]
 *
 *   Really place the order (ResellingKori starts processing it and a courier will be sent):
 *     node 03_place_order.js --sku=AW-Y526 --qty=1 --price=830 --ref=WEB-10058 --place
 *
 *   Run the SAME command again: ResellingKori answers "duplicate" and creates nothing new. This is what makes it safe
 *   to retry after a time-out. Your own order number is the reference; never invent a new one for a retry.
 *
 *   Cancel (possible until ResellingKori has processed the order):
 *     node 03_place_order.js --ref=WEB-10058 --cancel
 *
 * Options  --sku       SKU of the product (or of one variation). Default: the first product that can be ordered now.
 *          --qty       quantity, default 1
 *          --price     YOUR selling price per unit in BDT, never below the base price. Default: base price + 15 %.
 *          --delivery  delivery charge you take from your customer, default 100
 *          --prepaid   what your customer has already paid you, default 0 (the courier collects the rest)
 *          --ref       your reference for this order (required with --place and --cancel)
 *
 * The customer below is sample data. In your system it comes from your own order.
 * Exit code 0 = fine, 1 = ResellingKori refused or was not reachable, 2 = wrong usage or configuration.
 */
'use strict';
const { ResellingKoriClient, ResellingKoriError } = require('../../clients/node/resellingkori-client');

const customer = {
  name: 'Rahim Uddin',
  phone: '01700000000',
  email: 'rahim@example.com',
  address_1: 'House 12, Road 3, Dhanmondi',
  address_2: '',
  city: 'Dhaka',
  state: 'Dhaka',
  postcode: '1209',
  country: 'BD',
};

/* -------------------------------------------------------- money: exact, in paisa (integers), never decimals */

/** "1190.00" or "1190" or "1190.5" -> 119000 paisa. */
function toPaisa(amount) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount).trim());
  if (!m) throw new TypeError(`'${amount}' is not an amount (use digits and at most two decimals, for example 1190 or 1190.50).`);
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}

/** 119000 -> "1190.00" (the format the API expects). */
function money(paisa) {
  return `${Math.floor(paisa / 100)}.${String(paisa % 100).padStart(2, '0')}`;
}

/** Say what went wrong in words a person can act on. */
function explain(e) {
  console.error(`REFUSED: ${e.apiCode} (HTTP ${e.httpStatus}) ${e.message}`);
  const d = e.data || {};
  for (const f of d.fields || []) console.error(`  - ${f.field || '?'}: ${f.message || ''}${f.code ? ' [' + f.code + ']' : ''}`);
  for (const c of d.changes || []) console.error(`  - line ${c.external_item_id}: you expected a base price of ${c.expected_base_unit_price} but it is now ${c.current_base_unit_price}. Refresh your catalogue, show your customer the new price and send again.`);
  for (const s of d.shortages || []) console.error(`  - ${s.label}: you asked for ${s.requested}, only ${s.available} available.`);
  if (e.retryable) console.error('  This kind of answer can be retried with the SAME order and the SAME reference.');
}

async function main() {
  const opt = { qty: '1', delivery: '100', prepaid: '0' };
  let act = 'check';
  for (const arg of process.argv.slice(2)) {
    let m;
    if (arg === '--place') act = 'place';
    else if (arg === '--cancel') act = 'cancel';
    else if ((m = /^--(sku|qty|price|delivery|prepaid|ref)=([\s\S]*)$/.exec(arg))) opt[m[1]] = m[2];
    else { console.error(`Unknown option ${arg}. Read the top of this file for the usage.`); return 2; }
  }
  const keyId = process.env.RK_KEY_ID;
  const secret = process.env.RK_SECRET;
  if (!keyId || !secret) { console.error('Set RK_KEY_ID and RK_SECRET first (see START-HERE.md).'); return 2; }
  if (act !== 'check' && !opt.ref) {
    console.error('--ref is required: it is YOUR reference for the order, for example your own order number (WEB-10058).\nUse the same reference whenever you repeat or cancel this order.');
    return 2;
  }
  const ref = opt.ref || 'EXAMPLE-CHECK';

  try {
    const rk = new ResellingKoriClient(keyId, secret, process.env.RK_BASE_URL ? { baseUrl: process.env.RK_BASE_URL } : {});

    /* ------------------------------------------------------------------------------------------ cancel */
    if (act === 'cancel') {
      const res = await rk.cancelOrder(ref, 'Cancelled from the example script');
      console.log(res.already_cancelled ? `Order ${ref} was already cancelled.` : `Order ${ref} is cancelled. The stock returns to ResellingKori.`);
      return 0;
    }

    /* -------------------------------------------------------------- 1. the product, with live price and stock */
    if (!opt.sku) {
      const list = await rk.listProducts({ in_stock: 1, per_page: 50 });
      const pick = list.items.find((p) => p.type === 'simple' && p.purchasable && p.stock_status === 'instock');
      if (!pick) { console.error('ResellingKori shows no simple product that can be ordered right now. Try again later or pass --sku=.'); return 1; }
      opt.sku = pick.sku;
      console.log(`No --sku given: using the first product that can be ordered now (${pick.sku}).`);
    }
    const found = await rk.productsBySku([opt.sku]);
    const matches = Object.values(found.matches || {});
    if (!matches.length) { console.error(`ResellingKori has no product with SKU ${opt.sku}.`); return 1; }
    const p = matches[0];
    const variation = Number(p.matched_variation_id) || 0;
    let base = p.base_price;
    let label = p.name;
    let unitSku = p.sku;
    if (p.type === 'variable' && !variation) { console.error(`${opt.sku} is a product with variations. Order one variation: pass the SKU of that variation.`); return 2; }
    if (variation) {                                     // A variation has its own price, stock and SKU.
      const v = p.variations.find((x) => Number(x.id) === variation);
      if (v) { base = v.base_price; label += ' - ' + v.label; unitSku = v.sku; }
    }
    console.log(`Product : ${label} (SKU ${unitSku})\nBase price (what you pay ResellingKori): ${base} BDT, stock: ${p.stock_quantity === null ? p.stock_status : p.stock_quantity}`);

    /* ---------------------------------------------------------------------------------- 2. build the order */
    const qty = parseInt(opt.qty, 10);
    const basePaisa = toPaisa(base);
    const pricePaisa = opt.price !== undefined ? toPaisa(opt.price) : Math.floor((basePaisa * 115 + 9999) / 10000) * 100;   // base + 15 %, rounded up to a whole taka
    const delivPaisa = toPaisa(opt.delivery);
    const prepaid = toPaisa(opt.prepaid);
    const totalPaisa = pricePaisa * qty + delivPaisa;     // order_total = items + delivery
    const codPaisa = totalPaisa - prepaid;                // the courier collects the rest
    if (!(qty >= 1) || prepaid > totalPaisa) { console.error(`Quantity must be at least 1 and --prepaid cannot be more than the order total (${money(totalPaisa)}).`); return 2; }
    const order = {
      schema: 2,
      external_order_id: ref,
      external_order_number: '#' + ref,
      currency: 'BDT',
      customer,
      items: [{
        external_item_id: 1,
        rk_product_id: Number(p.id),
        rk_variation_id: variation,
        sku: unitSku,
        name: label,
        quantity: qty,
        selling_unit_price: money(pricePaisa),
        expected_base_unit_price: base,                   // the price guard: refuse if ResellingKori's price has changed meanwhile
      }],
      payment: {
        method: codPaisa === 0 ? 'prepaid' : 'cod',
        delivery_charge: money(delivPaisa),
        prepaid_amount: money(prepaid),
        cod_amount: money(codPaisa),
      },
      partial: false,
      note: 'Example order from the ResellingKori partner developer kit.',
    };

    /* -------------------------------------------------------------------------- 3. check it (always) */
    const check = await rk.validateOrder(order);
    const f = check.financials;
    console.log(`\nChecked by ResellingKori: ${check.valid ? 'the order would be accepted now' : 'NOT valid'}`);
    console.log(`  You sell ${qty} x ${money(pricePaisa)} = ${f.selling_total} | delivery ${f.delivery_charge} | order total ${f.order_total} | already paid ${f.prepaid_amount} | cash the courier collects ${f.cod_amount}`);
    console.log(`  Cost of the goods to you ${f.base_total} | YOUR PROFIT ${f.profit_total} BDT`);
    if (check.existing_order) {
      const ex = check.existing_order;
      console.log(ex.same_content
        ? `  Note: the reference ${ref} was already used with exactly this content (ResellingKori order #${ex.order_id}). Sending it again creates nothing new.`
        : `  WARNING: the reference ${ref} was already used for DIFFERENT content (ResellingKori order #${ex.order_id}). ResellingKori would refuse this order (rkapi_order_conflict) - use a new reference.`);
    }
    if (act !== 'place') {
      console.log('\nThis was only a check - nothing was created. To place the order add: --ref=YOUR-OWN-ORDER-NUMBER --place');
      return 0;
    }

    /* -------------------------------------------------------------------------- 4. place it, exactly once */
    const res = await rk.createOrder(order);
    const o = res.order;
    console.log('\n' + (res.duplicate
      ? (res.recovered ? 'The answer to the first attempt was lost, but the order exists' : 'ResellingKori already had exactly this order') + ' - nothing new was created.'
      : 'ORDER CREATED. Stock is reserved and ResellingKori is processing it.'));
    console.log(`  ResellingKori order #${o.number} | your reference ${o.external_order_id} | status ${o.status} | cancellable: ${o.cancellable ? 'yes' : 'no'}`);
    console.log(`  Follow it with 04_follow_orders.js or with a webhook (05/06). To cancel: node 03_place_order.js --ref=${ref} --cancel`);
    return 0;
  } catch (e) {
    if (e instanceof ResellingKoriError) { explain(e); return 1; }
    if (e instanceof TypeError) { console.error('Problem with your input: ' + e.message); return 2; }
    throw e;
  }
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });

/**
 * ResellingKori Partner API - Node.js client (single file, no dependencies, Node 18+ for global fetch).
 *
 *   const { ResellingKoriClient } = require('./resellingkori-client');
 *   const rk = new ResellingKoriClient(process.env.RK_KEY_ID, process.env.RK_SECRET);
 *   const me = await rk.ping();
 *   const page = await rk.listProducts({ page: 1, per_page: 50 });
 *   const check = await rk.validateOrder(order);   // nothing is created
 *   const res = await rk.createOrder(order);       // created once, even if the network fails half-way
 *
 * Server-side only. Never ship the secret to a browser or a mobile app.
 * License: GPL-2.0-or-later. Version 1.1.1.
 */
'use strict';

const crypto = require('crypto');

const VERSION = '1.1.1';
const WEBHOOK_ROUTE = '/rkc/v1/webhook';

class ResellingKoriError extends Error {
  constructor(message, apiCode, httpStatus, data) {
    super(message);
    this.name = 'ResellingKoriError';
    this.apiCode = apiCode;            // e.g. "rkapi_validation", or "network"
    this.httpStatus = httpStatus;      // 0 for network errors
    this.data = data || {};            // fields[], changes[], shortages[], server_time ...
    this.retryable = httpStatus === 0 || httpStatus >= 500 || [408, 425, 429].includes(httpStatus) ||
      ['rkapi_in_progress', 'rkapi_busy'].includes(apiCode);
  }
}

/** RFC 3986 encoding (encodeURIComponent leaves !'()* alone; RK2 does not). */
function enc(v) {
  return encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildQuery(params) {
  const keys = Object.keys(params || {}).filter((k) => params[k] !== undefined && params[k] !== null).sort();
  return keys.map((k) => {
    let v = params[k];
    if (typeof v === 'object') throw new TypeError('Query parameters must be scalars.');
    if (typeof v === 'boolean') v = v ? '1' : '0';
    return enc(k) + '=' + enc(v);
  }).join('&');
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sign(secret, timestamp, nonce, method, route, query, body) {
  const canonical = ['RK2', String(Math.trunc(Number(timestamp))), nonce, method.toUpperCase(), route, query, sha256hex(body || '')].join('\n');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ResellingKoriClient {
  /**
   * @param {string} keyId  rkk_...
   * @param {string} secret rks_...
   * @param {{baseUrl?: string, timeoutMs?: number, fetch?: Function}} [options]
   */
  constructor(keyId, secret, options = {}) {
    if (!/^rkk_[a-f0-9]{8,64}$/.test(String(keyId)) || !secret) {
      throw new TypeError('A ResellingKori key id (rkk_...) and secret are required.');
    }
    this.keyId = String(keyId);
    this.secret = String(secret);
    this.timeoutMs = options.timeoutMs || 30000;
    this.fetch = options.fetch || globalThis.fetch;
    this.clockOffset = 0;
    const u = new URL(options.baseUrl || 'https://resellingkori.com/wp-json/rk/v1');
    const restRoute = u.searchParams.get('rest_route');
    if (restRoute) {
      this.plain = true;
      this.site = u.origin + u.pathname.replace(/\/+$/, '');
      this.prefix = '/' + restRoute.replace(/^\/+|\/+$/g, '');
    } else {
      const at = u.pathname.indexOf('/wp-json/');
      if (at < 0) throw new TypeError('baseUrl must contain /wp-json/ (or ?rest_route=).');
      this.plain = false;
      this.site = u.origin + u.pathname.slice(0, at + 8);
      this.prefix = '/' + u.pathname.slice(at + 8).replace(/^\/+|\/+$/g, '');
    }
  }

  /** One signed request; resolves to the decoded JSON body, rejects with ResellingKoriError. */
  async request(method, path, query = {}, body = null) {
    method = method.toUpperCase();
    const route = this.prefix + '/' + String(path).replace(/^\/+/, '');
    const q = buildQuery(query);
    const raw = body === null || body === undefined ? '' : String(body);
    for (let attempt = 0; attempt < 2; attempt++) {
      const ts = Math.floor(Date.now() / 1000) + this.clockOffset;
      const nonce = crypto.randomBytes(16).toString('hex');
      const headers = {
        Accept: 'application/json',
        'User-Agent': 'ResellingKori-Node-Client/' + VERSION,
        'X-RK-Key': this.keyId,
        'X-RK-Timestamp': String(ts),
        'X-RK-Nonce': nonce,
        'X-RK-Signature': sign(this.secret, ts, nonce, method, route, q, raw),
      };
      if (method !== 'GET') headers['Content-Type'] = 'application/json';
      const url = this.plain
        ? this.site + '/?rest_route=' + enc(route) + (q ? '&' + q : '')
        : this.site + route + (q ? '?' + q : '');
      let status = 0;
      let text = '';
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await this.fetch(url, { method, headers, body: method === 'GET' ? undefined : raw, redirect: 'manual', signal: ctl.signal });
        status = res.status;
        text = await res.text();
      } catch (e) {
        throw new ResellingKoriError('Network error: ' + e.message, 'network', 0, {});
      } finally {
        clearTimeout(timer);
      }
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      if (status >= 200 && status < 300 && data && typeof data === 'object') return data;
      const code = data && data.code ? data.code : 'http_' + status;
      const info = data && data.data && typeof data.data === 'object' ? data.data : {};
      if (attempt === 0 && code === 'rkapi_auth_expired' && info.server_time) {
        this.clockOffset = Number(info.server_time) - Math.floor(Date.now() / 1000);
        continue;
      }
      throw new ResellingKoriError(data && data.message ? data.message : 'Unexpected HTTP ' + status + ' answer.', code, status, info);
    }
    throw new ResellingKoriError('Clock could not be synchronised.', 'rkapi_auth_expired', 401, {});
  }

  ping() { return this.request('GET', '/ping'); }

  /** params: page, per_page (<=100), updated_after (unix|ISO), category, in_stock, sku, include */
  listProducts(params = {}) { return this.request('GET', '/products', params); }

  /** Async iterator over the whole catalogue (or everything changed since updatedAfter). */
  async *eachProduct(updatedAfter = null, perPage = 100) {
    let page = 1;
    let pages = 1;
    do {
      const res = await this.listProducts({ page, per_page: perPage, updated_after: updatedAfter });
      for (const item of res.items) yield item;
      pages = res.total_pages;
      page++;
    } while (page <= pages);
  }

  categories(hideEmpty = false) { return this.request('GET', '/categories', hideEmpty ? { hide_empty: 1 } : {}); }
  product(id, include = '') { return this.request('GET', '/products/' + parseInt(id, 10), include ? { include } : {}); }
  productsBySku(skus, include = '') {
    const q = { skus: skus.slice(0, 50).join(',') };
    if (include) q.include = include;
    return this.request('GET', '/products/by-sku', q);
  }
  searchProducts(q, perPage = 20) { return this.request('GET', '/products/search', { q, per_page: perPage }); }

  /** Dry run: same checks as createOrder(), nothing created or reserved. "schema" and "currency" default to 2 and BDT, as in createOrder(). */
  validateOrder(order) { return this.request('POST', '/orders/validate', {}, JSON.stringify(Object.assign({ schema: 2, currency: 'BDT' }, order))); }

  /**
   * Create an order exactly once. The body is serialised once; after a lost answer the client looks the order
   * up and only resends the identical body when ResellingKori does not have it. 4xx answers are final.
   */
  async createOrder(order, attempts = 4) {
    order = Object.assign({ schema: 2, currency: 'BDT' }, order);
    if (!order.external_order_id) throw new TypeError('external_order_id is required (your own order reference).');
    const body = JSON.stringify(order);
    const ext = String(order.external_order_id);
    let last = null;
    for (let i = 0; i < Math.max(1, attempts); i++) {
      if (i > 0) {
        await sleep(Math.min(8, 2 ** i) * 1000);
        const found = await this._recover(ext);
        if (found && typeof found === 'object') return found;
        if (found === 'creating') continue;
      }
      try {
        return await this.request('POST', '/orders', {}, body);
      } catch (e) {
        if (!(e instanceof ResellingKoriError) || !e.retryable) throw e;
        last = e;
      }
    }
    throw last || new ResellingKoriError('Order could not be confirmed.', 'network', 0, {});
  }

  async _recover(ext) {
    try {
      const res = await this.lookupOrder(ext);
      return res.order ? { order: res.order, duplicate: true, recovered: true } : 'creating';
    } catch (e) {
      if (e.apiCode === 'rkapi_order_not_found') return null;
      return e.retryable ? 'creating' : null;
    }
  }

  lookupOrder(externalOrderId) { return this.request('GET', '/orders/lookup', { external_order_id: String(externalOrderId) }); }
  order(id) { return this.request('GET', '/orders/' + parseInt(id, 10)); }
  /** params: page, per_page, status, updated_after, order (asc|desc) */
  listOrders(params = {}) { return this.request('GET', '/orders', params); }
  orderStatuses(ids) { return this.request('GET', '/orders/status', { ids: ids.slice(0, 100).map((x) => parseInt(x, 10)).join(',') }); }
  cancelOrder(externalOrderId, reason = '') {
    return this.request('POST', '/orders/cancel', {}, JSON.stringify({ external_order_id: String(externalOrderId), reason }));
  }
  registerWebhook(url) { return this.request('POST', '/connection', {}, JSON.stringify({ callback_url: url })); }
  removeWebhook() { return this.request('POST', '/connection', {}, JSON.stringify({ remove_callback: true })); }

  /**
   * Verify a webhook delivery; returns the event or throws ResellingKoriError (401/400).
   * You must still drop repeated nonces / event ids and events with a lower sequence than you already applied.
   * rawBody must be the exact bytes received (e.g. express.raw({ type: 'application/json' })).
   */
  static verifyWebhook(keyId, secret, headers, rawBody, toleranceSeconds = 300) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
    const get = (n) => (h[n] || '').trim();
    const fail = () => new ResellingKoriError('Invalid webhook signature.', 'invalid_signature', 401, {});
    const ts = get('x-rk-timestamp');
    const nonce = get('x-rk-nonce');
    const sig = get('x-rk-signature').toLowerCase();
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    if (!safeEqual(get('x-rk-key'), keyId) || !/^\d{9,12}$/.test(ts) || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig)) throw fail();
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > toleranceSeconds) throw fail();
    if (!safeEqual(sign(secret, ts, nonce, 'POST', WEBHOOK_ROUTE, '', body), sig)) throw fail();
    let event;
    try { event = JSON.parse(body.toString('utf8')); } catch (e) { event = null; }
    if (!event || typeof event !== 'object' || !event.id || !event.type || String(event.id) !== get('x-rk-event-id')) {
      throw new ResellingKoriError('Malformed webhook body.', 'invalid_body', 400, {});
    }
    return event;
  }

  /** Answer to a callback.verify event: { proof }. */
  static challengeProof(secret, event) {
    return { proof: crypto.createHmac('sha256', secret).update('RK2-CALLBACK\n' + String(event.challenge)).digest('hex') };
  }
}

ResellingKoriClient.sign = sign;
ResellingKoriClient.buildQuery = buildQuery;

module.exports = { ResellingKoriClient, ResellingKoriError, sign, buildQuery };

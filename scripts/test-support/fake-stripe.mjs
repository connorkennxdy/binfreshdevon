// A small in-process fake of the Stripe API surface this project uses. It is not a Stripe emulator:
// it records requests, returns realistic shapes for the current API version, and exposes helpers that
// simulate what Stripe would do (checkout completion, renewal invoices, failures) so webhook flows can be
// exercised end to end. Real Stripe behaviour (test clocks, trial billing) is checked by test-stripe-live.mjs.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const path = k.replace(/\]/g, '').split('[');
    let o = out;
    path.forEach((seg, i) => {
      if (i === path.length - 1) o[seg] = v;
      else { o[seg] = o[seg] ?? {}; o = o[seg]; }
    });
  }
  const fix = (x) => {
    if (x && typeof x === 'object') {
      const keys = Object.keys(x);
      if (keys.length && keys.every((k) => /^\d+$/.test(k))) return keys.sort((a, b) => a - b).map((k) => fix(x[k]));
      for (const k of keys) x[k] = fix(x[k]);
    }
    return x;
  };
  return fix(out);
}
const id = (p) => `${p}_${randomBytes(9).toString('hex')}`;
const ts = () => Math.floor(Date.now() / 1000);

export async function startFakeStripe() {
  const db = { customers: {}, products: {}, prices: {}, sessions: {}, subscriptions: {}, invoices: {}, payment_intents: {}, charges: {}, balance_transactions: {}, refunds: {}, portal_configs: {}, payment_methods: {} };
  const requests = [];
  const idem = new Map();
  let failNext = null;

  const err = (res, status, message, code) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'invalid_request_error', message, code } })); };

  function fee(amount, billing) { return Math.round(amount * 0.015 + 20 + (billing ? amount * 0.007 : 0)); }
  function makeCharge(customer, amount, { billing = false, fail = false } = {}) {
    const bt = { id: id('txn'), object: 'balance_transaction', amount, fee: fee(amount, billing), net: amount - fee(amount, billing) };
    db.balance_transactions[bt.id] = bt;
    const ch = { id: id('ch'), object: 'charge', amount, amount_refunded: 0, refunded: false, customer, balance_transaction: bt.id, status: fail ? 'failed' : 'succeeded' };
    db.charges[ch.id] = ch;
    const pi = { id: id('pi'), object: 'payment_intent', amount, amount_received: fail ? 0 : amount, customer, latest_charge: ch.id, status: fail ? 'requires_payment_method' : 'succeeded', metadata: {} };
    ch.payment_intent = pi.id;
    db.payment_intents[pi.id] = pi;
    return pi;
  }
  function priceOf(pid) { const p = db.prices[pid]; if (!p) throw Object.assign(new Error(`No such price: '${pid}'`), { status: 400 }); return p; }
  function makeInvoice(sub, { reason, lines, periodStart, fail = false, paid = true }) {
    const amount = lines.reduce((a, l) => a + l.amount, 0);
    const pi = amount > 0 ? makeCharge(sub.customer, amount, { billing: true, fail }) : null;
    const inv = {
      id: id('in'), object: 'invoice', customer: sub.customer, billing_reason: reason,
      amount_due: amount, amount_paid: fail ? 0 : amount, status: fail ? 'open' : 'paid', created: ts(),
      status_transitions: { paid_at: fail ? null : ts() },
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id, metadata: sub.metadata } },
      lines: { object: 'list', data: lines },
      period_start: periodStart, period_end: periodStart,
      payments: { object: 'list', data: pi ? [{ id: id('inpay'), status: fail ? 'open' : 'paid', payment: { type: 'payment_intent', payment_intent: pi.id } }] : [] },
    };
    db.invoices[inv.id] = inv;
    return inv;
  }

  const routes = [
    ['POST', /^\/v1\/customers$/, (b) => { const c = { id: id('cus'), object: 'customer', ...b }; db.customers[c.id] = c; return c; }],
    ['GET', /^\/v1\/customers\/(cus_\w+)\/payment_methods$/, (b, m) => ({ object: 'list', data: db.payment_methods[m[1]] ? [db.payment_methods[m[1]]] : [] })],
    ['POST', /^\/v1\/customers\/(cus_\w+)$/, (b, m) => { const c = db.customers[m[1]]; if (!c) throw Object.assign(new Error('No such customer'), { status: 404, code: 'resource_missing' }); Object.assign(c, b); return c; }],
    ['GET', /^\/v1\/customers\/(cus_\w+)$/, (b, m) => db.customers[m[1]] || null],
    ['POST', /^\/v1\/products$/, (b) => { if (b.id && db.products[b.id]) throw Object.assign(new Error('Product already exists.'), { status: 400, code: 'resource_already_exists' }); const p = { object: 'product', active: true, ...b, id: b.id || id('prod') }; db.products[p.id] = p; return p; }],
    ['GET', /^\/v1\/products\/([\w-]+)$/, (b, m) => db.products[m[1]] || null],
    ['POST', /^\/v1\/products\/([\w-]+)$/, (b, m) => { const p = db.products[m[1]]; if (!p) return null; Object.assign(p, b); return p; }],
    ['GET', /^\/v1\/prices$/, (b, m, q) => {
      const keys = q.lookup_keys ? [].concat(q.lookup_keys) : null;
      let list = Object.values(db.prices);
      if (keys) list = list.filter((p) => keys.includes(p.lookup_key));
      if (q.active !== undefined) list = list.filter((p) => String(p.active) === String(q.active));
      if (q.product) list = list.filter((p) => p.product === q.product);
      return { object: 'list', data: list, has_more: false };
    }],
    ['POST', /^\/v1\/prices$/, (b) => {
      if (b.lookup_key) {
        const holder = Object.values(db.prices).find((p) => p.lookup_key === b.lookup_key);
        if (holder && b.transfer_lookup_key !== 'true') throw Object.assign(new Error('lookup_key already in use'), { status: 400 });
        if (holder) holder.lookup_key = null;
      }
      const p = { id: id('price'), object: 'price', active: true, currency: b.currency, unit_amount: Number(b.unit_amount), product: b.product, lookup_key: b.lookup_key || null, metadata: b.metadata || {},
        type: b.recurring ? 'recurring' : 'one_time', recurring: b.recurring ? { interval: b.recurring.interval, interval_count: Number(b.recurring.interval_count || 1) } : null };
      delete p.transfer_lookup_key;
      db.prices[p.id] = p; return p;
    }],
    ['POST', /^\/v1\/prices\/(price_\w+)$/, (b, m) => { const p = db.prices[m[1]]; Object.assign(p, { active: b.active === undefined ? p.active : b.active === 'true', lookup_key: b.lookup_key === '' ? null : (b.lookup_key ?? p.lookup_key) }); return p; }],
    ['POST', /^\/v1\/checkout\/sessions$/, (b) => {
      const items = (b.line_items || []).map((l) => ({ price: priceOf(l.price), quantity: Number(l.quantity || 1) }));
      if (b.mode === 'subscription') {
        if (!items.some((i) => i.price.type === 'recurring')) throw Object.assign(new Error('subscription mode needs a recurring price'), { status: 400 });
        const te = Number(b.subscription_data?.trial_end || 0);
        if (te && te < ts() + 48 * 3600) throw Object.assign(new Error('trial_end must be at least 48 hours in the future'), { status: 400 });
      } else if (items.some((i) => i.price.type === 'recurring')) throw Object.assign(new Error('payment mode cannot have recurring prices'), { status: 400 });
      const exp = Number(b.expires_at || ts() + 86400);
      if (exp < ts() + 1800 - 5 || exp > ts() + 86400) throw Object.assign(new Error('expires_at must be between 30 minutes and 24 hours'), { status: 400 });
      const amount_total = items.filter((i) => b.mode === 'payment' || i.price.type === 'one_time').reduce((a, i) => a + i.price.unit_amount * i.quantity, 0);
      const s = { id: id('cs_test'), object: 'checkout.session', mode: b.mode, status: 'open', payment_status: 'unpaid', customer: b.customer, metadata: b.metadata || {},
        client_reference_id: b.client_reference_id, url: `https://checkout.stripe.com/c/pay/${randomBytes(6).toString('hex')}`, expires_at: exp,
        amount_total, created: ts(), _params: b, _items: items, payment_intent: null, subscription: null, invoice: null };
      db.sessions[s.id] = s; return s;
    }],
    ['GET', /^\/v1\/checkout\/sessions\/(cs_\w+)$/, (b, m) => db.sessions[m[1]] || null],
    ['POST', /^\/v1\/checkout\/sessions\/(cs_\w+)\/expire$/, (b, m) => { const s = db.sessions[m[1]]; s.status = 'expired'; return s; }],
    ['GET', /^\/v1\/subscriptions\/(sub_\w+)$/, (b, m) => db.subscriptions[m[1]] || null],
    ['POST', /^\/v1\/subscriptions\/(sub_\w+)$/, (b, m) => {
      const s = db.subscriptions[m[1]]; if (!s) return null;
      if (b.trial_end) { s.trial_end = Number(b.trial_end); s.status = 'trialing'; }
      if (b.pause_collection !== undefined) s.pause_collection = b.pause_collection === '' ? null : b.pause_collection;
      if (b.items) for (const it of b.items) { const x = s.items.data.find((y) => y.id === it.id); if (x && it.price) x.price = priceOf(it.price); }
      s._updates = (s._updates || []).concat([b]); return s;
    }],
    ['DELETE', /^\/v1\/subscriptions\/(sub_\w+)$/, (b, m, q) => { const s = db.subscriptions[m[1]]; if (!s) throw Object.assign(new Error('No such subscription'), { status: 404, code: 'resource_missing' }); s.status = 'canceled'; s._cancel = { ...q, ...b }; return s; }],
    ['POST', /^\/v1\/refunds$/, (b) => {
      const pi = db.payment_intents[b.payment_intent]; if (!pi) throw Object.assign(new Error('No such payment_intent'), { status: 400 });
      const ch = db.charges[pi.latest_charge]; const amount = Number(b.amount || ch.amount - ch.amount_refunded);
      if (amount > ch.amount - ch.amount_refunded) throw Object.assign(new Error('Refund exceeds charge'), { status: 400 });
      ch.amount_refunded += amount; ch.refunded = ch.amount_refunded === ch.amount;
      const r = { id: id('re'), object: 'refund', amount, payment_intent: pi.id, charge: ch.id, status: 'succeeded', metadata: b.metadata || {} };
      db.refunds[r.id] = r; return r;
    }],
    ['GET', /^\/v1\/payment_intents\/(pi_\w+)$/, (b, m, q) => {
      const pi = db.payment_intents[m[1]]; if (!pi) return null;
      const exp = [].concat(q.expand || []);
      if (exp.includes('latest_charge.balance_transaction')) { const ch = { ...db.charges[pi.latest_charge] }; ch.balance_transaction = db.balance_transactions[ch.balance_transaction]; return { ...pi, latest_charge: ch }; }
      return pi;
    }],
    ['GET', /^\/v1\/invoices\/(in_\w+)$/, (b, m) => db.invoices[m[1]] || null],
    ['POST', /^\/v1\/billing_portal\/configurations$/, (b) => { const c = { id: id('bpc'), object: 'billing_portal.configuration', ...b }; db.portal_configs[c.id] = c; return c; }],
    ['GET', /^\/v1\/billing_portal\/configurations$/, () => ({ object: 'list', data: Object.values(db.portal_configs) })],
    ['POST', /^\/v1\/billing_portal\/sessions$/, (b) => ({ id: id('bps'), object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/test', ...b })],
  ];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const q = parseForm(u.search.slice(1));
      const b = parseForm(body);
      requests.push({ method: req.method, path: u.pathname, body: b, query: q, idem: req.headers['idempotency-key'] });
      const key = req.headers['idempotency-key'];
      if (key && idem.has(key)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(idem.get(key)); }
      if (failNext && failNext.test(req.method, u.pathname)) { const f = failNext; failNext = null; return err(res, f.status || 500, f.message || 'simulated failure'); }
      for (const [method, re, fn] of routes) {
        const m = u.pathname.match(re);
        if (req.method === method && m) {
          try {
            const out = fn(b, m, q);
            if (out === null) return err(res, 404, 'No such object', 'resource_missing');
            const text = JSON.stringify(out, (k, v) => (k.startsWith('_') ? undefined : v));
            if (key && req.method === 'POST') idem.set(key, text);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(text);
          } catch (e) { return err(res, e.status || 500, e.message, e.code); }
        }
      }
      err(res, 404, `fake-stripe: no route for ${req.method} ${u.pathname}`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // ---- simulation helpers (what Stripe would do) ----
  const helpers = {
    port, db, requests,
    failNextRequest(method, pathRe, status = 500, message) { failNext = { test: (m, p) => m === method && pathRe.test(p), status, message }; },
    completeSession(sessionId, { card = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } } = {}) {
      const s = db.sessions[sessionId];
      s.status = 'complete'; s.payment_status = 'paid';
      db.payment_methods[s.customer] = { id: id('pm'), object: 'payment_method', type: 'card', card };
      if (s.mode === 'payment') {
        const pi = makeCharge(s.customer, s.amount_total);
        s.payment_intent = pi.id;
        return { session: s };
      }
      const rec = s._items.filter((i) => i.price.type === 'recurring');
      const once = s._items.filter((i) => i.price.type === 'one_time');
      const sub = { id: id('sub'), object: 'subscription', customer: s.customer, status: 'trialing', trial_end: Number(s._params.subscription_data?.trial_end || 0),
        metadata: s._params.subscription_data?.metadata || {}, items: { object: 'list', data: rec.map((i) => ({ id: id('si'), price: i.price, quantity: i.quantity })) } };
      db.subscriptions[sub.id] = sub;
      const lines = [
        ...once.map((i) => ({ id: id('il'), amount: i.price.unit_amount * i.quantity, price: i.price, period: { start: ts(), end: ts() } })),
        ...rec.map((i) => ({ id: id('il'), amount: 0, price: i.price, parent: { type: 'subscription_item_details', subscription_item_details: { subscription_item: 'si' } }, period: { start: ts(), end: sub.trial_end } })),
      ];
      const inv = makeInvoice(sub, { reason: 'subscription_create', lines, periodStart: ts() });
      s.subscription = sub.id; s.invoice = inv.id;
      if (!s.amount_total) s.payment_status = 'no_payment_required';
      return { session: s, subscription: sub, invoice: inv };
    },
    // A renewal invoice for the period starting at `periodStart` (unix seconds).
    cycleInvoice(subId, periodStart, { fail = false } = {}) {
      const sub = db.subscriptions[subId];
      const lines = sub.items.data.map((it) => ({ id: id('il'), amount: it.price.unit_amount * it.quantity, price: it.price,
        parent: { type: 'subscription_item_details', subscription_item_details: { subscription_item: it.id } }, period: { start: periodStart, end: periodStart + 28 * 86400 } }));
      return makeInvoice(sub, { reason: 'subscription_cycle', lines, periodStart: periodStart - 28 * 86400, fail });
    },
    chargeFor(paymentIntentId) { return db.charges[db.payment_intents[paymentIntentId].latest_charge]; },
    close: () => new Promise((r) => server.close(r)),
  };
  return helpers;
}

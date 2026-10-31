// Per-test-file environment: a fresh database cloned from the migrated template, fake Stripe,
// fake Resend/Twilio/Google, and helpers to call Netlify function handlers directly.
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { startFakeStripe } from './fake-stripe.mjs';
import { startFakeServices } from './fake-services.mjs';

export const ADMIN_URL = process.env.TEST_PG_URL || 'postgres://postgres@127.0.0.1:54329/postgres';
const dbUrl = (name) => ADMIN_URL.replace(/\/[^/]*$/, '/' + name);

export async function setup({ seedStripe = true } = {}) {
  const name = 'bf_t_' + randomBytes(5).toString('hex');
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name} template bf_template`);
  await admin.end();

  const stripe = await startFakeStripe();
  const svc = await startFakeServices();
  Object.assign(process.env, {
    BF_TEST_MODE: '1',
    SUPABASE_DB_URL: dbUrl(name),
    DB_POOL_MAX: '10',
    STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(stripe.port), STRIPE_API_PROTOCOL: 'http',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', STRIPE_PORTAL_CONFIG_ID: 'bpc_test',
    RESEND_API_KEY: 're_test', RESEND_API_BASE: svc.base, EMAIL_FROM: 'Bin Fresh Devon <bookings@binfreshdevon.co.uk>',
    TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_SENDER_ID: 'BinFresh', TWILIO_API_BASE: svc.base,
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', GOOGLE_OAUTH_BASE: svc.base, GOOGLE_API_BASE: svc.base, GOOGLE_USERINFO_URL: svc.base + '/v1/userinfo', GOOGLE_AUTH_URL: svc.base + '/auth',
    TOKEN_ENC_KEY: randomBytes(32).toString('base64'),
    SESSION_SECRET: 'test-session-secret', APP_PASSCODE: 'letmein', ADMIN_EMAILS: 'tom@binfreshdevon.co.uk,connor.kennedy205@gmail.com',
    TOM_ALERT_EMAIL: 'tom@binfreshdevon.co.uk',
    SITE_URL: 'https://binfreshdevon.co.uk', APP_URL: 'https://app.binfreshdevon.co.uk',
  });
  delete process.env.BF_NOW;

  const lib = await import('../../netlify/functions/lib/db.mjs');
  const { _resetStripe, stripe: stripeClient } = await import('../../netlify/functions/lib/stripe.mjs');
  _resetStripe();
  const sql = lib.db();
  if (seedStripe) {
    const { seed } = await import('../stripe-seed.mjs');
    await seed({ stripe: stripeClient(), sql, log: () => {} });
  }
  lib.clearSettingsCache();

  const h = {
    sql, stripe, svc, name,
    setNow(iso) { if (iso) process.env.BF_NOW = iso; else delete process.env.BF_NOW; },
    async call(mod, { method = 'GET', path, body, headers = {}, cookie, params = {}, ip = '203.0.113.' + (1 + Math.floor(Math.random() * 200)), host = 'localhost' } = {}) {
      const { default: fn } = await import(`../../netlify/functions/${mod}.mjs`);
      const hd = { ...headers };
      if (cookie) hd.cookie = cookie;
      if (body !== undefined && typeof body !== 'string') hd['content-type'] = 'application/json';
      const req = new Request(`http://${host}${path}`, { method, headers: hd, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
      const res = await fn(req, { params, ip });
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
    },
    async webhook(type, object, { id = 'evt_' + randomBytes(8).toString('hex') } = {}) {
      const { default: Stripe } = await import('stripe');
      const payload = JSON.stringify({ id, object: 'event', type, data: { object } });
      const sig = new Stripe('sk_test_x').webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
      return h.call('stripe-webhook', { method: 'POST', path: '/api/stripe/webhook', body: payload, headers: { 'stripe-signature': sig, 'content-type': 'application/json' } });
    },
    async adminCookie() {
      const r = await h.call('admin-auth', { method: 'POST', path: '/api/admin/session', body: { passcode: 'letmein' } });
      return r.cookie;
    },
    async teardown() {
      const { closeDb } = await import('../../netlify/functions/lib/db.mjs');
      await closeDb();
      await stripe.close(); await svc.close();
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
  return h;
}

// A valid booking body for `date` (YYYY-MM-DD).
export function bookingBody(date, over = {}) {
  return {
    postcode: 'EX31 1AA', plan: 'one-off', items: { 'household-2': 1 }, deep_clean: false, date, window: '14-16', terms: true,
    customer: { name: 'Jason Wonnacott', email: 'jason@example.com', phone: '07700 900123', address_line1: '1 High Street', town: 'Barnstaple', postcode: 'EX31 1AA', access_notes: 'Side gate' },
    ...over,
  };
}

let emailSeq = 0;
// Book through the real API and complete payment through the fake Stripe + webhook. Returns { visit, plan, session, subscription }.
export async function bookAndPay(h, date, { plan = 'one-off', window = '14-16', items = { 'household-2': 1 }, deep = false, email, name = 'Test Customer', phone = '07700 900123' } = {}) {
  const seq = ++emailSeq;
  email = email || `cust${seq}-${Date.now()}@example.com`;
  const body = bookingBody(date, { plan, window, items, deep_clean: deep, customer: { ...bookingBody().customer, email, name, phone } });
  const r = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body, ip: '10.0.' + (seq % 250) + '.' + (1 + (seq % 200)) });
  if (r.status !== 200) throw new Error('checkout failed: ' + JSON.stringify(r.data));
  const s = Object.values(h.stripe.db.sessions).at(-1);
  const done = h.stripe.completeSession(s.id);
  await h.webhook('checkout.session.completed', done.session);
  if (done.invoice) await h.webhook('invoice.paid', done.invoice);
  const [visit] = await h.sql`select * from visits where stripe_checkout_session_id = ${s.id}`;
  const [p] = visit.plan_id ? await h.sql`select * from plans where id = ${visit.plan_id}` : [null];
  const [customer] = await h.sql`select * from customers where id = ${visit.customer_id}`;
  return { visit, plan: p, customer, session: done.session, subscription: done.subscription };
}

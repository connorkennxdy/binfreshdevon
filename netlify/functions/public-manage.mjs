// Customer self-service (§2.6, §8). Cookie-scoped to one customer.
//   GET  /api/manage                    — visits, plan, card on file
//   GET  /api/manage/slots?visit=       — reschedule options (±7 days of the original date)
//   POST /api/manage/reschedule         {visit_id, date, window}
//   POST /api/manage/cancel-plan        {plan_id, refund_next}
//   POST /api/manage/cancel-visit       {visit_id}   (one-off visits)
//   POST /api/manage/portal             — Stripe Customer Portal (card update only)
//   POST /api/manage/logout
import { handler, json, readJson, bad, HttpError } from './lib/http.mjs';
import { requireManage, clearManageCookie } from './lib/auth.mjs';
import { db, getSettings } from './lib/db.mjs';
import { stripe } from './lib/stripe.mjs';
import { env, siteUrl } from './lib/env.mjs';
import { availability, windowById, windowStart } from './lib/availability.mjs';
import { visitItems, rescheduleVisit, cancelPlan, cancelOneOffVisit, planItems } from './lib/booking.mjs';
import { describeItems } from './lib/catalogue.mjs';
import { addDays, londonDate, longDate, shortDate, windowLabel, now } from './lib/time.mjs';

const DAY = 86400000;

async function state(customerId) {
  const sql = db();
  const s = await getSettings();
  const [c] = await sql`select * from customers where id = ${customerId}`;
  if (!c) throw new HttpError(401, 'Your link has expired. Request a new one below.', 'unauthenticated');
  const today = londonDate(now());
  const visits = await sql`select * from visits where customer_id = ${customerId} and status in ('scheduled','done','skipped') and visit_date >= ${addDays(today, -60)} order by visit_date, time_window`;
  const plans = await sql`select * from plans where customer_id = ${customerId} and status in ('active','paused') order by created_at`;
  const out = [];
  for (const v of visits) {
    const start = windowStart(s, v.visit_date, v.time_window);
    out.push({
      id: v.id, date: v.visit_date, date_label: longDate(v.visit_date), short: shortDate(v.visit_date),
      window: v.time_window, window_label: windowLabel(windowById(s, v.time_window) || { start: '14:00', end: '16:00' }),
      status: v.status, payment_status: v.payment_status, amount_pence: v.amount_pence,
      items: describeItems(await visitItems(v.id)), plan_id: v.plan_id,
      upcoming: v.visit_date >= today && v.status === 'scheduled',
      can_change: v.status === 'scheduled' && start - now() > DAY,
    });
  }
  const planOut = [];
  for (const p of plans) {
    const items = await planItems(p.id);
    planOut.push({ id: p.id, status: p.status, items: describeItems(items), price_pence: items.reduce((a, i) => a + i.qty * i.unit_price_pence, 0), window: p.time_window });
  }
  let card = null;
  if (c.stripe_customer_id && env('STRIPE_SECRET_KEY')) {
    try {
      const pms = await stripe().customers.listPaymentMethods(c.stripe_customer_id, { type: 'card', limit: 1 });
      const pm = pms.data[0];
      if (pm) card = { brand: pm.card.brand, last4: pm.card.last4, exp: `${String(pm.card.exp_month).padStart(2, '0')}/${String(pm.card.exp_year).slice(-2)}` };
    } catch (e) { console.error('card lookup failed', e.message); }
  }
  return { customer: { first_name: c.name.split(/\s+/)[0], postcode: c.postcode }, visits: out, plans: planOut, card };
}

export default handler(async (req) => {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/$/, '');
  if (p === '/api/manage/logout') return json({ ok: true }, 200, { 'set-cookie': clearManageCookie() });
  const customerId = requireManage(req);
  const sql = db();

  if (req.method === 'GET' && p === '/api/manage') return json(await state(customerId));

  if (req.method === 'GET' && p === '/api/manage/slots') {
    const [v] = await sql`select * from visits where id = ${url.searchParams.get('visit') || '00000000-0000-0000-0000-000000000000'} and customer_id = ${customerId}`;
    if (!v) throw new HttpError(404, 'Visit not found');
    const { days } = await availability(addDays(v.original_date, -7), addDays(v.original_date, 7), { ignoreHorizon: true });
    return json({ current: { date: v.visit_date, window: v.time_window }, days: days.map((d) => ({ date: d.date, label: shortDate(d.date), bookable: d.bookable, windows: d.windows.map((w) => ({ id: w.id, label: w.label, left: w.left })) })) });
  }

  if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
  const b = await readJson(req);

  if (p === '/api/manage/reschedule') {
    const v = await rescheduleVisit(String(b.visit_id || ''), String(b.date || ''), String(b.window || ''), { by: 'customer', customerId });
    return json({ ok: true, date: v.visit_date, window: v.time_window });
  }
  if (p === '/api/manage/cancel-plan') {
    return json({ ok: true, ...(await cancelPlan(String(b.plan_id || ''), { actor: 'customer', customerId, refundNext: b.refund_next === true })) });
  }
  if (p === '/api/manage/cancel-visit') {
    return json({ ok: true, ...(await cancelOneOffVisit(String(b.visit_id || ''), { customerId })) });
  }
  if (p === '/api/manage/portal') {
    const [c] = await sql`select stripe_customer_id from customers where id = ${customerId}`;
    if (!c?.stripe_customer_id) throw bad('No card on file.');
    const session = await stripe().billingPortal.sessions.create({
      customer: c.stripe_customer_id,
      configuration: env('STRIPE_PORTAL_CONFIG_ID') || undefined,
      return_url: `${siteUrl()}/manage/`,
      flow_data: { type: 'payment_method_update' },
    });
    return json({ url: session.url });
  }
  return json({ error: 'Not found' }, 404);
});

export const config = { path: ['/api/manage', '/api/manage/*'], excludedPath: ['/api/manage/lost-link'] };

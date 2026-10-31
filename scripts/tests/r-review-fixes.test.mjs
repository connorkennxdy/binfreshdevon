// Regression tests for the issues found in the independent payments review.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bookAndPay, bookingBody } from '../test-support/harness.mjs';

let h, cookie;
const NOW = '2026-11-02T10:00:00Z';
before(async () => { h = await setup(); h.setNow(NOW); cookie = await h.adminCookie(); });
after(async () => { await h.teardown(); });
beforeEach(() => { h.setNow(NOW); h.svc.reset(); });
const lastSession = () => Object.values(h.stripe.db.sessions).at(-1);

test('an unpaid booking with someone else\'s email changes nothing; a paid one updates the address but only flags a new phone', async () => {
  const { customer } = await bookAndPay(h, '2026-11-10', { email: 'victim@example.com', name: 'Vic Tim', phone: '07700 900001' });
  const attacker = bookingBody('2026-11-11', { customer: { ...bookingBody().customer, email: 'VICTIM@example.com', name: 'Evil', phone: '07700 966666', address_line1: '9 Evil Road' } });
  const r = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: attacker, ip: '198.51.100.99' });
  assert.equal(r.status, 200);
  let [c] = await h.sql`select * from customers where id = ${customer.id}`;
  assert.equal(c.phone, '+447700900001', 'phone untouched by an unpaid booking');
  assert.equal(c.address_line1, '1 High Street');
  assert.equal(c.name, 'Vic Tim');
  // now that booking is paid: address applied, phone flagged not applied
  const { session } = h.stripe.completeSession(lastSession().id);
  await h.webhook('checkout.session.completed', session);
  [c] = await h.sql`select * from customers where id = ${customer.id}`;
  assert.equal(c.address_line1, '9 Evil Road');
  assert.equal(c.phone, '+447700900001', 'phone never changed by a booking form');
  const [v] = await h.sql`select * from visits where stripe_checkout_session_id = ${session.id}`;
  assert.match(v.attention, /New mobile given at booking: \+447700966666/);
});

test('pause then resume on the same cadence recreates the visit, and the renewal pays a live visit', async () => {
  const { plan } = await bookAndPay(h, '2026-11-05', { plan: 'recurring', name: 'Pat Pause' });
  await h.call('admin-customers', { method: 'POST', path: `/api/admin/plans/${plan.id}/pause`, cookie, body: {} });
  assert.equal((await h.sql`select status from visits where plan_id = ${plan.id} and original_date = '2026-12-03'`)[0].status, 'cancelled');
  const r = await h.call('admin-customers', { method: 'POST', path: `/api/admin/plans/${plan.id}/resume`, cookie, body: { date: '2026-12-03' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [v] = await h.sql`select * from visits where plan_id = ${plan.id} and original_date = '2026-12-03'`;
  assert.equal(v.status, 'scheduled');
  const inv = h.stripe.cycleInvoice(plan.stripe_subscription_id, Date.parse('2026-12-03T07:00:00Z') / 1000);
  await h.webhook('invoice.paid', inv);
  const [after] = await h.sql`select status, payment_status, attention from visits where plan_id = ${plan.id} and original_date = '2026-12-03'`;
  assert.deepEqual([after.status, after.payment_status], ['scheduled', 'paid']);
  assert.equal(after.attention, null);
});

test('a payment that lands on a cancelled visit is flagged for Tom', async () => {
  const { plan } = await bookAndPay(h, '2026-11-06', { plan: 'recurring', name: 'Cass Cancelled' });
  await h.sql`update visits set status = 'cancelled' where plan_id = ${plan.id} and original_date = '2026-12-04'`;
  await h.webhook('invoice.paid', h.stripe.cycleInvoice(plan.stripe_subscription_id, Date.parse('2026-12-04T07:00:00Z') / 1000));
  const [v] = await h.sql`select attention from visits where plan_id = ${plan.id} and original_date = '2026-12-04'`;
  assert.match(v.attention, /refund or rebook/);
  assert.ok(h.svc.emails().some((m) => /A payment needs checking/.test(m.subject)));
});

test('moving a plan to before an already-paid first clean is refused', async () => {
  const { plan } = await bookAndPay(h, '2026-11-20', { plan: 'recurring', name: 'Mo Mover' });
  const r = await h.call('admin-customers', { method: 'POST', path: `/api/admin/plans/${plan.id}/move`, cookie, body: { date: '2026-11-10' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /paid clean on Fri 20 Nov/);
  const ok = await h.call('admin-customers', { method: 'POST', path: `/api/admin/plans/${plan.id}/move`, cookie, body: { date: '2026-12-01' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test('a webhook whose function died mid-way is processed on Stripe\'s retry', async () => {
  const r = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody('2026-11-12', { customer: { ...bookingBody().customer, email: 'stuck@example.com' } }), ip: '198.51.100.12' });
  assert.equal(r.status, 200);
  const { session } = h.stripe.completeSession(lastSession().id);
  // simulate a claim left behind by a killed invocation 10 minutes ago
  await h.sql`insert into stripe_events (id, type, received_at) values ('evt_stuck', 'checkout.session.completed', now() - interval '10 minutes')`;
  const w = await h.webhook('checkout.session.completed', session, { id: 'evt_stuck' });
  assert.equal(w.data.result, 'ok');
  const [v] = await h.sql`select status, payment_status from visits where stripe_checkout_session_id = ${session.id}`;
  assert.deepEqual([v.status, v.payment_status], ['scheduled', 'paid']);
  // but a fresh in-flight claim is still treated as a duplicate
  await h.sql`insert into stripe_events (id, type) values ('evt_inflight', 'checkout.session.completed')`;
  assert.equal((await h.webhook('checkout.session.completed', session, { id: 'evt_inflight' })).data.duplicate, true);
});

test('a slot hold outlives the Checkout session (late payers keep their slot)', async () => {
  await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody('2026-11-13', { customer: { ...bookingBody().customer, email: 'late@example.com' } }), ip: '198.51.100.13' });
  const s = lastSession();
  const [v] = await h.sql`select extract(epoch from hold_expires_at)::int as hold from visits where stripe_checkout_session_id = ${s.id}`;
  assert.ok(v.hold - s.expires_at >= 14 * 60, 'hold ends ≥14 minutes after the session');
  assert.deepEqual(s._params.payment_method_types, ['card']);
});

test('starting a new checkout expires the same customer\'s older unpaid one', async () => {
  const body = bookingBody('2026-11-16', { customer: { ...bookingBody().customer, email: 'twotabs@example.com' } });
  await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body, ip: '198.51.100.14' });
  const first = lastSession();
  await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body, ip: '198.51.100.14' });
  assert.equal(h.stripe.db.sessions[first.id].status, 'expired');
  const [{ n }] = await h.sql`select count(*)::int as n from visits v join customers c on c.id = v.customer_id where c.email = 'twotabs@example.com' and v.status = 'held'`;
  assert.equal(n, 1);
});

test('renewal is matched by the subscription line even when an extra invoice item comes first', async () => {
  const { plan } = await bookAndPay(h, '2026-11-07', { plan: 'recurring', name: 'Ivy Item' });
  const inv = h.stripe.cycleInvoice(plan.stripe_subscription_id, Date.parse('2026-12-05T07:00:00Z') / 1000);
  inv.lines.data.unshift({ id: 'il_extra', amount: 500, price: { id: 'price_x', recurring: null }, pricing: { price_details: { price: 'price_x' } }, period: { start: Date.parse('2026-11-20T10:00:00Z') / 1000, end: Date.parse('2026-11-20T10:00:00Z') / 1000 } });
  await h.webhook('invoice.paid', inv);
  assert.equal((await h.sql`select payment_status from visits where plan_id = ${plan.id} and original_date = '2026-12-05'`)[0].payment_status, 'paid');
  assert.equal((await h.sql`select count(*)::int as n from visits where plan_id = ${plan.id} and original_date = '2026-11-20'`)[0].n, 0, 'no bogus visit created');
});

test('refunds are capped at what is left on the charge and recorded once', async () => {
  const { visit } = await bookAndPay(h, '2026-11-17', { items: { 'household-2': 1 } });
  const r1 = await h.call('admin-visits', { method: 'POST', path: `/api/admin/visits/${visit.id}/refund`, cookie, body: {} });
  assert.equal(r1.data.refunded_pence, 2100);
  await h.sql`update visits set payment_status = 'paid' where id = ${visit.id}`; // pretend someone tries again
  const r2 = await h.call('admin-visits', { method: 'POST', path: `/api/admin/visits/${visit.id}/refund`, cookie, body: {} });
  assert.equal(r2.status, 400);
  const [p] = await h.sql`select refunded_pence, status from payments where visit_id = ${visit.id}`;
  assert.deepEqual([p.refunded_pence, p.status], [2100, 'refunded']);
});

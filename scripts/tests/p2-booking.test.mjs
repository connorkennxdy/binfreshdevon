import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bookingBody } from '../test-support/harness.mjs';

let h;
const NOW = '2026-11-02T10:00:00Z'; // Monday 2 Nov 2026, 10:00 GMT
before(async () => { h = await setup(); });
after(async () => { await h.teardown(); });
beforeEach(() => { h.setNow(NOW); h.svc.reset(); });

const avail = async (from, to) => (await h.call('public-availability', { path: `/api/availability?from=${from}&to=${to}` })).data.days;
const lastSession = () => Object.values(h.stripe.db.sessions).at(-1);

test('P2-1 availability: no Sundays, nothing today or earlier, Mon–Sat from tomorrow', async () => {
  const days = await avail('2026-11-01', '2026-11-09');
  const by = Object.fromEntries(days.map((d) => [d.date, d]));
  assert.equal(by['2026-11-01'].bookable, false); // Sunday + past
  assert.equal(by['2026-11-02'].reason, 'past');   // today
  assert.equal(by['2026-11-03'].bookable, true);   // tomorrow (Tue)
  assert.equal(by['2026-11-08'].reason, 'sunday');
  for (const d of days) assert.deepEqual(d.windows.map((w) => w.id), ['14-16', '16-18'], 'only afternoon windows exist');
  assert.equal(by['2026-11-03'].windows[0].left, 6);
});

test('P2-1 availability: cut-off at 18:00 the day before, horizon 6 weeks', async () => {
  h.setNow('2026-11-02T17:59:00Z');
  assert.equal((await avail('2026-11-03', '2026-11-03'))[0].bookable, true);
  h.setNow('2026-11-02T18:00:00Z');
  assert.equal((await avail('2026-11-03', '2026-11-03'))[0].reason, 'cutoff');
  h.setNow(NOW);
  const days = await avail('2026-12-12', '2026-12-16');
  const by = Object.fromEntries(days.map((d) => [d.date, d]));
  assert.equal(by['2026-12-14'].bookable, true);   // today + 42 days
  assert.equal(by['2026-12-15'].reason, 'horizon'); // day 43
});

test('P2-1 availability: cut-off uses UK time across the BST→GMT change', async () => {
  // Sat 24 Oct 2026 is BST (UTC+1): bookings for Sun... use Mon 26 Oct (GMT after the change on Sun 25 Oct).
  h.setNow('2026-10-24T16:59:00Z'); // 17:59 BST on Sat 24 Oct
  assert.equal((await avail('2026-10-26', '2026-10-26'))[0].bookable, true);
  h.setNow('2026-10-25T17:59:00Z'); // 17:59 GMT Sun 25 Oct (after clocks went back) — still before Monday's cut-off
  assert.equal((await avail('2026-10-26', '2026-10-26'))[0].bookable, true);
  h.setNow('2026-10-25T18:00:00Z'); // 18:00 GMT
  assert.equal((await avail('2026-10-26', '2026-10-26'))[0].reason, 'cutoff');
  h.setNow('2026-10-23T17:00:00Z'); // 18:00 BST Fri 23 Oct: Saturday closed
  assert.equal((await avail('2026-10-24', '2026-10-24'))[0].reason, 'cutoff');
});

test('P2-1 availability: blocked days/windows excluded, a full window shows 0 left', async () => {
  await h.sql`insert into blocks (block_date, time_window, reason) values ('2026-11-04', null, 'Holiday'), ('2026-11-05', '16-18', 'Dentist')`;
  const [c] = await h.sql`insert into customers (name,email,phone,address_line1,town,postcode) values ('Full','full@x.com','+447700900111','1 St','Town','EX31 1AA') returning id`;
  for (let i = 0; i < 6; i++) await h.sql`select book_slot(${c.id}, null, '2026-11-06', '14-16', '2026-11-06', 'scheduled', 1250, 'paid', 0, false)`;
  const days = await avail('2026-11-04', '2026-11-06');
  const by = Object.fromEntries(days.map((d) => [d.date, d]));
  assert.equal(by['2026-11-04'].bookable, false);
  assert.equal(by['2026-11-04'].reason, 'blocked');
  assert.deepEqual(by['2026-11-05'].windows.map((w) => w.left), [6, 0]);
  assert.equal(by['2026-11-05'].bookable, true);
  assert.deepEqual(by['2026-11-06'].windows.map((w) => w.left), [0, 6]);
  // and the API refuses the full window
  const r = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody('2026-11-06', { customer: { ...bookingBody().customer, email: 'p21@x.com' } }) });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'full');
});

test('P2-2 tampered prices or services in the request are ignored or rejected', async () => {
  const body = bookingBody('2026-11-10', { items: { 'household-2': 1 }, price: 1, amount: 1, first_pence: 1, unit_price: 1, customer: { ...bookingBody().customer, email: 'tamper@x.com' } });
  const r = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = lastSession();
  assert.equal(s.amount_total, 2100, 'server price for 2 bins one-off');
  const [svc] = await h.sql`select stripe_price_one_off from services where slug = 'household-2'`;
  assert.deepEqual(s._items.map((i) => i.price.id), [svc.stripe_price_one_off]);
  const [v] = await h.sql`select amount_pence from visits where stripe_checkout_session_id = ${s.id}`;
  assert.equal(v.amount_pence, 2100);

  for (const items of [{ 'commercial-660': 1 }, { 'deep-clean': 1 }, { 'made-up': 1 }, { 'household-2': 5 }, { 'household-1': 1, 'household-2': 1 }, { 'household-2': -1 }, {}]) {
    const x = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody('2026-11-10', { items, customer: { ...bookingBody().customer, email: 'tamper2@x.com' } }) });
    assert.equal(x.status, 400, `rejected ${JSON.stringify(items)}: ${JSON.stringify(x.data)}`);
  }
  const q = await h.call('public-quote-price', { method: 'POST', path: '/api/quote-price', body: { plan: 'recurring', items: { 'household-3': 1, 'household-360': 2 }, deep_clean: true, first_pence: 1 } });
  assert.equal(q.data.recurring_pence, 1850 + 2000);
  assert.equal(q.data.first_pence, 1850 + 2000 + 1750);
});

test('P2-3 an out-of-area postcode is refused by the API', async () => {
  const r = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody('2026-11-10', { postcode: 'EX1 1AA', customer: { ...bookingBody().customer, postcode: 'EX1 1AA', email: 'out@x.com' } }) });
  assert.equal(r.status, 422);
  assert.equal(r.data.code, 'out_of_area');
  // address postcode must match the checked one
  const r2 = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody('2026-11-10', { customer: { ...bookingBody().customer, postcode: 'TQ1 1AA', email: 'out2@x.com' } }) });
  assert.equal(r2.status, 400);
  const pc = await h.call('public-services', { path: '/api/postcode?pc=ex34%208aa' });
  assert.deepEqual(pc.data, { ok: true, reason: null, postcode: 'EX34 8AA' });
  const no = await h.call('public-services', { path: '/api/postcode?pc=PL1%201AA' });
  assert.equal(no.data.ok, false);
});

test('P2-4 one-off booking: checkout completes → visit scheduled + paid, payment recorded, email sent', async () => {
  const r = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody('2026-11-11', { deep_clean: true, customer: { ...bookingBody().customer, email: 'oneoff@x.com' } }) });
  assert.equal(r.status, 200);
  assert.match(r.data.url, /^https:\/\/checkout\.stripe\.com\//);
  const s = lastSession();
  assert.equal(s.mode, 'payment');
  assert.equal(s.amount_total, 2100 + 1750);
  const [held] = await h.sql`select * from visits where stripe_checkout_session_id = ${s.id}`;
  assert.equal(held.status, 'held');

  const status0 = await h.call('public-booking-status', { path: `/api/booking-status?session_id=${s.id}` });
  assert.equal(status0.data.status, 'pending');

  const { session } = h.stripe.completeSession(s.id);
  const w = await h.webhook('checkout.session.completed', session);
  assert.equal(w.status, 200, JSON.stringify(w.data));
  const [v] = await h.sql`select * from visits where id = ${held.id}`;
  assert.equal(v.status, 'scheduled');
  assert.equal(v.payment_status, 'paid');
  const [p] = await h.sql`select * from payments where visit_id = ${v.id}`;
  assert.equal(p.amount_pence, 3850);
  assert.equal(p.fee_pence, Math.round(3850 * 0.015 + 20));
  const mails = h.svc.emails();
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['oneoff@x.com']);
  assert.match(mails[0].subject, /^Booked: Wed 11 Nov, 2–4pm$/);
  assert.match(mails[0].html, /https:\/\/binfreshdevon\.co\.uk\/m\/[A-Za-z0-9_-]{43}/);
  const st = await h.call('public-booking-status', { path: `/api/booking-status?session_id=${s.id}` });
  assert.equal(st.data.status, 'confirmed');
  assert.equal(st.data.items, '2 household bins + deep clean');
  assert.equal(st.data.window_label, '2–4pm');
});

test('P2-5 abandoned checkout frees the slot (expiry webhook, and hold timeout)', async () => {
  const before = (await avail('2026-11-12', '2026-11-12'))[0].windows[1].left;
  const r = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody('2026-11-12', { window: '16-18', plan: 'recurring', customer: { ...bookingBody().customer, email: 'abandon@x.com' } }) });
  assert.equal(r.status, 200);
  assert.equal((await avail('2026-11-12', '2026-11-12'))[0].windows[1].left, before - 1, 'held slot counts');
  const s = lastSession();
  assert.ok(s.expires_at - Math.floor(Date.now() / 1000) >= 30 * 60, 'session lives at least 30 minutes');
  await h.webhook('checkout.session.expired', { ...s, status: 'expired' });
  assert.equal((await avail('2026-11-12', '2026-11-12'))[0].windows[1].left, before);
  assert.equal((await h.sql`select count(*)::int as n from plans where stripe_checkout_session_id = ${s.id}`)[0].n, 0, 'pending plan removed');

  // A hold whose time has passed stops counting even before any cleanup runs.
  await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody('2026-11-12', { window: '16-18', customer: { ...bookingBody().customer, email: 'abandon2@x.com' } }) });
  assert.equal((await avail('2026-11-12', '2026-11-12'))[0].windows[1].left, before - 1);
  await h.sql`update visits set hold_expires_at = now() - interval '1 second' where status = 'held'`;
  assert.equal((await avail('2026-11-12', '2026-11-12'))[0].windows[1].left, before);
});

test('P2-6 4-weekly booking: one charge at checkout, trial_end = first visit + 28 days 07:00 UK, renewals pay the matching visit', async () => {
  const first = '2026-11-07'; // Saturday, 5 days out
  const r = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody(first, { plan: 'recurring', items: { 'household-2': 1 }, deep_clean: true, customer: { ...bookingBody().customer, email: 'plan@x.com', name: 'Steph Cleak' } }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = lastSession();
  assert.equal(s.mode, 'subscription');
  const p = s._params;
  assert.equal(p.payment_method_collection, 'always');
  assert.equal(Number(p.subscription_data.trial_end), Date.parse('2026-12-05T07:00:00Z') / 1000, '07:00 GMT on 5 Dec');
  const kinds = s._items.map((i) => [i.price.type, i.price.unit_amount, i.price.lookup_key]);
  assert.deepEqual(kinds, [['recurring', 1350, 'bf_household-2_4wk'], ['one_time', 1350, 'bf_household-2_first'], ['one_time', 1750, 'bf_deep-clean_oneoff']]);
  assert.equal(s.amount_total, 1350 + 1750, 'charged today: first clean + deep clean');

  const { session, subscription, invoice } = h.stripe.completeSession(s.id);
  assert.equal((await h.webhook('checkout.session.completed', session)).status, 200);
  assert.equal((await h.webhook('invoice.paid', invoice)).status, 200);
  const charges = Object.values(h.stripe.db.charges).filter((c) => c.customer === session.customer);
  assert.equal(charges.length, 1, 'exactly one charge at checkout');

  const [plan] = await h.sql`select * from plans where stripe_subscription_id = ${subscription.id}`;
  assert.equal(plan.status, 'active');
  const visits = await h.sql`select * from visits where plan_id = ${plan.id} order by original_date`;
  assert.deepEqual(visits.map((v) => v.original_date), ['2026-11-07', '2026-12-05'], 'visits generated 8 weeks ahead (to 28 Dec)');
  assert.deepEqual(visits.map((v) => v.payment_status), ['paid', 'due']);
  assert.equal(visits[0].amount_pence, 3100);
  assert.equal(visits[1].amount_pence, 1350, 'renewals are the plan price without the deep clean');
  const pays = await h.sql`select * from payments where customer_id = ${plan.customer_id}`;
  assert.equal(pays.length, 1);
  assert.equal(pays[0].amount_pence, 3100);

  // Renewal at trial_end pays the 5 Dec visit; the next renewal pays 2 Jan.
  const inv1 = h.stripe.cycleInvoice(subscription.id, Date.parse('2026-12-05T07:00:00Z') / 1000);
  assert.equal((await h.webhook('invoice.paid', inv1)).status, 200);
  const inv2 = h.stripe.cycleInvoice(subscription.id, Date.parse('2027-01-02T07:00:00Z') / 1000);
  await h.webhook('invoice.paid', inv2);
  const after = await h.sql`select original_date, payment_status from visits where plan_id = ${plan.id} order by original_date`;
  assert.deepEqual(after.map((v) => [v.original_date, v.payment_status]), [['2026-11-07', 'paid'], ['2026-12-05', 'paid'], ['2027-01-02', 'paid']], 'a renewal beyond the generated range creates its visit');
  const pays2 = await h.sql`select amount_pence, fee_pence from payments where customer_id = ${plan.customer_id} order by paid_at`;
  assert.equal(pays2.length, 3);
  assert.equal(pays2[1].fee_pence, Math.round(1350 * 0.015 + 20 + 1350 * 0.007), 'Billing fee recorded');

  const mails = h.svc.emails().filter((m) => m.to[0] === 'plan@x.com');
  assert.equal(mails.length, 1, 'one confirmation');
  assert.match(mails[0].text, /Then £13\.50 is taken from your card on the morning of each clean, every 4 weeks/);
});

test('P2-6 billing dates stay on visit dates across the clocks change', async () => {
  const { londonToUtc, londonDate, addDays } = await import('../../netlify/functions/lib/time.mjs');
  // First visit Sat 6 Mar 2027 → trial_end Sat 3 Apr 2027 07:00 BST = 06:00Z
  assert.equal(londonToUtc(addDays('2027-03-06', 28), '07:00').toISOString(), '2027-04-03T06:00:00.000Z');
  // Stripe then bills every 28 days in UTC: 06:00Z stays the same London date through the October change (07:00 BST → 06:00 GMT)
  let t = Date.parse('2027-04-03T06:00:00Z');
  let d = '2027-04-03';
  for (let i = 0; i < 12; i++) { assert.equal(londonDate(new Date(t)), d); t += 28 * 86400000; d = addDays(d, 28); }
});

test('P2-7 a duplicate webhook delivery is processed once', async () => {
  const r = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: bookingBody('2026-11-13', { customer: { ...bookingBody().customer, email: 'dupe@x.com' } }) });
  assert.equal(r.status, 200);
  const { session } = h.stripe.completeSession(lastSession().id);
  const a = await h.webhook('checkout.session.completed', session, { id: 'evt_dupe_1' });
  const b = await h.webhook('checkout.session.completed', session, { id: 'evt_dupe_1' });
  assert.equal(a.data.result, 'ok');
  assert.equal(b.data.duplicate, true);
  const [{ n }] = await h.sql`select count(*)::int as n from payments where stripe_payment_intent_id = ${session.payment_intent}`;
  assert.equal(n, 1);
  assert.equal(h.svc.emails().length, 1);
  // a redelivery under a new event id still doesn't double-email or double-record
  await h.webhook('checkout.session.completed', session, { id: 'evt_dupe_2' });
  assert.equal(h.svc.emails().length, 1);
  assert.equal((await h.sql`select count(*)::int as n from payments where stripe_payment_intent_id = ${session.payment_intent}`)[0].n, 1);
});

test('webhook rejects a bad signature', async () => {
  const r = await h.call('stripe-webhook', { method: 'POST', path: '/api/stripe/webhook', body: '{"id":"evt_x","type":"checkout.session.completed","data":{"object":{}}}', headers: { 'stripe-signature': 't=1,v1=bad' } });
  assert.equal(r.status, 400);
});

test('booking rate limit: 5 per IP per 10 minutes, honeypot rejected', async () => {
  const ip = '198.51.100.7';
  let last;
  for (let i = 0; i < 6; i++) last = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', ip, body: bookingBody('2026-11-14', { postcode: 'XX', customer: { ...bookingBody().customer, email: `rl${i}@x.com` } }) });
  assert.equal(last.status, 429);
  const hp = await h.call('public-create-checkout', { method: 'POST', path: '/api/checkout', body: { ...bookingBody('2026-11-14'), 'bf-check': 'spam' } });
  assert.equal(hp.status, 400);
});

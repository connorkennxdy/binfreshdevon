import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bookAndPay } from '../test-support/harness.mjs';

let h, cookie;
const NOW = '2026-11-02T10:00:00Z';
before(async () => { h = await setup(); h.setNow(NOW); cookie = await h.adminCookie(); });
after(async () => { await h.teardown(); });
beforeEach(() => { h.setNow(NOW); h.svc.reset(); h.svc.setGoogleDown(false); });
const adm = (mod, path, opts = {}) => h.call(mod, { path, cookie, ...opts });

// ---------- Phase 5: Google Calendar ----------
test('P5-1 connect flow creates the "Bin Fresh Rounds" calendar (state bound to the admin session)', async () => {
  const start = await h.call('google-oauth', { path: '/api/google/calendar', cookie });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.searchParams.get('access_type'), 'offline');
  assert.equal(loc.searchParams.get('prompt'), 'consent');
  assert.match(loc.searchParams.get('scope'), /calendar\.app\.created/);
  const state = loc.searchParams.get('state');
  // without the admin session the callback is refused
  const nos = await h.call('google-oauth', { path: `/api/google/callback?state=${encodeURIComponent(state)}&code=tom@binfreshdevon.co.uk`, cookie: start.cookie });
  assert.match(nos.headers.get('location'), /settings\?error=/);
  const cb = await h.call('google-oauth', { path: `/api/google/callback?state=${encodeURIComponent(state)}&code=tom@binfreshdevon.co.uk`, cookie: `${start.cookie}; ${cookie}` });
  assert.match(cb.headers.get('location'), /#\/settings\?calendar=connected/);
  assert.equal([...h.svc.calendars.values()][0].summary, 'Bin Fresh Rounds');
  const s = (await adm('admin-settings', '/api/admin/settings')).data;
  assert.equal(s.calendar.connected, true);
  const [{ value }] = await h.sql`select value from settings where key = 'google_calendar'`;
  assert.ok(!JSON.stringify(value).includes('rt_tom'), 'refresh token is encrypted at rest');
});

test('P5-2 create, reschedule and cancel a visit: event created, moved and deleted', async () => {
  const { visit, customer } = await bookAndPay(h, '2026-11-12', { name: 'Jason Wonnacott', items: { 'household-2': 1 } });
  let [v] = await h.sql`select * from visits where id = ${visit.id}`;
  assert.ok(v.google_event_id, 'event created on booking');
  let ev = h.svc.events.get(v.google_event_id);
  assert.equal(ev.summary, '2 bins · J. Wonnacott · EX31 1AA');
  assert.deepEqual(ev.start, { dateTime: '2026-11-12T14:00:00', timeZone: 'Europe/London' });
  assert.equal(ev.colorId, '7', 'teal = paid');
  assert.match(ev.description, /Phone: \+447700900123/);
  assert.match(ev.description, /https:\/\/app\.binfreshdevon\.co\.uk\/#\/visit\//);
  assert.equal(ev.location, '1 High Street, Barnstaple, EX31 1AA');

  // reschedule through the manage page
  const tok = await import('../../netlify/functions/lib/auth.mjs');
  const mc = tok.manageSessionCookie(customer.id).split(';')[0];
  const r = await h.call('public-manage', { method: 'POST', path: '/api/manage/reschedule', cookie: mc, body: { visit_id: visit.id, date: '2026-11-13', window: '16-18' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ev = h.svc.events.get(v.google_event_id);
  assert.deepEqual(ev.start, { dateTime: '2026-11-13T16:00:00', timeZone: 'Europe/London' });

  // mark done -> grey
  await adm('admin-visits', `/api/admin/visits/${visit.id}/done`, { method: 'POST', body: {} });
  assert.equal(h.svc.events.get(v.google_event_id).colorId, '8');
  await adm('admin-visits', `/api/admin/visits/${visit.id}/undo`, { method: 'POST', body: {} });

  // cancel (customer cancels the one-off) -> deleted
  const c = await h.call('public-manage', { method: 'POST', path: '/api/manage/cancel-visit', cookie: mc, body: { visit_id: visit.id } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.ok(c.data.refunded > 0);
  assert.equal(h.svc.events.has(v.google_event_id), false, 'event deleted');
  [v] = await h.sql`select * from visits where id = ${visit.id}`;
  assert.equal(v.status, 'cancelled');
  assert.equal(v.payment_status, 'refunded');
});

test('P5-3 with Google down, changes are retried by the reconcile job and nothing is lost', async () => {
  h.svc.setGoogleDown(true);
  const { visit } = await bookAndPay(h, '2026-11-14', { name: 'Outage Olly' });
  const { staleVisitIds } = await import('../../netlify/functions/lib/calendar.mjs');
  assert.ok((await staleVisitIds()).includes(visit.id), 'still stale');
  await adm('admin-visits', `/api/admin/visits/${visit.id}/note`, { method: 'POST', body: { notes: 'Dog in garden' } });
  const { reconcileCalendar } = await import('../../netlify/functions/lib/jobs.mjs');
  const fail = await reconcileCalendar();
  assert.ok(fail.error >= 1);
  h.svc.setGoogleDown(false);
  const ok = await reconcileCalendar();
  assert.ok(ok.synced >= 1);
  const [v] = await h.sql`select * from visits where id = ${visit.id}`;
  assert.ok(v.google_event_id);
  assert.match(h.svc.events.get(v.google_event_id).description, /Notes: Dog in garden/);
  assert.equal((await staleVisitIds()).includes(visit.id), false);
});

test('ICS fallback feed: secret token, valid calendar', async () => {
  const tk = await adm('admin-settings', '/api/admin/settings/ics-token', { method: 'POST', body: {} });
  const k = new URL(tk.data.url).searchParams.get('k');
  assert.equal((await h.call('calendar-ics', { path: '/api/calendar.ics?k=wrong' })).status, 404);
  const r = await h.call('calendar-ics', { path: `/api/calendar.ics?k=${k}` });
  assert.equal(r.status, 200);
  assert.match(r.data, /^BEGIN:VCALENDAR\r\n/);
  assert.match(r.data, /DTSTART;TZID=Europe\/London:20261114T140000/);
});

// ---------- Phase 6: manage page ----------
test('P6-1 magic link sign-in; wrong/expired token refused; lost-link never reveals whether an email exists', async () => {
  const { customer } = await bookAndPay(h, '2026-11-16', { email: 'magic@example.com', name: 'Mia Magic' });
  const { createManageToken } = await import('../../netlify/functions/lib/auth.mjs');
  const token = await createManageToken(customer.id);
  const ok = await h.call('public-manage-link', { path: `/m/${token}`, params: { code: token } });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/manage/');
  const st = await h.call('public-manage', { path: '/api/manage', cookie: ok.cookie });
  assert.equal(st.status, 200);
  assert.equal(st.data.customer.first_name, 'Mia');
  assert.deepEqual(st.data.card, { brand: 'visa', last4: '4242', exp: '12/30' });

  const wrong = await h.call('public-manage-link', { path: '/m/AAAAAAAAAAAAAAAAAAAAAAAA', params: { code: 'AAAAAAAAAAAAAAAAAAAAAAAA' } });
  assert.equal(wrong.headers.get('location'), '/manage/?e=expired');
  const old = await createManageToken(customer.id);
  await h.sql`update manage_tokens set expires_at = now() - interval '1 minute'`;
  const exp = await h.call('public-manage-link', { path: `/m/${old}`, params: { code: old } });
  assert.equal(exp.headers.get('location'), '/manage/?e=expired');
  assert.equal((await h.call('public-manage', { path: '/api/manage' })).status, 401);

  h.svc.reset();
  const a = await h.call('public-manage-link', { method: 'POST', path: '/api/manage/lost-link', body: { email: 'magic@example.com' } });
  const b = await h.call('public-manage-link', { method: 'POST', path: '/api/manage/lost-link', body: { email: 'nobody@example.com' } });
  assert.deepEqual(a.data, b.data, 'identical responses');
  assert.equal(a.status, b.status);
  assert.equal(h.svc.emails().length, 1);
  assert.deepEqual(h.svc.emails()[0].to, ['magic@example.com']);
  // 3 per email per hour
  for (let i = 0; i < 4; i++) await h.call('public-manage-link', { method: 'POST', path: '/api/manage/lost-link', body: { email: 'magic@example.com' } });
  assert.equal(h.svc.emails().length, 3);
});

test('P6-2 reschedule allowed at 25h before a visit and refused at 23h', async () => {
  const { visit, customer } = await bookAndPay(h, '2026-11-20', { window: '14-16' }); // Fri 2pm GMT = 14:00Z
  const { manageSessionCookie } = await import('../../netlify/functions/lib/auth.mjs');
  const mc = manageSessionCookie(customer.id).split(';')[0];
  h.setNow('2026-11-19T15:00:00Z'); // 23h before
  const no = await h.call('public-manage', { method: 'POST', path: '/api/manage/reschedule', cookie: mc, body: { visit_id: visit.id, date: '2026-11-23', window: '14-16' } });
  assert.equal(no.status, 409);
  assert.equal(no.data.code, 'too_late');
  h.setNow('2026-11-19T13:00:00Z'); // 25h before
  const yes = await h.call('public-manage', { method: 'POST', path: '/api/manage/reschedule', cookie: mc, body: { visit_id: visit.id, date: '2026-11-23', window: '14-16' } });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  // outside ±7 days of the original
  const far = await h.call('public-manage', { method: 'POST', path: '/api/manage/reschedule', cookie: mc, body: { visit_id: visit.id, date: '2026-11-28', window: '14-16' } });
  assert.equal(far.status, 400);
  // another customer's visit is invisible
  const other = await bookAndPay(h, '2026-11-24');
  const steal = await h.call('public-manage', { method: 'POST', path: '/api/manage/reschedule', cookie: mc, body: { visit_id: other.visit.id, date: '2026-11-25', window: '14-16' } });
  assert.equal(steal.status, 404);
});

test('P6-3 cancel plan: subscription cancelled, future unpaid visits cancelled with events deleted, refund option per §2.6', async () => {
  const { manageSessionCookie } = await import('../../netlify/functions/lib/auth.mjs');
  // Plan A: next paid visit is >24h away -> customer ticks refund
  const A = await bookAndPay(h, '2026-11-21', { plan: 'recurring', name: 'Plan Refund', email: 'pa@example.com' });
  const evIds = (await h.sql`select google_event_id from visits where plan_id = ${A.plan.id}`).map((r) => r.google_event_id);
  assert.ok(evIds.every(Boolean));
  const mcA = manageSessionCookie(A.customer.id).split(';')[0];
  const r = await h.call('public-manage', { method: 'POST', path: '/api/manage/cancel-plan', cookie: mcA, body: { plan_id: A.plan.id, refund_next: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refunded, 1350);
  assert.equal(h.stripe.db.subscriptions[A.plan.stripe_subscription_id].status, 'canceled');
  assert.equal(h.stripe.db.subscriptions[A.plan.stripe_subscription_id]._cancel.prorate, 'false');
  const va = await h.sql`select original_date, status, payment_status, google_event_id from visits where plan_id = ${A.plan.id} order by original_date`;
  assert.deepEqual(va.map((v) => [v.status, v.payment_status]), [['cancelled', 'refunded'], ['cancelled', 'due']]);
  assert.ok(va.every((v) => !v.google_event_id), 'events removed');
  for (const id of evIds) assert.equal(h.svc.events.has(id), false);
  assert.equal((await h.sql`select status from plans where id = ${A.plan.id}`)[0].status, 'cancelled');
  // the subscription.deleted webhook that follows is harmless
  assert.equal((await h.webhook('customer.subscription.deleted', { id: A.plan.stripe_subscription_id })).status, 200);

  // Plan B: inside 24h -> paid visit stands, no refund even if ticked
  const B = await bookAndPay(h, '2026-11-03', { plan: 'recurring', name: 'Plan Late', email: 'pb@example.com' });
  h.setNow('2026-11-02T20:00:00Z'); // 18h before Tue 3 Nov 14:00
  const mcB = manageSessionCookie(B.customer.id).split(';')[0];
  const r2 = await h.call('public-manage', { method: 'POST', path: '/api/manage/cancel-plan', cookie: mcB, body: { plan_id: B.plan.id, refund_next: true } });
  assert.equal(r2.data.refunded, 0);
  assert.equal(r2.data.kept.date, '2026-11-03');
  const vb = await h.sql`select status, payment_status from visits where plan_id = ${B.plan.id} order by original_date`;
  assert.deepEqual(vb.map((v) => [v.status, v.payment_status]), [['scheduled', 'paid'], ['cancelled', 'due']]);
  const mail = h.svc.emails().filter((m) => m.to[0] === 'pb@example.com').at(-1);
  assert.match(mail.text, /already-paid clean on Tuesday 3 November, 2–4pm still goes ahead/);
});

test('P6-4 (automated half) update card opens a portal session limited to payment method update', async () => {
  const { customer } = await bookAndPay(h, '2026-11-25');
  const { manageSessionCookie } = await import('../../netlify/functions/lib/auth.mjs');
  const r = await h.call('public-manage', { method: 'POST', path: '/api/manage/portal', cookie: manageSessionCookie(customer.id).split(';')[0], body: {} });
  assert.equal(r.status, 200);
  const req = h.stripe.requests.filter((x) => x.path === '/v1/billing_portal/sessions').at(-1);
  assert.equal(req.body.flow_data.type, 'payment_method_update');
  assert.equal(req.body.configuration, 'bpc_test');
});

// ---------- Phase 7: money ----------
test('P7-1 money totals match Stripe for a test week (gross, fees, refunds)', async () => {
  h.setNow('2026-11-04T09:00:00Z'); // Wed
  await h.sql`delete from payments`;
  const a = await bookAndPay(h, '2026-11-10', { items: { 'household-3': 1 } });          // 2850
  const b = await bookAndPay(h, '2026-11-11', { plan: 'recurring', deep: true });       // 1350 + 1750
  const c = await bookAndPay(h, '2026-11-12', { items: { 'household-1': 1 } });          // 1250, refunded below
  await adm('admin-visits', `/api/admin/visits/${c.visit.id}/refund`, { method: 'POST', body: { cancel: true } });
  await h.sql`update payments set paid_at = '2026-11-04T08:30:00Z'`; // Stripe stamps real time; pin to the test clock
  const m = (await adm('admin-money', '/api/admin/money')).data;
  // Stripe's own numbers
  const charges = Object.values(h.stripe.db.charges).filter((x) => [a, b, c].some((k) => k.session.customer === x.customer));
  const gross = charges.reduce((t, x) => t + x.amount, 0);
  const fees = charges.reduce((t, x) => t + h.stripe.db.balance_transactions[x.balance_transaction].fee, 0);
  const refunds = charges.reduce((t, x) => t + x.amount_refunded, 0);
  assert.equal(m.collected.week.gross, gross);
  assert.equal(m.collected.week.fees, fees);
  assert.equal(m.collected.week.refunds, refunds);
  assert.equal(m.collected.week.net, gross - fees - refunds);
  assert.equal(m.collected.today.gross, gross);
  assert.equal(m.plans.active >= 1, true);
  assert.ok(m.plans.per_cycle >= 1350);
  assert.ok(m.scheduled_28.total > 0);
  assert.equal(m.recent.length, 3);
});

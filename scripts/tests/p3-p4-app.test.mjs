import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bookAndPay } from '../test-support/harness.mjs';

let h, cookie;
const NOW = '2026-11-02T10:00:00Z'; // Mon 2 Nov 2026
before(async () => { h = await setup(); h.setNow(NOW); cookie = await h.adminCookie(); });
after(async () => { await h.teardown(); });
beforeEach(() => { h.setNow(NOW); h.svc.reset(); });

const adm = (mod, path, opts = {}) => h.call(mod, { path, cookie, ...opts });

test('P3-1 admin APIs return 401 without a session', async () => {
  for (const [mod, path] of [['admin-today', '/api/admin/today'], ['admin-money', '/api/admin/money'], ['admin-customers', '/api/admin/customers'], ['admin-settings', '/api/admin/settings'], ['admin-blocks', '/api/admin/calendar'], ['admin-services', '/api/admin/services'], ['admin-visits', '/api/admin/visits/00000000-0000-0000-0000-000000000000']]) {
    const r = await h.call(mod, { path });
    assert.equal(r.status, 401, `${path} without session`);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  const forged = await h.call('admin-today', { path: '/api/admin/today', cookie: 'bf_session=9999999999|cGFzc2NvZGU|x.forged' });
  assert.equal(forged.status, 401);
});

test('P3-1 passcode sign-in works; wrong passcode refused; admin APIs only answer on the app host', async () => {
  const bad = await h.call('admin-auth', { method: 'POST', path: '/api/admin/session', body: { passcode: 'nope' } });
  assert.equal(bad.status, 401);
  const ok = await h.call('admin-auth', { method: 'POST', path: '/api/admin/session', body: { passcode: 'letmein' } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /bf_session=.*HttpOnly; Secure; SameSite=Lax/);
  const me = await h.call('admin-auth', { path: '/api/admin/session', cookie: ok.cookie });
  assert.equal(me.data.authed, true);
  assert.equal((await h.call('admin-today', { path: '/api/admin/today', cookie: ok.cookie })).status, 200);
  assert.equal((await h.call('admin-today', { path: '/api/admin/today', cookie: ok.cookie, host: 'binfreshdevon.co.uk' })).status, 404, 'not on the marketing host');
  assert.equal((await h.call('admin-today', { path: '/api/admin/today', cookie: ok.cookie, host: 'app.binfreshdevon.co.uk' })).status, 200);
});

async function googleFlow(email) {
  const start = await h.call('google-oauth', { path: '/api/google/signin' });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  return h.call('google-oauth', { path: `/api/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(email)}`, cookie: start.cookie });
}

test('P3-1 Google sign-in: allowlisted email gets a session, others are refused', async () => {
  const no = await googleFlow('stranger@gmail.com');
  assert.equal(no.status, 302);
  assert.match(no.headers.get('location'), /#\/signin\?error=/);
  assert.ok(!(no.headers.get('set-cookie') || '').includes('bf_session='), 'no session for a stranger');
  const yes = await googleFlow('tom@binfreshdevon.co.uk');
  assert.match(yes.headers.get('location'), /#\/today$/);
  const sess = yes.headers.getSetCookie().find((c) => c.startsWith('bf_session='));
  assert.ok(sess);
  const me = await h.call('admin-auth', { path: '/api/admin/session', cookie: sess.split(';')[0] });
  assert.equal(me.data.actor, 'tom@binfreshdevon.co.uk');
  // state must match the cookie
  const start = await h.call('google-oauth', { path: '/api/google/signin' });
  const forged = await h.call('google-oauth', { path: '/api/google/callback?state=signin.-.forged&code=tom@binfreshdevon.co.uk', cookie: start.cookie });
  assert.match(forged.headers.get('location'), /error=/);
});

test('P3-3 Today: totals, done, skip, reorder', async () => {
  const day = '2026-11-03';
  const booked = [];
  for (let i = 0; i < 10; i++) booked.push(await bookAndPay(h, day, { window: i < 5 ? '14-16' : '16-18', items: { [`household-${1 + (i % 3)}`]: 1 } }));
  h.setNow('2026-11-03T09:00:00Z');
  let t = (await adm('admin-today', '/api/admin/today')).data;
  assert.equal(t.totals.total, 10);
  assert.equal(t.totals.done, 0);
  const expected = booked.reduce((a, b) => a + b.visit.amount_pence, 0);
  assert.equal(t.totals.expected_pence, expected);
  assert.deepEqual(t.windows.map((w) => w.visits.length), [5, 5]);
  const v0 = t.windows[0].visits[0];
  assert.ok(v0.address && v0.phone && v0.items_text);

  assert.equal((await adm('admin-visits', `/api/admin/visits/${v0.id}/done`, { method: 'POST', body: {} })).status, 200);
  const sk = await adm('admin-visits', `/api/admin/visits/${t.windows[0].visits[1].id}/skip`, { method: 'POST', body: { reason: 'Bins not out' } });
  assert.equal(sk.data.needs_decision, true, 'paid visit skipped -> move or refund');
  t = (await adm('admin-today', '/api/admin/today')).data;
  assert.equal(t.totals.done, 1);
  assert.equal(t.totals.total, 9, 'skipped visits leave the count');

  const ids = t.windows[1].visits.map((v) => v.id).reverse();
  await adm('admin-visits', '/api/admin/visits/reorder', { method: 'POST', body: { date: day, window: '16-18', ids } });
  t = (await adm('admin-today', '/api/admin/today')).data;
  assert.deepEqual(t.windows[1].visits.map((v) => v.id), ids, 'route order persists');

  // refund the skipped one
  const rf = await adm('admin-visits', `/api/admin/visits/${t.windows[0].visits.find((v) => v.status === 'skipped').id}/refund`, { method: 'POST', body: {} });
  assert.equal(rf.status, 200);
  assert.ok(rf.data.refunded_pence > 0);
});

test('P3-4 blocking a day with visits offers the move; moved customers are notified', async () => {
  const day = '2026-11-10'; // Tue
  const a = await bookAndPay(h, day, { name: 'Alice Moved', phone: '07700 900201' });
  const b = await bookAndPay(h, day, { window: '16-18', name: 'Bob Moved', phone: '07700 900202' });
  h.svc.reset();
  const first = await adm('admin-blocks', '/api/admin/blocks', { method: 'POST', body: { date: day, window: null, reason: 'Van in for MOT' } });
  assert.equal(first.data.conflicts.length, 2, 'shows the affected visits first');
  assert.equal((await h.sql`select count(*)::int as n from blocks where block_date = ${day}`)[0].n, 0, 'nothing blocked yet');
  const r = await adm('admin-blocks', '/api/admin/blocks', { method: 'POST', body: { date: day, window: null, reason: 'Van in for MOT', move: true } });
  assert.equal(r.data.moved.length, 2);
  const vs = await h.sql`select * from visits where id in (${a.visit.id}, ${b.visit.id}) order by time_window`;
  for (const v of vs) {
    assert.equal(v.visit_date, '2026-11-11', 'nearest day, same week');
    assert.equal(v.original_date, day);
    assert.equal(v.moved_by_system, true);
  }
  assert.equal(h.svc.emails().filter((m) => m.subject.startsWith('Your clean has moved')).length, 2);
  assert.equal(h.svc.sms().length, 2);
  assert.match(h.svc.sms()[0].Body, /^Bin Fresh: your clean has moved from Tue 10 Nov to Wed 11 Nov/);
  const cal = await adm('admin-blocks', '/api/admin/calendar?week=2026-11-10');
  assert.equal(cal.data.days.find((d) => d.date === day).windows[0].cap, 0);
});

test('caps: a per-day override changes availability', async () => {
  await adm('admin-blocks', '/api/admin/caps', { method: 'POST', body: { date: '2026-11-13', window: '16-18', cap: 4 } });
  const av = await h.call('public-availability', { path: '/api/availability?from=2026-11-13&to=2026-11-13' });
  assert.equal(av.data.days[0].windows[1].left, 4);
  await adm('admin-blocks', '/api/admin/caps', { method: 'POST', body: { date: '2026-11-13', window: '16-18', cap: null } });
  assert.equal((await h.call('public-availability', { path: '/api/availability?from=2026-11-13&to=2026-11-13' })).data.days[0].windows[1].left, 6);
});

test('P4-1 visit generation is idempotent and fills exactly 8 weeks ahead', async () => {
  const { plan } = await bookAndPay(h, '2026-11-05', { plan: 'recurring' }); // Thu
  const { generateAll } = await import('../../netlify/functions/lib/jobs.mjs');
  const list = async () => (await h.sql`select original_date from visits where plan_id = ${plan.id} order by original_date`).map((r) => r.original_date);
  assert.deepEqual(await list(), ['2026-11-05', '2026-12-03']);
  await generateAll({ now: new Date(NOW) });
  await generateAll({ now: new Date(NOW) });
  assert.deepEqual(await list(), ['2026-11-05', '2026-12-03'], 'no duplicates');
  // a month later the window has moved on
  await generateAll({ now: new Date('2026-12-05T02:00:00Z') });
  assert.deepEqual(await list(), ['2026-11-05', '2026-12-03', '2026-12-31', '2027-01-28'], 'up to 30 Jan 2027 (5 Dec + 56 days)');
});

test('P4-2 a generated visit on a blocked day moves within 3 days and keeps its original_date', async () => {
  const { plan } = await bookAndPay(h, '2026-11-06', { plan: 'recurring', window: '16-18', name: 'Carol Plan' }); // Fri
  // Tom blocks the next cycle day (Fri 4 Dec) before it's generated... it already exists; block the one after
  await h.sql`insert into blocks (block_date, time_window, reason) values ('2027-01-01', null, 'New Year')`;
  h.svc.reset();
  const { generateAll } = await import('../../netlify/functions/lib/jobs.mjs');
  await generateAll({ now: new Date('2026-11-10T02:00:00Z') }); // horizon to 5 Jan 2027
  const [v] = await h.sql`select * from visits where plan_id = ${plan.id} and original_date = '2027-01-01'`;
  assert.ok(v, 'visit exists for the cycle date');
  assert.equal(v.visit_date, '2027-01-02', 'Sat 2 Jan: same ISO week, +1 day');
  assert.equal(v.time_window, '16-18');
  assert.equal(v.moved_by_system, true);
  assert.match(v.attention, /Moved by system from Fri 1 Jan/);
  assert.equal(h.svc.emails().filter((m) => m.subject.startsWith('Your clean has moved')).length, 1);
  assert.equal(h.svc.sms().length, 1);
  // billing still pays the moved visit, matched by original_date
  const inv = h.stripe.cycleInvoice(plan.stripe_subscription_id, Date.parse('2027-01-01T07:00:00Z') / 1000);
  await h.webhook('invoice.paid', inv);
  assert.equal((await h.sql`select payment_status from visits where id = ${v.id}`)[0].payment_status, 'paid');

  // moveCandidates prefers the same week, then the nearest day
  const { moveCandidates } = await import('../../netlify/functions/lib/booking.mjs');
  const { getSettings } = await import('../../netlify/functions/lib/db.mjs');
  const c = moveCandidates(await getSettings(), '2026-11-21', '14-16', { now: new Date(NOW) }); // Sat
  assert.deepEqual([...new Set(c.map((x) => x.date))], ['2026-11-23', '2026-11-24'], 'skips Sunday');
});

test('P4-3 failed recurring payment: visit flagged failed, Tom emailed once, red banner', async () => {
  await h.sql`insert into settings (key, value) values ('tom_alert_email', '"tom@binfreshdevon.co.uk"') on conflict (key) do update set value = excluded.value`;
  const { clearSettingsCache } = await import('../../netlify/functions/lib/db.mjs'); clearSettingsCache();
  const { plan } = await bookAndPay(h, '2026-11-07', { plan: 'recurring', name: 'Dan Failing' }); // Sat
  h.svc.reset();
  const t = Date.parse('2026-12-05T07:00:00Z') / 1000;
  const inv = h.stripe.cycleInvoice(plan.stripe_subscription_id, t, { fail: true });
  await h.webhook('invoice.payment_failed', inv);
  await h.webhook('invoice.payment_failed', inv); // Smart Retry
  const [v] = await h.sql`select * from visits where plan_id = ${plan.id} and original_date = '2026-12-05'`;
  assert.equal(v.payment_status, 'failed');
  const toTom = h.svc.emails().filter((m) => m.to[0] === 'tom@binfreshdevon.co.uk');
  assert.equal(toTom.length, 1, 'one email per failed visit, not per retry');
  assert.match(toTom[0].subject, /Payment failed: Dan Failing, Sat 5 Dec/);
  h.setNow('2026-12-05T08:00:00Z');
  const today = (await adm('admin-today', '/api/admin/today')).data;
  assert.equal(today.failed.length, 1);
  assert.equal(today.failed[0].name, 'Dan Failing');
  // a later successful retry clears it
  const ok = h.stripe.cycleInvoice(plan.stripe_subscription_id, t);
  await h.webhook('invoice.paid', ok);
  assert.equal((await h.sql`select payment_status from visits where id = ${v.id}`)[0].payment_status, 'paid');
});

test('P4-4 reminder SMS: once per visit, at 17:00 UK, correct across the clocks change', async () => {
  const { sendReminders } = await import('../../netlify/functions/lib/jobs.mjs');
  // GMT: visit Tue 17 Nov; 16:00Z is 16:00 UK (too early), 17:00Z is 17:00 UK.
  const { visit } = await bookAndPay(h, '2026-11-17', { name: 'Eve Reminder', phone: '07700 900555' });
  h.svc.reset();
  assert.equal((await sendReminders({ now: new Date('2026-11-16T16:00:00Z') })).skipped, 'not reminder time');
  const r = await sendReminders({ now: new Date('2026-11-16T17:00:00Z') });
  assert.equal(r.sent, 1);
  await sendReminders({ now: new Date('2026-11-16T18:00:00Z') });
  const sms = h.svc.sms().filter((m) => m.To === '+447700900555');
  assert.equal(sms.length, 1, 'sent once');
  assert.equal(sms[0].From, 'BinFresh');
  assert.match(sms[0].Body, /^Bin Fresh: we're cleaning your bins tomorrow \(Tue 17 Nov\) 2-4pm\. Please leave them out after collection\. Manage: https:\/\/binfreshdevon\.co\.uk\/m\/[A-Za-z0-9]{12}$/);
  assert.ok(sms[0].Body.length <= 160, `${sms[0].Body.length} chars`);
  assert.ok(/^[\x20-\x7E]+$/.test(sms[0].Body), 'GSM-7 safe');
  assert.ok((await h.sql`select reminder_sent_at from visits where id = ${visit.id}`)[0].reminder_sent_at);

  // BST: a visit on Mon 26 Oct 2026 (day after the change) — reminder Sun 25 Oct 17:00 GMT = 17:00Z.
  // And a visit on Sun-eve-before-change case: Sat 24 Oct 17:00 BST = 16:00Z.
  const { londonParts } = await import('../../netlify/functions/lib/time.mjs');
  assert.equal(londonParts(new Date('2026-10-24T16:00:00Z')).hh, 17, '16:00Z is 17:00 BST');
  assert.equal(londonParts(new Date('2026-10-25T17:00:00Z')).hh, 17, '17:00Z is 17:00 GMT');
  await h.sql`insert into visits (customer_id, original_date, visit_date, time_window, status, amount_pence, payment_status) values (${visit.customer_id}, '2026-10-26', '2026-10-26', '16-18', 'scheduled', 1250, 'paid')`;
  h.svc.reset();
  assert.equal((await sendReminders({ now: new Date('2026-10-25T16:00:00Z') })).skipped, 'not reminder time', '16:00 GMT');
  assert.equal((await sendReminders({ now: new Date('2026-10-25T17:00:00Z') })).sent, 1);
  assert.match(h.svc.sms()[0].Body, /tomorrow \(Mon 26 Oct\) 4-6pm/);
});

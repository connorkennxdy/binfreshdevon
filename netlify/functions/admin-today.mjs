// GET /api/admin/today?date=YYYY-MM-DD — the van screen.
import { admin, loadVisits } from './lib/admin.mjs';
import { db, getSettings } from './lib/db.mjs';
import { londonDate, londonToUtc, addDays, isDate, longDate, now, windowLabel } from './lib/time.mjs';
import { bad } from './lib/http.mjs';

export default admin(async ({ url }) => {
  const sql = db();
  const s = await getSettings();
  const today = londonDate(now());
  const date = url.searchParams.get('date') || today;
  if (!isDate(date)) throw bad('Bad date');
  const visits = await loadVisits(sql`v.visit_date = ${date} and v.status in ('scheduled','done','skipped')`);
  const from = londonToUtc(date, '00:00'), to = londonToUtc(addDays(date, 1), '00:00');
  const [{ collected }] = await sql`select coalesce(sum(amount_pence - coalesce(refunded_pence,0)),0)::int as collected from payments where paid_at >= ${from} and paid_at < ${to} and status <> 'failed'`;
  const counted = visits.filter((v) => v.status !== 'skipped');
  const failedToday = visits.filter((v) => v.payment_status === 'failed' && v.status === 'scheduled');
  const attention = await loadVisits(sql`v.status = 'scheduled' and v.visit_date >= ${today} and v.visit_date <= ${addDays(today, 14)} and v.attention is not null and v.attention not like 'Moved%' and v.attention not like 'Payment failed%'`);
  const [block] = await sql`select reason from blocks where block_date = ${date} and time_window is null limit 1`;
  return {
    date, date_long: longDate(date), is_today: date === today,
    windows: s.windows.map((w) => ({ id: w.id, label: windowLabel(w), visits: visits.filter((v) => v.window === w.id) })),
    totals: {
      done: visits.filter((v) => v.status === 'done').length, total: counted.length,
      expected_pence: counted.filter((v) => v.payment_status !== 'refunded').reduce((a, v) => a + v.amount_pence, 0),
      collected_pence: collected,
    },
    failed: failedToday.map((v) => ({ id: v.id, name: v.name, amount_pence: v.amount_pence })),
    attention: attention.map((v) => ({ id: v.id, name: v.name, date_short: v.date_short, window_label: v.window_label, attention: v.attention })),
    blocked: block ? block.reason || 'Blocked' : null,
  };
});

export const config = { path: '/api/admin/today', method: ['GET'] };

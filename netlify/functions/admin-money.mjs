// GET /api/admin/money — collected (gross / fees / refunds / net), scheduled income, plans, failed payments, recent payments.
import { admin, loadVisits } from './lib/admin.mjs';
import { db } from './lib/db.mjs';
import { addDays, isoWeekStart, londonDate, londonToUtc, now } from './lib/time.mjs';

export default admin(async () => {
  const sql = db();
  const today = londonDate(now());
  const [y, m] = today.split('-');
  const ranges = { today: today, week: isoWeekStart(today), month: `${y}-${m}-01`, year: `${y}-01-01` };
  const end = londonToUtc(addDays(today, 1), '00:00');
  const collected = {};
  for (const [k, from] of Object.entries(ranges)) {
    const [r] = await sql`select coalesce(sum(amount_pence),0)::int as gross, coalesce(sum(fee_pence),0)::int as fees,
                            coalesce(sum(refunded_pence),0)::int as refunds, count(*)::int as n,
                            count(*) filter (where fee_pence is null)::int as fee_pending
                          from payments where status <> 'failed' and paid_at >= ${londonToUtc(from, '00:00')} and paid_at < ${end}`;
    collected[k] = { ...r, net: r.gross - r.fees - r.refunds };
  }
  const [sched] = await sql`select coalesce(sum(amount_pence),0)::int as total,
                              coalesce(sum(amount_pence) filter (where payment_status in ('due','unpaid','failed')),0)::int as to_collect,
                              count(*)::int as visits
                            from visits where status = 'scheduled' and visit_date >= ${today} and visit_date < ${addDays(today, 28)}`;
  const [plans] = await sql`select count(distinct p.id)::int as active, coalesce(sum(pi.qty * pi.unit_price_pence),0)::int as per_cycle
                            from plans p join plan_items pi on pi.plan_id = p.id where p.status = 'active'`;
  const failed = await loadVisits(sql`v.payment_status = 'failed' and v.status in ('scheduled','skipped') and v.visit_date >= ${addDays(today, -60)}`);
  const recent = await sql`select p.amount_pence, p.fee_pence, p.refunded_pence, p.status, p.paid_at, c.name, c.id as customer_id
                           from payments p join customers c on c.id = p.customer_id order by p.paid_at desc limit 30`;
  return {
    collected, scheduled_28: sched, plans,
    failed: failed.map((v) => ({ visit_id: v.id, customer_id: v.customer_id, name: v.name, amount_pence: v.amount_pence, date_short: v.date_short })),
    recent,
  };
});

export const config = { path: '/api/admin/money', method: ['GET'] };

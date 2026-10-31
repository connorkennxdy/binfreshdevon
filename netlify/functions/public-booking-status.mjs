// GET /api/booking-status?session_id=cs_... — what the confirmation page shows.
import { handler, json, bad } from './lib/http.mjs';
import { db, getSettings } from './lib/db.mjs';
import { visitItems } from './lib/booking.mjs';
import { describeItems } from './lib/catalogue.mjs';
import { windowById } from './lib/availability.mjs';
import { longDate, windowLabel } from './lib/time.mjs';

export default handler(async (req) => {
  const sid = new URL(req.url).searchParams.get('session_id') || '';
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sid)) throw bad('Invalid session');
  const sql = db();
  let [v] = await sql`select v.*, c.name from visits v join customers c on c.id = v.customer_id where v.stripe_checkout_session_id = ${sid}`;
  let planConfirm = false;
  if (!v) {
    const [p] = await sql`select p.*, c.name from plans p join customers c on c.id = p.customer_id where p.stripe_checkout_session_id = ${sid}`;
    if (!p) return json({ status: 'unknown' });
    planConfirm = true;
    if (p.status === 'pending') return json({ status: 'pending' });
    [v] = await sql`select v.*, ${p.name} as name from visits v where v.plan_id = ${p.id} order by visit_date limit 1`;
    if (!v) return json({ status: 'pending' });
  }
  if (v.status === 'held') return json({ status: 'pending' });
  const s = await getSettings();
  const items = await visitItems(v.id);
  let recurring = 0;
  if (v.plan_id) [{ t: recurring }] = await sql`select coalesce(sum(qty*unit_price_pence),0)::int as t from plan_items where plan_id = ${v.plan_id}`;
  return json({
    status: v.status === 'scheduled' || v.status === 'done' ? 'confirmed' : v.status,
    first_name: String(v.name).split(/\s+/)[0],
    date: v.visit_date, date_label: longDate(v.visit_date),
    window_label: windowLabel(windowById(s, v.time_window) || { start: '14:00', end: '16:00' }),
    items: describeItems(items),
    paid_pence: planConfirm ? 0 : v.amount_pence,
    recurring_pence: recurring,
    plan: !!v.plan_id, plan_confirm: planConfirm,
  });
});

export const config = { path: '/api/booking-status', method: ['GET'] };

// Services and prices (§5.1).
//   GET   /api/admin/services
//   PATCH /api/admin/services/:slug {name, price_one_off_pence, price_recurring_pence, online_bookable, active}
//   POST  /api/admin/services/:slug/apply-existing   move existing plans to the current price with 14 days' notice
import { admin } from './lib/admin.mjs';
import { db } from './lib/db.mjs';
import { HttpError, bad } from './lib/http.mjs';
import { stripe } from './lib/stripe.mjs';
import { seed } from './lib/stripe-catalogue.mjs';
import { priceChangeNotice } from './lib/notify.mjs';
import { addDays, londonDate, now } from './lib/time.mjs';

const pence = (v) => (v === null || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 100000 ? Number(v) : NaN);

export default admin(async ({ parts, body, method }) => {
  const sql = db();
  if (method === 'GET' && !parts[1]) {
    const services = await sql`select s.*, (select count(*)::int from plan_items pi join plans p on p.id = pi.plan_id where pi.service_id = s.id and p.status in ('active','paused')) as plans_using,
       (select count(*)::int from plan_items pi join plans p on p.id = pi.plan_id where pi.service_id = s.id and p.status in ('active','paused') and pi.unit_price_pence <> s.price_recurring_pence) as plans_on_old_price
       from services s order by sort`;
    return { services };
  }
  const [s] = await sql`select * from services where slug = ${parts[1] || ''}`;
  if (!s) throw new HttpError(404, 'Service not found');
  if (method === 'PATCH') {
    const one = body.price_one_off_pence === undefined ? s.price_one_off_pence : pence(body.price_one_off_pence);
    const rec = body.price_recurring_pence === undefined ? s.price_recurring_pence : pence(body.price_recurring_pence);
    if (Number.isNaN(one) || Number.isNaN(rec)) throw bad('Prices must be whole pence.');
    if (s.category === 'addon' && rec != null) throw bad('Add-ons are one-off only.');
    const name = body.name ? String(body.name).slice(0, 60) : s.name;
    await sql`update services set name = ${name}, price_one_off_pence = ${one}, price_recurring_pence = ${rec},
      online_bookable = ${body.online_bookable === undefined ? s.online_bookable : body.online_bookable === true},
      active = ${body.active === undefined ? s.active : body.active === true} where id = ${s.id}`;
    const report = await seed({ stripe: stripe(), sql, log: () => {}, slug: s.slug });
    return { ok: true, stripe: report };
  }
  if (method === 'POST' && parts[2] === 'apply-existing') {
    if (s.price_recurring_pence == null || !s.stripe_price_recurring) throw bad('This service has no 4-weekly price.');
    const effective = addDays(londonDate(now()), 14);
    const affected = await sql`select distinct p.customer_id, pi.unit_price_pence as old from plan_items pi join plans p on p.id = pi.plan_id
                               where pi.service_id = ${s.id} and p.status in ('active','paused') and pi.unit_price_pence <> ${s.price_recurring_pence}`;
    await sql`insert into price_changes (service_id, new_recurring_pence, new_stripe_price, effective_date, notified_at) values (${s.id}, ${s.price_recurring_pence}, ${s.stripe_price_recurring}, ${effective}, now())`;
    for (const a of affected) {
      const [c] = await sql`select * from customers where id = ${a.customer_id}`;
      const items = await sql`select pi.qty, pi.unit_price_pence, pi.service_id from plan_items pi join plans p on p.id = pi.plan_id where p.customer_id = ${a.customer_id} and p.status in ('active','paused')`;
      const oldTotal = items.reduce((t, i) => t + i.qty * i.unit_price_pence, 0);
      const newTotal = items.reduce((t, i) => t + i.qty * (i.service_id === s.id ? s.price_recurring_pence : i.unit_price_pence), 0);
      await priceChangeNotice({ customer: c, oldPence: oldTotal, newPence: newTotal, effectiveDate: effective });
    }
    return { ok: true, customers_notified: affected.length, effective_date: effective };
  }
  throw new HttpError(404, 'Not found');
});

export const config = { path: ['/api/admin/services', '/api/admin/services/*'] };

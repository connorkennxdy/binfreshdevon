// Demo data for the local preview (scripts/dev-local.mjs --seed-demo): a realistic day for Tom.
import { bookAndPay } from './harness.mjs';

const PEOPLE = [
  ['Jason Wonnacott', 'EX31 1AA', '14-16', 'recurring', { 'household-2': 1 }, 'Side gate, bins by the shed'],
  ['Steph Cleak', 'EX33 2BB', '14-16', 'recurring', { 'household-3': 1 }, null],
  ['Mark Pugsley', 'EX31 4CD', '14-16', 'one-off', { 'household-1': 1, 'household-360': 1 }, 'Gate code 4471'],
  ['Hannah Bright', 'EX34 9EF', '16-18', 'recurring', { 'household-2': 1 }, null],
  ['Dev Patel', 'EX39 3GH', '16-18', 'one-off', { 'household-2': 1 }, 'Bins round the back'],
  ['Lucy Tapp', 'EX32 7JK', '16-18', 'recurring', { 'household-1': 1 }, null],
];
export async function seedDemo(h) {
  const { londonDate, addDays, isoWeekday } = await import('../../netlify/functions/lib/time.mjs');
  let day = addDays(londonDate(new Date()), 1);
  if (isoWeekday(day) === 7) day = addDays(day, 1);
  for (const [name, pc, window, plan, items, access] of PEOPLE) {
    const r = await bookAndPay(h, day, { name, plan, window, items, email: name.split(' ')[0].toLowerCase() + '@example.com', phone: '07700 9' + String(Math.floor(Math.random() * 1e5)).padStart(5, '0') });
    await h.sql`update customers set postcode = ${pc}, access_notes = ${access} where id = ${r.customer.id}`;
  }
  // move them onto "today" so the Today screen has a round, and fail one payment
  const today = londonDate(new Date());
  if (isoWeekday(today) !== 7) await h.sql`update visits set visit_date = ${today} where visit_date = ${day}`;
  await h.sql`update visits set payment_status = 'failed', attention = 'Payment failed' where id = (select v.id from visits v join customers c on c.id = v.customer_id where c.name = 'Lucy Tapp' order by v.visit_date limit 1)`;
  await h.sql`insert into settings (key, value) values ('tom_alert_email', '"tom@binfreshdevon.co.uk"') on conflict (key) do update set value = excluded.value`;
}

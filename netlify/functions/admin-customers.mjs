// Customers and plans.
//   GET   /api/admin/customers?q=            search by name, postcode, phone, email
//   POST  /api/admin/customers               add (manual / Square migration) -> pending plan + "Confirm your plan" link
//   GET   /api/admin/customers/:id
//   PATCH /api/admin/customers/:id           edit details
//   POST  /api/admin/customers/:id/link      resend manage link (email)
//   POST  /api/admin/customers/:id/card-link send a card-update link (email + SMS)
//   POST  /api/admin/customers/:id/note
//   POST  /api/admin/plans/:id/pause | resume {date} | cancel {refund_next} | move {date}
import { admin, loadVisits } from './lib/admin.mjs';
import { db, getSettings } from './lib/db.mjs';
import { HttpError, bad } from './lib/http.mjs';
import { validateCustomer, createPlanConfirm, cancelPlan, pausePlan, resumePlan, movePlanCadence, planItems, ensureStripeCustomer } from './lib/booking.mjs';
import { describeItems } from './lib/catalogue.mjs';
import { manageLinkEmail, manageLink, sendEmail, sendSms } from './lib/notify.mjs';
import { syncMany } from './lib/calendar.mjs';
import { londonDate, addDays, now, windowLabel } from './lib/time.mjs';
import { windowById } from './lib/availability.mjs';

const UUID = /^[0-9a-f-]{36}$/;

export default admin(async ({ url, parts, body, method, actor }) => {
  const sql = db();
  if (parts[0] === 'plans') {
    const id = parts[1];
    if (!UUID.test(id || '')) throw new HttpError(404, 'Not found');
    const action = parts[2];
    if (action === 'pause') return pausePlan(id, actor);
    if (action === 'resume') return resumePlan(id, String(body.date || ''), actor);
    if (action === 'cancel') return cancelPlan(id, { actor, refundNext: body.refund_next === true });
    if (action === 'move') return movePlanCadence(id, String(body.date || ''), actor);
    throw new HttpError(404, 'Unknown action');
  }

  if (!parts[1]) {
    if (method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const digits = q.replace(/\D/g, '');
      const rows = await sql`
        select c.id, c.name, c.postcode, c.town, c.phone,
          (select p.status from plans p where p.customer_id = c.id and p.status in ('active','paused','pending') order by p.created_at desc limit 1) as plan_status,
          (select min(v.visit_date) from visits v where v.customer_id = c.id and v.status = 'scheduled' and v.visit_date >= ${londonDate(now())}) as next_visit,
          exists (select 1 from visits v where v.customer_id = c.id and v.payment_status = 'failed' and v.status = 'scheduled') as has_failed
        from customers c
        where ${q ? sql`(c.name ilike ${like} or c.postcode ilike ${like} or replace(c.postcode,' ','') ilike ${'%' + q.replace(/\s/g, '') + '%'} or c.email ilike ${like} ${digits.length >= 4 ? sql`or regexp_replace(c.phone, '\\D', '', 'g') like ${'%' + digits.slice(-9) + '%'}` : sql``})` : sql`true`}
        order by c.name limit 100`;
      return { customers: rows };
    }
    if (method === 'POST') {
      return createPlanConfirm({ customer: { ...body.customer, source: body.source === 'square-migration' ? 'square-migration' : 'manual' }, items: body.items, nextDate: body.next_date, window: body.window, actor });
    }
  }

  const id = parts[1];
  if (!UUID.test(id || '')) throw new HttpError(404, 'Not found');
  const [c] = await sql`select * from customers where id = ${id}`;
  if (!c) throw new HttpError(404, 'Customer not found');

  if (method === 'GET') {
    const s = await getSettings();
    const plans = await sql`select * from plans where customer_id = ${id} order by created_at desc`;
    const planOut = [];
    for (const p of plans) {
      const items = await planItems(p.id);
      planOut.push({ id: p.id, status: p.status, anchor_date: p.anchor_date, window: p.time_window, window_label: windowLabel(windowById(s, p.time_window) || { start: '14:00', end: '16:00' }),
        items: describeItems(items), price_pence: items.reduce((a, i) => a + i.qty * i.unit_price_pence, 0), cancelled_at: p.cancelled_at, created_at: p.created_at });
    }
    const today = londonDate(now());
    const upcoming = await loadVisits(sql`v.customer_id = ${id} and v.visit_date >= ${today} and v.status = 'scheduled'`);
    const history = await loadVisits(sql`v.customer_id = ${id} and (v.visit_date < ${today} or v.status in ('done','skipped','cancelled')) and v.status <> 'held'`);
    const payments = await sql`select p.amount_pence, p.fee_pence, p.refunded_pence, p.status, p.paid_at, v.visit_date from payments p left join visits v on v.id = p.visit_id where p.customer_id = ${id} order by p.paid_at desc limit 50`;
    const messages = await sql`select channel, template, status, at from message_log where customer_id = ${id} order by at desc limit 20`;
    return {
      customer: { id: c.id, name: c.name, email: c.email, phone: c.phone, address_line1: c.address_line1, address_line2: c.address_line2, town: c.town, postcode: c.postcode,
        access_notes: c.access_notes, collection_day: c.collection_day, notes: c.notes, source: c.source, created_at: c.created_at, has_stripe: !!c.stripe_customer_id },
      plans: planOut, upcoming, history: history.reverse().slice(0, 60), payments, messages,
    };
  }
  if (method === 'PATCH') {
    const v = validateCustomer({ ...c, ...body });
    await sql`update customers set name = ${v.name}, email = ${v.email}, phone = ${v.phone}, address_line1 = ${v.address_line1}, address_line2 = ${v.address_line2},
      town = ${v.town}, postcode = ${v.postcode}, access_notes = ${v.access_notes}, collection_day = ${v.collection_day} where id = ${id}`;
    if (c.stripe_customer_id) await ensureStripeCustomer({ ...c, ...v });
    // calendar events carry the address and phone: resync this customer's upcoming visits
    const ids = (await sql`update visits set calendar_synced_at = null where customer_id = ${id} and visit_date >= ${addDays(londonDate(now()), -1)} and status <> 'held' returning id`).map((r) => r.id);
    await syncMany(ids);
    return { ok: true };
  }
  const action = parts[2];
  if (method === 'POST' && action === 'link') { await manageLinkEmail({ customer: c }); return { ok: true }; }
  if (method === 'POST' && action === 'note') { await sql`update customers set notes = ${String(body.notes || '').slice(0, 1000) || null} where id = ${id}`; return { ok: true }; }
  if (method === 'POST' && action === 'card-link') {
    // Portal session URLs are short-lived, so we send the manage link; "Update card" there opens a fresh portal session.
    const first = c.name.split(/\s+/)[0];
    const link = await manageLink(c.id), slink = await manageLink(c.id, { short: true });
    await sendEmail({ to: c.email, subject: 'Please update your card for Bin Fresh', template: 'card_update',
      html: `<p>Hi ${first.replace(/[<>&"]/g, '')},</p><p>Your last Bin Fresh payment didn't go through. Please open your booking page and tap <strong>Update card</strong>:</p><p><a href="${link}">Update my card</a></p><p>Thanks, Tom</p>`,
      text: `Hi ${first}, your last Bin Fresh payment didn't go through. Open ${link} and tap Update card.`, customer_id: c.id });
    await sendSms({ to: c.phone, body: `Bin Fresh: your last payment didn't go through. Please update your card: ${slink}`, template: 'card_update', customer_id: c.id });
    return { ok: true };
  }
  throw new HttpError(404, 'Unknown action');
});

export const config = { path: ['/api/admin/customers', '/api/admin/customers/*', '/api/admin/plans/*'] };

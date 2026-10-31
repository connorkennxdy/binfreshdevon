// Visits:
//   GET  /api/admin/visits/:id
//   POST /api/admin/visits/:id/done | undo | skip {reason} | move {date, window, force} | refund | note {notes}
//   POST /api/admin/visits/reorder {date, window, ids: []}
import { admin, loadVisits } from './lib/admin.mjs';
import { db } from './lib/db.mjs';
import { HttpError, bad } from './lib/http.mjs';
import { rescheduleVisit, refundVisit } from './lib/booking.mjs';
import { syncVisitSafe } from './lib/calendar.mjs';
import { now, isDate } from './lib/time.mjs';

const UUID = /^[0-9a-f-]{36}$/;
const SKIP_REASONS = ['Rain', 'Bins not out', 'No access', 'Bins still full', 'Other'];

export default admin(async ({ parts, body, method, actor }) => {
  const sql = db();
  if (method === 'POST' && parts[1] === 'reorder') {
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => UUID.test(x)).slice(0, 50) : [];
    if (!isDate(body.date)) throw bad('Bad date');
    let i = 1;
    for (const id of ids) await sql`update visits set route_order = ${i++} where id = ${id} and visit_date = ${body.date} and time_window = ${body.window}`;
    return { ok: true };
  }
  const id = parts[1];
  if (!UUID.test(id || '')) throw new HttpError(404, 'Not found');
  const [v] = await sql`select * from visits where id = ${id}`;
  if (!v) throw new HttpError(404, 'Visit not found');
  if (method === 'GET') {
    const [view] = await loadVisits(sql`v.id = ${id}`);
    const payments = await sql`select amount_pence, fee_pence, refunded_pence, status, paid_at from payments where visit_id = ${id} order by paid_at`;
    return { visit: view, payments };
  }
  const action = parts[2];
  if (action === 'done') {
    if (!['scheduled', 'skipped'].includes(v.status)) throw bad('Only scheduled visits can be marked done.');
    await sql`update visits set status = 'done', completed_at = ${now()}, skip_reason = null where id = ${id}`;
  } else if (action === 'undo') {
    await sql`update visits set status = 'scheduled', completed_at = null, skip_reason = null where id = ${id} and status in ('done','skipped')`;
  } else if (action === 'skip') {
    const reason = SKIP_REASONS.includes(body.reason) ? body.reason : String(body.reason || 'Other').slice(0, 60);
    await sql`update visits set status = 'skipped', skip_reason = ${reason} where id = ${id} and status = 'scheduled'`;
    await syncVisitSafe(id);
    // A skipped paid visit needs a decision: move it or refund it.
    return { ok: true, needs_decision: v.payment_status === 'paid' };
  } else if (action === 'move') {
    if (v.status === 'skipped') await sql`update visits set status = 'scheduled', skip_reason = null where id = ${id}`;
    const nv = await rescheduleVisit(id, String(body.date), String(body.window), { by: actor, force: body.force === true });
    if (body.notify !== false) {
      const { visitMoved } = await import('./lib/notify.mjs');
      const [customer] = await sql`select * from customers where id = ${v.customer_id}`;
      await visitMoved({ customer, visit: nv, fromDate: v.visit_date, fromWindow: v.time_window, reason: body.reason || 'We had to move your clean' });
    }
    return { ok: true, date: nv.visit_date, window: nv.time_window };
  } else if (action === 'refund') {
    const amount = await refundVisit(id, { actor, cancel: v.status === 'skipped' || body.cancel === true });
    return { ok: true, refunded_pence: amount };
  } else if (action === 'note') {
    await sql`update visits set notes = ${String(body.notes || '').slice(0, 500) || null} where id = ${id}`;
  } else if (action === 'clear-flag') {
    await sql`update visits set attention = null where id = ${id}`;
  } else throw new HttpError(404, 'Unknown action');
  await syncVisitSafe(id);
  return { ok: true };
});

export const config = { path: ['/api/admin/visits/*'] };

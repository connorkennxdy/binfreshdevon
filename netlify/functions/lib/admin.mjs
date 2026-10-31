// Shared plumbing for Tom's app APIs: host check, session, audit, and visit views.
import { handler, adminJson, readJson, requireAppHost } from './http.mjs';
import { requireAdmin } from './auth.mjs';
import { db, getSettings, audit } from './db.mjs';
import { windowById } from './availability.mjs';
import { windowLabel, shortDate, longDate } from './time.mjs';
import { describeItems } from './catalogue.mjs';

// fn({ req, url, parts, body, actor, method }) -> object | Response
export function admin(fn) {
  return handler(async (req, context) => {
    requireAppHost(req);
    const session = requireAdmin(req);
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean);
    const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readJson(req) : {};
    const out = await fn({ req, url, parts, body, actor: session.actor, method: req.method, context });
    if (out instanceof Response) return out;
    if (req.method !== 'GET') await audit(session.actor, `${req.method} ${url.pathname}`, parts[0] || 'admin', parts[1] || null, redact(body));
    return adminJson(out ?? { ok: true });
  }, { admin: true });
}

function redact(b) {
  const out = {};
  for (const [k, v] of Object.entries(b || {})) out[k] = /email|phone|address|name|notes|access/i.test(k) ? '[redacted]' : v;
  return out;
}

export const VISIT_SELECT = (sql) => sql`
  select v.*, c.name, c.phone, c.email, c.address_line1, c.address_line2, c.town, c.postcode, c.access_notes, c.collection_day,
    coalesce((select json_agg(json_build_object('slug', s.slug, 'name', s.name, 'qty', vi.qty, 'unit', vi.unit_price_pence) order by s.sort)
              from visit_items vi join services s on s.id = vi.service_id where vi.visit_id = v.id), '[]'::json) as items
  from visits v join customers c on c.id = v.customer_id`;

export async function visitView(rows) {
  const s = await getSettings();
  return rows.map((v) => ({
    id: v.id, customer_id: v.customer_id, plan_id: v.plan_id,
    date: v.visit_date, original_date: v.original_date, date_short: shortDate(v.visit_date), date_long: longDate(v.visit_date),
    window: v.time_window, window_label: windowLabel(windowById(s, v.time_window) || { start: '14:00', end: '16:00' }),
    status: v.status, skip_reason: v.skip_reason, payment_status: v.payment_status, amount_pence: v.amount_pence,
    route_order: v.route_order, attention: v.attention, moved_by_system: v.moved_by_system, notes: v.notes,
    completed_at: v.completed_at,
    name: v.name, phone: v.phone, email: v.email,
    address: [v.address_line1, v.address_line2, v.town].filter(Boolean).join(', '), postcode: v.postcode,
    access_notes: v.access_notes, collection_day: v.collection_day,
    items: v.items, items_text: describeItems(v.items || []),
    calendar: v.google_event_id ? 'synced' : null,
  }));
}

export async function loadVisits(where) {
  const sql = db();
  const rows = await sql`${VISIT_SELECT(sql)} where ${where} order by v.visit_date, v.time_window, v.route_order nulls last, c.postcode, c.name`;
  return visitView(rows);
}

export { readJson };

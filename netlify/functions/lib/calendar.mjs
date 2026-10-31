// One-way sync: our visits -> a "Bin Fresh Rounds" calendar in Tom's Google account.
// Refresh token is stored AES-256-GCM encrypted (TOKEN_ENC_KEY) in settings.google_calendar.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env, appUrl } from './env.mjs';
import { db, getSettings, setSetting } from './db.mjs';
import { windowById } from './availability.mjs';
import { londonDate, addDays, now } from './time.mjs';
import { gbp } from './money.mjs';
import { shortItems, describeItems } from './catalogue.mjs';

const OAUTH = () => env('GOOGLE_OAUTH_BASE', 'https://oauth2.googleapis.com');
const API = () => env('GOOGLE_API_BASE', 'https://www.googleapis.com');
export const CALENDAR_SCOPE = () => env('GOOGLE_CALENDAR_SCOPE', 'https://www.googleapis.com/auth/calendar.app.created');
const COLOURS = { paid: '7', failed: '11', done: '8' }; // Peacock (teal), Tomato (red), Graphite (grey)

function key() {
  const k = Buffer.from(env('TOKEN_ENC_KEY'), 'base64');
  if (k.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 random bytes, base64');
  return k;
}
export function encrypt(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
export function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

let tokenCache = null;
export async function calendarConfig() {
  const s = await getSettings({ fresh: true });
  return s.google_calendar && s.google_calendar.refresh_enc ? s.google_calendar : null;
}

async function accessToken(cfg) {
  if (tokenCache && tokenCache.exp > Date.now() + 60000 && tokenCache.for === cfg.refresh_enc) return tokenCache.token;
  const r = await fetch(OAUTH() + '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'),
      refresh_token: decrypt(cfg.refresh_enc), grant_type: 'refresh_token',
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`google token ${r.status} ${d.error || ''}`);
    err.revoked = d.error === 'invalid_grant';
    if (err.revoked) await setSetting('google_calendar', { ...cfg, last_error: 'Access was revoked. Reconnect Google Calendar.', last_error_at: new Date().toISOString() });
    throw err;
  }
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000, for: cfg.refresh_enc };
  return d.access_token;
}

async function gapi(cfg, method, path, body) {
  const r = await fetch(API() + path, {
    method,
    headers: { authorization: `Bearer ${await accessToken(cfg)}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return { status: 204 };
  const d = await r.json().catch(() => ({}));
  return { status: r.status, data: d };
}

// After OAuth: store the token and create (or reuse) the "Bin Fresh Rounds" calendar.
export async function connectCalendar({ refreshToken, email }) {
  const cfg = { refresh_enc: encrypt(refreshToken), email, connected_at: new Date().toISOString() };
  tokenCache = null;
  const existing = (await getSettings({ fresh: true })).google_calendar;
  let calendarId = existing?.calendar_id || null;
  if (calendarId) {
    const r = await gapi(cfg, 'GET', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}`);
    if (r.status !== 200) calendarId = null;
  }
  if (!calendarId) {
    const r = await gapi(cfg, 'POST', '/calendar/v3/calendars', { summary: 'Bin Fresh Rounds', timeZone: 'Europe/London', description: 'Bin Fresh visits. Managed by app.binfreshdevon.co.uk; edits here are overwritten.' });
    if (r.status !== 200) throw new Error(`could not create calendar (${r.status})`);
    calendarId = r.data.id;
  }
  await setSetting('google_calendar', { ...cfg, calendar_id: calendarId });
  // Force every upcoming visit to resync into this calendar.
  await db()`update visits set google_event_id = null, calendar_synced_at = null where visit_date >= ${addDays(londonDate(now()), -7)}`;
  return calendarId;
}

export async function disconnectCalendar() {
  const cfg = await calendarConfig();
  if (cfg) {
    try { await fetch(OAUTH() + '/revoke?token=' + encodeURIComponent(decrypt(cfg.refresh_enc)), { method: 'POST' }); } catch { /* best effort */ }
  }
  tokenCache = null;
  await setSetting('google_calendar', { calendar_id: cfg?.calendar_id || null, disconnected_at: new Date().toISOString() });
}

async function loadVisit(id) {
  const sql = db();
  const [v] = await sql`
    select v.*, v.updated_at::text as updated_at_exact, c.name, c.phone, c.address_line1, c.address_line2, c.town, c.postcode, c.access_notes
    from visits v join customers c on c.id = v.customer_id where v.id = ${id}`;
  if (!v) return null;
  v.items = await sql`select s.slug, s.name, vi.qty from visit_items vi join services s on s.id = vi.service_id where vi.visit_id = ${id} order by s.sort`;
  return v;
}

function initialSurname(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || 'Customer';
  return `${parts[0][0].toUpperCase()}. ${parts[parts.length - 1]}`;
}

export function eventFor(v, settings) {
  const w = windowById(settings, v.time_window) || { start: '14:00', end: '16:00' };
  const unpaid = v.payment_status === 'failed';
  const title = `${shortItems(v.items) || 'Clean'} · ${initialSurname(v.name)} · ${v.postcode}${unpaid ? ' ⚠ UNPAID' : ''}`;
  const pay = { paid: 'Paid', due: 'Due (charged 7am on the billing day)', failed: 'PAYMENT FAILED', unpaid: 'Unpaid', refunded: 'Refunded' }[v.payment_status] || v.payment_status;
  const address = [v.address_line1, v.address_line2, v.town, v.postcode].filter(Boolean).join(', ');
  const description = [
    `Phone: ${v.phone}`,
    `Items: ${describeItems(v.items)}`,
    v.access_notes ? `Access: ${v.access_notes}` : null,
    `Payment: ${pay} (${gbp(v.amount_pence)})`,
    v.status === 'done' ? 'Status: Done' : v.status === 'skipped' ? `Status: Skipped${v.skip_reason ? ' (' + v.skip_reason + ')' : ''}` : null,
    v.notes ? `Notes: ${v.notes}` : null,
    '',
    `${appUrl()}/#/visit/${v.id}`,
  ].filter((x) => x !== null).join('\n');
  const colour = v.status === 'done' ? COLOURS.done : unpaid ? COLOURS.failed : v.payment_status === 'paid' ? COLOURS.paid : undefined;
  return {
    summary: title,
    location: address,
    description,
    start: { dateTime: `${v.visit_date}T${w.start}:00`, timeZone: 'Europe/London' },
    end: { dateTime: `${v.visit_date}T${w.end}:00`, timeZone: 'Europe/London' },
    ...(colour ? { colorId: colour } : {}),
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { bf_visit: v.id } },
  };
}

// Create / update / delete the event for one visit. Returns 'synced' | 'deleted' | 'skipped' | 'not_connected'.
export async function syncVisit(visitId) {
  const cfg = await calendarConfig();
  if (!cfg || !cfg.calendar_id) return 'not_connected';
  const sql = db();
  const v = await loadVisit(visitId);
  const cal = `/calendar/v3/calendars/${encodeURIComponent(cfg.calendar_id)}/events`;
  if (!v) return 'skipped';
  const shouldExist = ['scheduled', 'done', 'skipped'].includes(v.status);
  if (!shouldExist) {
    if (v.google_event_id) {
      const r = await gapi(cfg, 'DELETE', `${cal}/${encodeURIComponent(v.google_event_id)}`);
      if (![200, 204, 404, 410].includes(r.status)) throw new Error(`calendar delete ${r.status}`);
    }
    await sql`update visits set google_event_id = null, calendar_synced_at = ${v.updated_at_exact}::timestamptz where id = ${v.id}`;
    return 'deleted';
  }
  const settings = await getSettings();
  const body = eventFor(v, settings);
  let r;
  if (v.google_event_id) {
    r = await gapi(cfg, 'PUT', `${cal}/${encodeURIComponent(v.google_event_id)}`, body);
    if (r.status === 404 || r.status === 410) r = null;
  }
  if (!r) r = await gapi(cfg, 'POST', cal, body);
  if (r.status !== 200) throw new Error(`calendar upsert ${r.status}`);
  await sql`update visits set google_event_id = ${r.data.id}, calendar_synced_at = ${v.updated_at_exact}::timestamptz where id = ${v.id}`;
  return 'synced';
}

// For rows already deleted from the database.
export async function deleteEventSafe(eventId) {
  try {
    const cfg = await calendarConfig();
    if (!cfg?.calendar_id || !eventId) return;
    await gapi(cfg, 'DELETE', `/calendar/v3/calendars/${encodeURIComponent(cfg.calendar_id)}/events/${encodeURIComponent(eventId)}`);
  } catch (e) { console.error('event delete failed', e.message); }
}

// Never let a Google failure break a booking; the hourly reconcile picks it up.
export async function syncVisitSafe(visitId) {
  try { return await syncVisit(visitId); } catch (e) { console.error('calendar sync failed', visitId, e.message); return 'error'; }
}

export async function syncMany(ids) {
  const out = { synced: 0, deleted: 0, error: 0, not_connected: 0, skipped: 0 };
  for (const id of ids) { const r = await syncVisitSafe(id); out[r] = (out[r] || 0) + 1; }
  return out;
}

// Visits whose event is missing or older than the visit.
export async function staleVisitIds({ limit = 200 } = {}) {
  const from = addDays(londonDate(now()), -7);
  const rows = await db()`
    select id from visits
    where visit_date >= ${from}
      and status <> 'held'
      and (calendar_synced_at is null or calendar_synced_at < updated_at)
      and not (status = 'cancelled' and google_event_id is null and calendar_synced_at is not null)
    order by visit_date limit ${limit}`;
  return rows.map((r) => r.id);
}

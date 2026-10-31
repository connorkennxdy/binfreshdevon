// Postgres access (Supabase). One small pool per function instance.
// SUPABASE_DB_URL is the Supabase *transaction pooler* connection string (port 6543),
// which suits short-lived serverless functions. prepare:false is required by the pooler.
import postgres from 'postgres';
import { env } from './env.mjs';

let _sql = null;
export function db() {
  if (_sql) return _sql;
  const url = env('SUPABASE_DB_URL');
  if (!url) throw new Error('SUPABASE_DB_URL is not set');
  _sql = postgres(url, {
    prepare: false,
    max: Number(env('DB_POOL_MAX', '3')),
    idle_timeout: 20,
    connect_timeout: 10,
    types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } }, // keep dates as 'YYYY-MM-DD'
    onnotice: () => {},
  });
  return _sql;
}

export async function closeDb() { if (_sql) { await _sql.end({ timeout: 5 }); _sql = null; } }

// ----- settings (cached briefly per instance) -----
let cache = null, cacheAt = 0;
export const DEFAULTS = {
  windows: [{ id: '14-16', start: '14:00', end: '16:00', cap: 6 }, { id: '16-18', start: '16:00', end: '18:00', cap: 6 }],
  bookable_weekdays: [1, 2, 3, 4, 5, 6],
  postcode_districts: ['EX31', 'EX32', 'EX33', 'EX34', 'EX39'],
  booking_cutoff_time: '18:00',
  horizon_weeks: 6,
  reminder_time: '17:00',
  charge_time: '07:00',
  tom_alert_email: '',
  tom_mobile: '',
  sms_enabled: true,
  vat_registered: false,
};

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 15000) return cache;
  const rows = await db()`select key, value from settings`;
  const s = { ...DEFAULTS };
  for (const r of rows) s[r.key] = r.value;
  cache = s; cacheAt = Date.now();
  return s;
}
export function clearSettingsCache() { cache = null; }

export async function setSetting(key, value) {
  await db()`insert into settings (key, value) values (${key}, ${db().json(value)})
             on conflict (key) do update set value = excluded.value`;
  clearSettingsCache();
}

export async function audit(actor, action, entity, entityId, detail = {}) {
  try {
    await db()`insert into audit_log (actor, action, entity, entity_id, detail)
               values (${actor}, ${action}, ${entity}, ${entityId ? String(entityId) : null}, ${db().json(detail)})`;
  } catch (e) { console.error('audit failed', action, e.message); }
}

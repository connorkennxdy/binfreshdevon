// Booking rules (§2.1) and per-slot availability. Capacity is enforced atomically in Postgres
// (book_slot / move_slot); this module decides which dates are bookable at all and reports spaces left.
import { db, getSettings } from './db.mjs';
import { addDays, isoWeekday, londonDate, londonToUtc, now as clockNow, isDate, windowLabel, diffDays } from './time.mjs';

export function windowById(settings, id) { return settings.windows.find((w) => w.id === id) || null; }

export function windowStart(settings, date, windowId) {
  const w = windowById(settings, windowId);
  return londonToUtc(date, w ? w.start : '14:00');
}

// Why a date can't be booked by a customer (or null if it can, before capacity).
// opts.ignoreHorizon is used by reschedules, which are bounded by ±7 days instead.
export function dateRuleBlock(settings, date, { now = clockNow(), ignoreHorizon = false } = {}) {
  if (!isDate(date)) return 'invalid';
  const today = londonDate(now);
  if (!settings.bookable_weekdays.includes(isoWeekday(date))) return isoWeekday(date) === 7 ? 'sunday' : 'closed';
  if (date <= today) return 'past';
  const cutoff = londonToUtc(addDays(date, -1), settings.booking_cutoff_time || '18:00');
  if (now >= cutoff) return 'cutoff';
  if (!ignoreHorizon && diffDays(today, date) > settings.horizon_weeks * 7) return 'horizon';
  return null;
}

export function bookingRange(settings, now = clockNow()) {
  const today = londonDate(now);
  return { from: addDays(today, 1), to: addDays(today, settings.horizon_weeks * 7) };
}

// Slot usage for a date range in one query: [{date, wid, cap, used, blocked}]
export async function slotTable(from, to) {
  const sql = db();
  return sql`
    with d as (select generate_series(${from}::date, ${to}::date, interval '1 day')::date as day),
         w as (select w->>'id' as wid from settings s, jsonb_array_elements(s.value) w where s.key = 'windows')
    select to_char(d.day, 'YYYY-MM-DD') as date, w.wid as wid,
           slot_cap(d.day, w.wid) as cap, slot_used(d.day, w.wid) as used,
           exists (select 1 from blocks b where b.block_date = d.day and (b.time_window is null or b.time_window = w.wid)) as blocked
    from d cross join w order by d.day, w.wid`;
}

// Availability as the booking page sees it.
export async function availability(from, to, { now = clockNow(), ignoreHorizon = false } = {}) {
  const settings = await getSettings();
  const range = bookingRange(settings, now);
  if (!isDate(from)) from = range.from;
  if (!isDate(to)) to = range.to;
  if (diffDays(from, to) > 70) to = addDays(from, 70);
  if (to < from) return { days: [] };
  const rows = await slotTable(from, to);
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const rule = dateRuleBlock(settings, d, { now, ignoreHorizon });
    const slots = byDate.get(d) || [];
    const windows = settings.windows.map((w) => {
      const r = slots.find((x) => x.wid === w.id) || { cap: 0, used: 0, blocked: false };
      const left = rule ? 0 : Math.max(0, r.cap - r.used);
      return { id: w.id, label: windowLabel(w), start: w.start, end: w.end, cap: r.cap, left, blocked: !!r.blocked };
    });
    const allBlocked = windows.every((w) => w.blocked);
    const reason = rule || (allBlocked ? 'blocked' : windows.every((w) => w.left === 0) ? 'full' : null);
    days.push({ date: d, weekday: isoWeekday(d), bookable: !reason, reason, windows });
  }
  return { days };
}

export async function slotLeft(date, windowId, opts = {}) {
  const { days } = await availability(date, date, opts);
  const w = days[0]?.windows.find((x) => x.id === windowId);
  return { left: w ? w.left : 0, reason: days[0]?.reason || (w ? null : 'invalid') };
}

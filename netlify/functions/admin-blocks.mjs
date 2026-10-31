// Calendar, blocked dates and caps.
//   GET    /api/admin/calendar?week=YYYY-MM-DD   Mon–Sat, booked/cap per window, blocks
//   POST   /api/admin/blocks {date, window|null, reason, move}  -> if visits exist and !move: {conflicts}
//   DELETE /api/admin/blocks/:id
//   POST   /api/admin/caps {date, window, cap|null}
import { admin, loadVisits } from './lib/admin.mjs';
import { db, getSettings } from './lib/db.mjs';
import { HttpError, bad } from './lib/http.mjs';
import { slotTable } from './lib/availability.mjs';
import { systemMoveVisit } from './lib/booking.mjs';
import { addDays, isoWeekStart, londonDate, isDate, now, longDate, shortDate, windowLabel } from './lib/time.mjs';

export default admin(async ({ url, parts, body, method, actor }) => {
  const sql = db();
  const s = await getSettings();
  if (parts[0] === 'calendar' && method === 'GET') {
    const anchor = isDate(url.searchParams.get('week')) ? url.searchParams.get('week') : londonDate(now());
    const mon = isoWeekStart(anchor), sat = addDays(mon, 5);
    const slots = await slotTable(mon, sat);
    const blocks = await sql`select id, to_char(block_date,'YYYY-MM-DD') as date, time_window as window, reason from blocks where block_date between ${mon} and ${sat}`;
    const overrides = await sql`select to_char(cap_date,'YYYY-MM-DD') as date, time_window as window, cap from capacity_overrides where cap_date between ${mon} and ${sat}`;
    const days = [];
    for (let d = mon; d <= sat; d = addDays(d, 1)) {
      days.push({
        date: d, label: shortDate(d), long: longDate(d), is_today: d === londonDate(now()),
        bookable_day: s.bookable_weekdays.includes(new Date(d + 'T00:00:00Z').getUTCDay() || 7),
        blocks: blocks.filter((b) => b.date === d),
        windows: s.windows.map((w) => {
          const r = slots.find((x) => x.date === d && x.wid === w.id) || { cap: 0, used: 0, blocked: false };
          const o = overrides.find((x) => x.date === d && x.window === w.id);
          return { id: w.id, label: windowLabel(w), used: r.used, cap: r.cap, default_cap: w.cap, override: o ? o.cap : null, blocked: r.blocked };
        }),
      });
    }
    return { week: mon, prev: addDays(mon, -7), next: addDays(mon, 7), days };
  }
  if (parts[0] === 'blocks' && method === 'POST') {
    const date = String(body.date || ''), win = body.window || null;
    if (!isDate(date)) throw bad('Pick a date.');
    if (win && !s.windows.some((w) => w.id === win)) throw bad('Unknown window.');
    const affected = await loadVisits(sql`v.visit_date = ${date} and v.status = 'scheduled' ${win ? sql`and v.time_window = ${win}` : sql``}`);
    if (affected.length && body.move !== true && body.confirm !== true) {
      return { conflicts: affected.map((v) => ({ id: v.id, name: v.name, window_label: v.window_label, postcode: v.postcode })) };
    }
    const [blk] = await sql`insert into blocks (block_date, time_window, reason) values (${date}, ${win}, ${String(body.reason || '').slice(0, 120) || null}) returning id`;
    const moved = [], stuck = [];
    if (body.move === true) {
      for (const v of affected) {
        const r = await systemMoveVisit(v.id, { reason: body.reason ? `${body.reason}, so we can't make that day` : 'We can\'t make that day', actor });
        (r.moved ? moved : stuck).push({ id: v.id, name: v.name, ...r });
      }
    }
    return { ok: true, id: blk.id, moved, stuck };
  }
  if (parts[0] === 'blocks' && method === 'DELETE') {
    if (!/^[0-9a-f-]{36}$/.test(parts[1] || '')) throw new HttpError(404, 'Not found');
    await sql`delete from blocks where id = ${parts[1]}`;
    return { ok: true };
  }
  if (parts[0] === 'caps' && method === 'POST') {
    const date = String(body.date || ''), win = String(body.window || '');
    if (!isDate(date) || !s.windows.some((w) => w.id === win)) throw bad('Pick a day and window.');
    if (body.cap === null || body.cap === '' || body.cap === undefined) await sql`delete from capacity_overrides where cap_date = ${date} and time_window = ${win}`;
    else {
      const cap = Number(body.cap);
      if (!Number.isInteger(cap) || cap < 0 || cap > 30) throw bad('Cap must be 0–30.');
      await sql`insert into capacity_overrides (cap_date, time_window, cap) values (${date}, ${win}, ${cap}) on conflict (cap_date, time_window) do update set cap = excluded.cap`;
    }
    return { ok: true };
  }
  throw new HttpError(404, 'Not found');
});

export const config = { path: ['/api/admin/calendar', '/api/admin/blocks', '/api/admin/blocks/*', '/api/admin/caps'] };

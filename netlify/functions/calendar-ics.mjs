// GET /api/calendar.ics?k=<token> — secret read-only feed of upcoming visits, a fallback if Google access is ever revoked.
import { db, getSettings } from './lib/db.mjs';
import { hash } from './lib/http.mjs';
import { appUrl } from './lib/env.mjs';
import { addDays, londonDate, now } from './lib/time.mjs';
import { windowById } from './lib/availability.mjs';
import { shortItems } from './lib/catalogue.mjs';
import { timingSafeEqual } from 'node:crypto';

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = (line) => line.length <= 74 ? line : line.match(/.{1,74}/g).join('\r\n ');

export default async (req) => {
  const s = await getSettings({ fresh: true });
  const k = new URL(req.url).searchParams.get('k') || '';
  const ok = s.ics_token_hash && k && timingSafeEqual(Buffer.from(hash(k)), Buffer.from(s.ics_token_hash));
  if (!ok) return new Response('Not found', { status: 404 });
  const sql = db();
  const today = londonDate(now());
  const rows = await sql`select v.*, c.name, c.phone, c.address_line1, c.town, c.postcode, c.access_notes,
      coalesce((select json_agg(json_build_object('slug', sv.slug, 'name', sv.name, 'qty', vi.qty)) from visit_items vi join services sv on sv.id = vi.service_id where vi.visit_id = v.id), '[]'::json) as items
    from visits v join customers c on c.id = v.customer_id
    where v.visit_date between ${addDays(today, -14)} and ${addDays(today, 70)} and v.status in ('scheduled','done','skipped')`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bin Fresh Devon//Rounds//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Bin Fresh Rounds', 'X-WR-TIMEZONE:Europe/London',
    'BEGIN:VTIMEZONE', 'TZID:Europe/London',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:BST', 'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'TZNAME:GMT', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE'];
  for (const v of rows) {
    const w = windowById(s, v.time_window) || { start: '14:00', end: '16:00' };
    const d = v.visit_date.replace(/-/g, '');
    const parts = String(v.name).split(/\s+/);
    lines.push('BEGIN:VEVENT', `UID:${v.id}@binfreshdevon.co.uk`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/London:${d}T${w.start.replace(':', '')}00`, `DTEND;TZID=Europe/London:${d}T${w.end.replace(':', '')}00`,
      `SUMMARY:${esc(`${shortItems(v.items)} · ${parts.length > 1 ? parts[0][0] + '. ' + parts.at(-1) : parts[0]} · ${v.postcode}${v.payment_status === 'failed' ? ' ⚠ UNPAID' : ''}`)}`,
      `LOCATION:${esc([v.address_line1, v.town, v.postcode].join(', '))}`,
      `DESCRIPTION:${esc([`Phone: ${v.phone}`, v.access_notes ? `Access: ${v.access_notes}` : '', `Payment: ${v.payment_status}`, `${appUrl()}/#/visit/${v.id}`].filter(Boolean).join('\n'))}`,
      `STATUS:${v.status === 'skipped' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(fold).join('\r\n') + '\r\n', { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300', 'x-robots-tag': 'noindex' } });
};

export const config = { path: '/api/calendar.ics', method: ['GET'] };

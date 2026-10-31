// All business dates are Europe/London. Dates are 'YYYY-MM-DD' strings; instants are Date objects (UTC).
import { env, isTest } from './env.mjs';

export const TZ = 'Europe/London';

// Tests can pin the clock with BF_NOW (only honoured when BF_TEST_MODE=1).
export function now() {
  if (isTest() && env('BF_NOW')) return new Date(env('BF_NOW'));
  return new Date();
}

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function londonParts(d = now()) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second };
}

export const pad = (n) => String(n).padStart(2, '0');

export function londonDate(d = now()) {
  const p = londonParts(d);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function londonTime(d = now()) {
  const p = londonParts(d);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

export function addDays(date, n) {
  const t = new Date(date + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function diffDays(a, b) { // b - a in whole days
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// ISO weekday: Monday = 1 ... Sunday = 7
export function isoWeekday(date) {
  const w = new Date(date + 'T00:00:00Z').getUTCDay();
  return w === 0 ? 7 : w;
}

export function isoWeekStart(date) { return addDays(date, 1 - isoWeekday(date)); }

// The UTC instant of a London wall-clock time on a London date. Handles BST/GMT.
export function londonToUtc(date, hhmm = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = londonParts(new Date(guess));
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    const delta = target - shown;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LONG_DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(date) { // "Tue 4 Nov"
  const [, m, d] = date.split('-').map(Number);
  return `${DAYS[isoWeekday(date)]} ${d} ${MONTHS[m - 1]}`;
}
export function longDate(date) { // "Tuesday 4 November"
  const [, m, d] = date.split('-').map(Number);
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${LONG_DAYS[isoWeekday(date)]} ${d} ${full[m - 1]}`;
}

// "14:00" -> "2pm", "16:30" -> "4:30pm"
export function clock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ':' + pad(m) : ''}${h < 12 ? 'am' : 'pm'}`;
}
export function windowLabel(w) { // {start:'14:00', end:'16:00'} -> "2–4pm"
  const a = clock(w.start), b = clock(w.end);
  const sameHalf = a.slice(-2) === b.slice(-2);
  return `${sameHalf ? a.slice(0, -2) : a}–${b}`;
}

// Settings.
//   GET  /api/admin/settings
//   POST /api/admin/settings {key: value, ...}   validated subset
//   POST /api/admin/settings/test-sms | test-email | resync | disconnect-calendar | ics-token
import { randomBytes } from 'node:crypto';
import { admin } from './lib/admin.mjs';
import { db, getSettings, setSetting } from './lib/db.mjs';
import { HttpError, bad, hash } from './lib/http.mjs';
import { calendarConfig, disconnectCalendar, syncMany } from './lib/calendar.mjs';
import { sendSms, sendEmail, ukMobile } from './lib/notify.mjs';
import { addDays, londonDate, now, windowLabel } from './lib/time.mjs';
import { appUrl, env } from './lib/env.mjs';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export default admin(async ({ parts, body, method, actor }) => {
  const sql = db();
  if (method === 'GET') {
    const s = await getSettings({ fresh: true });
    const cfg = await calendarConfig();
    const [sync] = await sql`select max(calendar_synced_at) as last, count(*) filter (where calendar_synced_at is null or calendar_synced_at < updated_at)::int as stale
                             from visits where visit_date >= ${addDays(londonDate(now()), -7)} and status <> 'held'`;
    return {
      windows: s.windows.map((w) => ({ ...w, label: windowLabel(w) })),
      bookable_weekdays: s.bookable_weekdays, postcode_districts: s.postcode_districts, booking_cutoff_time: s.booking_cutoff_time,
      horizon_weeks: s.horizon_weeks, reminder_time: s.reminder_time, charge_time: s.charge_time,
      tom_alert_email: s.tom_alert_email, tom_mobile: s.tom_mobile, sms_enabled: s.sms_enabled, vat_registered: s.vat_registered,
      calendar: { connected: !!cfg, email: cfg?.email || null, calendar_id: s.google_calendar?.calendar_id || null, last_sync: sync.last, stale: sync.stale,
        last_error: s.google_calendar?.last_error || null, oauth_configured: !!env('GOOGLE_CLIENT_ID') },
      ics_enabled: !!s.ics_token_hash,
      integrations: { stripe: !!env('STRIPE_SECRET_KEY'), stripe_mode: env('STRIPE_SECRET_KEY').startsWith('sk_live') ? 'live' : 'test', resend: !!env('RESEND_API_KEY'), twilio: !!env('TWILIO_ACCOUNT_SID') },
      you: actor,
    };
  }
  const action = parts[1];
  if (!action) {
    const s = await getSettings({ fresh: true });
    if (body.windows) {
      const w = body.windows;
      if (!Array.isArray(w) || w.length !== s.windows.length) throw bad('Windows must keep the same slots.');
      const next = s.windows.map((cur) => {
        const n = w.find((x) => x.id === cur.id) || {};
        const out = { id: cur.id, start: n.start ?? cur.start, end: n.end ?? cur.end, cap: n.cap ?? cur.cap };
        if (!HHMM.test(out.start) || !HHMM.test(out.end) || out.start >= out.end) throw bad('Window times must be HH:MM with start before end.');
        if (!Number.isInteger(Number(out.cap)) || out.cap < 0 || out.cap > 30) throw bad('Caps must be 0–30.');
        out.cap = Number(out.cap);
        return out;
      });
      await setSetting('windows', next);
    }
    if (body.bookable_weekdays) {
      const d = [...new Set(body.bookable_weekdays.map(Number))].filter((x) => x >= 1 && x <= 6).sort();
      if (!d.length) throw bad('Pick at least one day.');
      await setSetting('bookable_weekdays', d); // Sunday (7) is never bookable
    }
    if (body.postcode_districts) {
      const d = [...new Set(body.postcode_districts.map((x) => String(x).toUpperCase().trim()))].filter((x) => /^[A-Z]{1,2}\d[A-Z\d]?$/.test(x));
      if (!d.length) throw bad('Add at least one postcode district, like EX31.');
      await setSetting('postcode_districts', d);
    }
    for (const k of ['booking_cutoff_time', 'reminder_time']) if (body[k] !== undefined) { if (!HHMM.test(body[k])) throw bad(`${k} must be HH:MM`); await setSetting(k, body[k]); }
    if (body.horizon_weeks !== undefined) { const n = Number(body.horizon_weeks); if (!Number.isInteger(n) || n < 1 || n > 26) throw bad('Horizon must be 1–26 weeks.'); await setSetting('horizon_weeks', n); }
    if (body.tom_alert_email !== undefined) { const e = String(body.tom_alert_email).trim(); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad('Alert email is not valid.'); await setSetting('tom_alert_email', e); }
    if (body.tom_mobile !== undefined) { const m = String(body.tom_mobile).trim(); if (m && !ukMobile(m)) throw bad('Enter a UK mobile number.'); await setSetting('tom_mobile', m ? ukMobile(m) : ''); }
    if (body.sms_enabled !== undefined) await setSetting('sms_enabled', body.sms_enabled === true);
    if (body.vat_registered !== undefined) await setSetting('vat_registered', body.vat_registered === true);
    return { ok: true };
  }
  if (action === 'test-sms') {
    const s = await getSettings({ fresh: true });
    if (!s.tom_mobile) throw bad('Add your mobile number first.');
    const r = await sendSms({ to: s.tom_mobile, body: 'Bin Fresh: test message from Bin Fresh Rounds. Reminders will look like this, from BinFresh.', template: 'test', force: true });
    if (r.error || r.skipped) throw bad(`SMS not sent: ${r.error || r.reason}`);
    return { ok: true };
  }
  if (action === 'test-email') {
    const s = await getSettings({ fresh: true });
    if (!s.tom_alert_email) throw bad('Add your alert email first.');
    const r = await sendEmail({ to: s.tom_alert_email, subject: 'Bin Fresh Rounds: test email', html: '<p>Emails from Bin Fresh Rounds are working.</p>', text: 'Emails from Bin Fresh Rounds are working.', template: 'test' });
    if (r.error || r.skipped) throw bad(`Email not sent: ${r.error || 'email is not configured'}`);
    return { ok: true };
  }
  if (action === 'resync') {
    const ids = (await sql`update visits set calendar_synced_at = null where visit_date >= ${addDays(londonDate(now()), -7)} and status <> 'held' returning id`).map((r) => r.id);
    return syncMany(ids.slice(0, 150)); // the hourly job picks up any remainder
  }
  if (action === 'disconnect-calendar') { await disconnectCalendar(); return { ok: true }; }
  if (action === 'ics-token') {
    const token = randomBytes(24).toString('base64url');
    await setSetting('ics_token_hash', hash(token));
    return { url: `${appUrl()}/api/calendar.ics?k=${token}` };
  }
  throw new HttpError(404, 'Unknown action');
});

export const config = { path: ['/api/admin/settings', '/api/admin/settings/*'] };

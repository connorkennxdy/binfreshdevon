// Email (Resend) and SMS (Twilio, alphanumeric sender "BinFresh"). Plain fetch, no SDKs.
// Every send is logged to message_log (IDs and template names only, no message bodies).
import { env, siteUrl, appUrl } from './env.mjs';
import { db, getSettings } from './db.mjs';
import { createManageToken } from './auth.mjs';
import { gbp } from './money.mjs';
import { shortDate, longDate, windowLabel } from './time.mjs';
import { windowById } from './availability.mjs';

const RESEND_BASE = () => env('RESEND_API_BASE', 'https://api.resend.com');
const TWILIO_BASE = () => env('TWILIO_API_BASE', 'https://api.twilio.com');

export function ukMobile(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (/^\+447\d{9}$/.test(d)) return d;
  if (/^447\d{9}$/.test(d)) return '+' + d;
  if (/^07\d{9}$/.test(d)) return '+44' + d.slice(1);
  return null;
}

async function log(entry) {
  try {
    await db()`insert into message_log (customer_id, visit_id, channel, template, status, provider_id, error)
      values (${entry.customer_id || null}, ${entry.visit_id || null}, ${entry.channel}, ${entry.template}, ${entry.status}, ${entry.provider_id || null}, ${entry.error || null})`;
  } catch (e) { console.error('message_log failed', e.message); }
}

export async function sendEmail({ to, subject, html, text, template, customer_id, visit_id, replyTo }) {
  const key = env('RESEND_API_KEY');
  if (!key || !to) { await log({ channel: 'email', template, status: 'skipped', customer_id, visit_id, error: !key ? 'no RESEND_API_KEY' : 'no recipient' }); return { skipped: true }; }
  try {
    const r = await fetch(RESEND_BASE() + '/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env('EMAIL_FROM', 'Bin Fresh Devon <bookings@binfreshdevon.co.uk>'),
        to: [to], subject, html, text,
        reply_to: replyTo || env('EMAIL_REPLY_TO') || undefined,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`resend ${r.status} ${d?.name || ''}`);
    await log({ channel: 'email', template, status: 'sent', provider_id: d.id, customer_id, visit_id });
    return { id: d.id };
  } catch (e) {
    await log({ channel: 'email', template, status: 'failed', error: e.message.slice(0, 200), customer_id, visit_id });
    return { error: e.message };
  }
}

export async function sendSms({ to, body, template, customer_id, visit_id, force = false }) {
  const settings = await getSettings();
  const num = ukMobile(to);
  const sid = env('TWILIO_ACCOUNT_SID'), tok = env('TWILIO_AUTH_TOKEN');
  const skip = !num ? 'not a UK mobile' : !sid || !tok ? 'twilio not configured' : (!settings.sms_enabled && !force) ? 'sms disabled' : null;
  if (skip) { await log({ channel: 'sms', template, status: 'skipped', error: skip, customer_id, visit_id }); return { skipped: true, reason: skip }; }
  try {
    const r = await fetch(`${TWILIO_BASE()}/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: env('TWILIO_SENDER_ID', 'BinFresh'), To: num, Body: body }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`twilio ${r.status} ${d?.code || ''}`);
    await log({ channel: 'sms', template, status: 'sent', provider_id: d.sid, customer_id, visit_id });
    return { id: d.sid };
  } catch (e) {
    await log({ channel: 'sms', template, status: 'failed', error: e.message.slice(0, 200), customer_id, visit_id });
    return { error: e.message };
  }
}

// ---------- templates ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

function layout(title, bodyHtml) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#F6F5F1;font-family:Figtree,-apple-system,'Segoe UI',Arial,sans-serif;color:#152C4E">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F1;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:4px">
<tr><td style="background:#152C4E;padding:18px 24px;border-radius:4px 4px 0 0"><img src="${siteUrl()}/assets/logo-white.png" alt="Bin Fresh Devon" width="140" style="display:block;height:auto;border:0"></td></tr>
<tr><td style="padding:28px 24px 8px;font-size:16px;line-height:1.55">${bodyHtml}</td></tr>
<tr><td style="padding:8px 24px 28px;font-size:13px;line-height:1.5;color:#5b6577">Bin Fresh Devon · North Devon wheelie bin cleaning<br>Questions? Reply to this email or call <a href="tel:+447394536053" style="color:#0A7F7A">07394 536053</a>.</td></tr>
</table></td></tr></table></body></html>`;
}
const btn = (href, label) => `<p style="margin:24px 0"><a href="${href}" style="display:inline-block;background:#0A7F7A;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:4px">${esc(label)}</a></p>`;
const rows = (pairs) => `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0">${pairs.map(([k, v]) =>
  `<tr><td style="padding:8px 0;border-top:1px solid #E7E5DE;color:#5b6577;font-size:14px;width:40%">${esc(k)}</td><td style="padding:8px 0;border-top:1px solid #E7E5DE;font-size:14px;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>`;

async function slotText(date, windowId) {
  const s = await getSettings();
  const w = windowById(s, windowId) || { start: '14:00', end: '16:00' };
  return { date: longDate(date), short: shortDate(date), window: windowLabel(w), smsWindow: windowLabel(w).replace('–', '-') };
}

export async function manageLink(customerId, { short = false } = {}) {
  return `${siteUrl()}/m/${await createManageToken(customerId, { short })}`;
}

const LEAVE_OUT = 'Please leave your bins out after the council collection, lids unlocked, with nothing inside. If they are behind a gate, make sure we can get to them.';

export async function bookingConfirmed({ customer, visit, itemsText, plan, firstPence, recurringPence }) {
  const t = await slotText(visit.visit_date, visit.time_window);
  const link = await manageLink(customer.id);
  const planLine = plan
    ? `Then ${gbp(recurringPence)} is taken from your card on the morning of each clean, every 4 weeks. Cancel or reschedule free up to 24 hours before a clean.`
    : 'Cancel or reschedule free up to 24 hours before your clean.';
  const html = layout('Booking confirmed', `<h1 style="font-size:22px;margin:0 0 12px">You're booked in, ${esc(firstName(customer.name))}.</h1>
<p style="margin:0">We'll clean your bins on <strong>${esc(t.date)}, ${esc(t.window)}</strong>.</p>
${rows([['What', itemsText], ['When', `${t.date}, ${t.window}`], ['Where', `${customer.address_line1}, ${customer.postcode}`], ['Paid today', gbp(firstPence)], ...(plan ? [['Every 4 weeks', gbp(recurringPence)]] : [])])}
<p style="margin:0 0 8px">${esc(planLine)}</p>
<p style="margin:0"><strong>Before we arrive:</strong> ${esc(LEAVE_OUT)}</p>
${btn(link, 'Manage your booking')}
<p style="font-size:13px;color:#5b6577;margin:0">Your card receipt comes separately from Stripe. We'll text you the day before.</p>`);
  const text = `You're booked in, ${firstName(customer.name)}.\n\n${itemsText}\n${t.date}, ${t.window}\n${customer.address_line1}, ${customer.postcode}\nPaid today: ${gbp(firstPence)}${plan ? `\nEvery 4 weeks: ${gbp(recurringPence)}` : ''}\n\n${planLine}\n\nBefore we arrive: ${LEAVE_OUT}\n\nManage your booking: ${link}`;
  return sendEmail({ to: customer.email, subject: `Booked: ${t.short}, ${t.window}`, html, text, template: 'booking_confirmed', customer_id: customer.id, visit_id: visit.id });
}

// Day-before reminder. Kept under 160 GSM-7 characters (hyphen, not en dash).
export function reminderText(shortDateStr, smsWindow, link) {
  return `Bin Fresh: we're cleaning your bins tomorrow (${shortDateStr}) ${smsWindow}. Please leave them out after collection. Manage: ${link}`;
}
export async function reminderSms({ customer, visit }) {
  const t = await slotText(visit.visit_date, visit.time_window);
  const link = await manageLink(customer.id, { short: true });
  return sendSms({ to: customer.phone, body: reminderText(t.short, t.smsWindow, link), template: 'reminder', customer_id: customer.id, visit_id: visit.id });
}

export async function visitMoved({ customer, visit, fromDate, fromWindow, reason }) {
  const a = await slotText(fromDate, fromWindow), b = await slotText(visit.visit_date, visit.time_window);
  const link = await manageLink(customer.id), slink = await manageLink(customer.id, { short: true });
  const html = layout('Your clean has moved', `<h1 style="font-size:22px;margin:0 0 12px">We've moved your clean, ${esc(firstName(customer.name))}.</h1>
<p style="margin:0">${esc(reason || 'We can\'t make that day')}, so your clean on <s>${esc(a.date)}, ${esc(a.window)}</s> is now on <strong>${esc(b.date)}, ${esc(b.window)}</strong>.</p>
<p>Your payment date doesn't change. If the new time doesn't suit, pick another below.</p>${btn(link, 'Choose a different time')}`);
  const text = `We've moved your clean from ${a.date}, ${a.window} to ${b.date}, ${b.window}. Your payment date doesn't change. Change it: ${link}`;
  await sendEmail({ to: customer.email, subject: `Your clean has moved to ${b.short}`, html, text, template: 'visit_moved', customer_id: customer.id, visit_id: visit.id });
  return sendSms({ to: customer.phone, body: `Bin Fresh: your clean has moved from ${a.short} to ${b.short} ${b.smsWindow}. Change it: ${slink}`, template: 'visit_moved', customer_id: customer.id, visit_id: visit.id });
}

export async function rescheduled({ customer, visit }) {
  const t = await slotText(visit.visit_date, visit.time_window);
  const link = await manageLink(customer.id);
  const html = layout('Clean rescheduled', `<h1 style="font-size:22px;margin:0 0 12px">Done. Your clean is now on ${esc(t.date)}, ${esc(t.window)}.</h1><p>${esc(LEAVE_OUT)}</p>${btn(link, 'Manage your booking')}`);
  return sendEmail({ to: customer.email, subject: `Rescheduled: ${t.short}, ${t.window}`, html, text: `Your clean is now on ${t.date}, ${t.window}. Manage: ${link}`, template: 'rescheduled', customer_id: customer.id, visit_id: visit.id });
}

export async function planCancelled({ customer, refundedPence, keptVisit }) {
  const kept = keptVisit ? await slotText(keptVisit.visit_date, keptVisit.time_window) : null;
  const lines = [
    'Your 4-weekly plan is cancelled. You won\'t be charged again.',
    refundedPence ? `We've refunded ${gbp(refundedPence)} for your next clean. It reaches your card in 5 to 10 days.` : null,
    kept ? `Your already-paid clean on ${kept.date}, ${kept.window} still goes ahead.` : null,
  ].filter(Boolean);
  const html = layout('Plan cancelled', `<h1 style="font-size:22px;margin:0 0 12px">Sorry to see you go, ${esc(firstName(customer.name))}.</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}<p>You can book again any time at <a href="${siteUrl()}/book" style="color:#0A7F7A">binfreshdevon.co.uk/book</a>.</p>`);
  return sendEmail({ to: customer.email, subject: 'Your Bin Fresh plan is cancelled', html, text: lines.join('\n'), template: 'plan_cancelled', customer_id: customer.id });
}

export async function visitCancelled({ customer, visit, refundedPence }) {
  const t = await slotText(visit.visit_date, visit.time_window);
  const msg = `Your clean on ${t.date}, ${t.window} is cancelled.${refundedPence ? ` We've refunded ${gbp(refundedPence)}. It reaches your card in 5 to 10 days.` : ''}`;
  return sendEmail({ to: customer.email, subject: `Cancelled: ${t.short}`, html: layout('Clean cancelled', `<p>${esc(msg)}</p>`), text: msg, template: 'visit_cancelled', customer_id: customer.id, visit_id: visit.id });
}

export async function manageLinkEmail({ customer }) {
  const link = await manageLink(customer.id);
  const html = layout('Your manage link', `<h1 style="font-size:22px;margin:0 0 12px">Here's your link, ${esc(firstName(customer.name))}.</h1><p>Use it to see your cleans, reschedule, cancel or update your card. It works for 90 days.</p>${btn(link, 'Manage your booking')}<p style="font-size:13px;color:#5b6577">Didn't ask for this? You can ignore this email.</p>`);
  return sendEmail({ to: customer.email, subject: 'Your Bin Fresh manage link', html, text: `Manage your booking: ${link}`, template: 'manage_link', customer_id: customer.id });
}

export async function planConfirmRequest({ customer, url, nextDate, windowId, recurringPence, itemsText }) {
  const t = await slotText(nextDate, windowId);
  const html = layout('Confirm your plan', `<h1 style="font-size:22px;margin:0 0 12px">Hi ${esc(firstName(customer.name))}, we're moving bookings online.</h1>
<p>Your 4-weekly clean carries on as normal. To keep it going, add your card once below. Nothing is charged today.</p>
${rows([['Plan', itemsText], ['Next clean', `${t.date}, ${t.window}`], ['Every 4 weeks', gbp(recurringPence)]])}
<p>Your card is charged ${gbp(recurringPence)} on the morning of each clean. Cancel any time up to 24 hours before a clean.</p>${btn(url, 'Confirm your plan')}`);
  await sendEmail({ to: customer.email, subject: 'Please confirm your Bin Fresh plan', html, text: `Confirm your plan (next clean ${t.date}, ${t.window}, ${gbp(recurringPence)} every 4 weeks): ${url}`, template: 'plan_confirm', customer_id: customer.id });
  return sendSms({ to: customer.phone, body: `Bin Fresh: we've moved bookings online. Please add your card to keep your 4-weekly clean (next ${t.short}): ${url}`, template: 'plan_confirm', customer_id: customer.id });
}

export async function priceChangeNotice({ customer, oldPence, newPence, effectiveDate }) {
  const link = await manageLink(customer.id);
  const msg = `From your clean on or after ${longDate(effectiveDate)}, your 4-weekly price changes from ${gbp(oldPence)} to ${gbp(newPence)}.`;
  const html = layout('Price change', `<h1 style="font-size:22px;margin:0 0 12px">A note about your price, ${esc(firstName(customer.name))}.</h1><p>${esc(msg)}</p><p>Nothing else changes. If you'd rather stop, you can cancel any time up to 24 hours before a clean.</p>${btn(link, 'Manage your plan')}`);
  return sendEmail({ to: customer.email, subject: 'Your Bin Fresh price is changing', html, text: `${msg}\nManage: ${link}`, template: 'price_change', customer_id: customer.id });
}

// ----- to Tom -----
export async function tomPaymentFailed({ customer, visit, amountPence }) {
  const s = await getSettings();
  const to = s.tom_alert_email || env('TOM_ALERT_EMAIL');
  const t = await slotText(visit.visit_date, visit.time_window);
  const link = `${appUrl()}/#/customer/${customer.id}`;
  const msg = `Card payment failed: ${customer.name}, ${gbp(amountPence)} for the clean on ${t.date}, ${t.window}. Stripe will retry and has emailed them to update their card. You decide whether to clean.`;
  const html = layout('Payment failed', `<h1 style="font-size:20px;margin:0 0 12px">A payment failed</h1>${rows([['Customer', customer.name], ['Amount', gbp(amountPence)], ['Visit', `${t.date}, ${t.window}`], ['Address', `${customer.address_line1}, ${customer.postcode}`]])}<p>Stripe will retry automatically and has asked them to update their card. You decide whether to clean.</p>${btn(link, 'Open in Bin Fresh Rounds')}`);
  return sendEmail({ to, subject: `Payment failed: ${customer.name}, ${t.short}`, html, text: `${msg}\n${link}`, template: 'tom_payment_failed', customer_id: customer.id, visit_id: visit.id });
}

export async function tomAlert({ subject, lines, link }) {
  const s = await getSettings();
  const to = s.tom_alert_email || env('TOM_ALERT_EMAIL');
  const html = layout(subject, `<h1 style="font-size:20px;margin:0 0 12px">${esc(subject)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}${link ? btn(link, 'Open in Bin Fresh Rounds') : ''}`);
  return sendEmail({ to, subject, html, text: lines.join('\n') + (link ? `\n${link}` : ''), template: 'tom_alert' });
}

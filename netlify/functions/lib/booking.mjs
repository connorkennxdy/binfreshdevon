// Booking domain: checkout, Stripe events, the recurring engine, moves, reschedules, cancellations, refunds.
import { db, getSettings, audit } from './db.mjs';
import { stripe, invoiceSubscriptionId, invoicePlanId, invoicePaymentIntentId, invoiceRecurringPeriodStart, paymentDetails } from './stripe.mjs';
import { priceBooking, describeItems } from './catalogue.mjs';
import { dateRuleBlock, windowStart } from './availability.mjs';
import { addDays, londonDate, londonToUtc, isoWeekStart, isoWeekday, isDate, now as clockNow, diffDays, shortDate } from './time.mjs';
import { bad, HttpError } from './http.mjs';
import { siteUrl, appUrl } from './env.mjs';
import * as notify from './notify.mjs';
import { syncVisitSafe, deleteEventSafe } from './calendar.mjs';

export const HOLD_MINUTES = 31;          // Checkout sessions must live >= 30 minutes
export const HOLD_GRACE_MINUTES = 15;    // the slot hold outlives the session, so a payment in the last minute still has its slot
export const GENERATE_WEEKS = 8;
export const CYCLE_DAYS = 28;
const DAY_MS = 86400000;

// ---------- validation ----------
const POSTCODE_RE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/;
export function normalisePostcode(pc) {
  const m = String(pc || '').toUpperCase().replace(/\s+/g, ' ').trim().match(POSTCODE_RE);
  return m ? { full: `${m[1]} ${m[2]}`, district: m[1] } : null;
}
export async function inServiceArea(postcode) {
  const p = normalisePostcode(postcode);
  if (!p) return { ok: false, reason: 'invalid' };
  const s = await getSettings();
  return { ok: s.postcode_districts.map((d) => d.toUpperCase()).includes(p.district), reason: 'out_of_area', postcode: p.full, district: p.district };
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
export function validateCustomer(d) {
  const c = {
    name: clean(d.name, 80), email: clean(d.email, 120).toLowerCase(), phone: clean(d.phone, 20),
    address_line1: clean(d.address_line1, 120), address_line2: clean(d.address_line2, 120) || null,
    town: clean(d.town, 60), postcode: clean(d.postcode, 10).toUpperCase(),
    access_notes: clean(d.access_notes, 300) || null, collection_day: clean(d.collection_day, 20) || null,
  };
  if (!c.name) throw bad('Please enter your name.', 'name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw bad('Please enter a valid email address.', 'email');
  if (!notify.ukMobile(c.phone)) throw bad('Please enter a UK mobile number, like 07700 900123.', 'phone');
  if (!c.address_line1) throw bad('Please enter your address.', 'address_line1');
  if (!c.town) throw bad('Please enter your town.', 'town');
  const p = normalisePostcode(c.postcode);
  if (!p) throw bad('Please enter a full postcode, like EX31 1AA.', 'postcode');
  c.postcode = p.full;
  c.phone = notify.ukMobile(c.phone);
  return c;
}

// ---------- customers ----------
// Online bookings: a new email creates a customer; an existing email is reused UNCHANGED (anyone can type an
// email, so contact details from an unauthenticated form must not overwrite the record). What they typed is
// kept on the visit and applied once the booking is paid (address), or flagged for Tom (phone).
export async function customerForBooking(c) {
  const sql = db();
  const [existing] = await sql`select * from customers where lower(email) = ${c.email}`;
  if (existing) return { customer: existing, pending: c };
  const [row] = await sql`
    insert into customers (name, email, phone, address_line1, address_line2, town, postcode, access_notes, collection_day, source)
    values (${c.name}, ${c.email}, ${c.phone}, ${c.address_line1}, ${c.address_line2}, ${c.town}, ${c.postcode}, ${c.access_notes}, ${c.collection_day}, 'online')
    on conflict (lower(email)) do nothing returning *`;
  if (row) return { customer: row, pending: null };
  const [again] = await sql`select * from customers where lower(email) = ${c.email}`; // lost a race with a parallel booking
  return { customer: again, pending: c };
}

// After payment: apply the booking's address/access details; never the phone (that receives magic links).
async function applyBookingDetails(visit) {
  const d = visit.booking_details;
  if (!d) return;
  const sql = db();
  const [c] = await sql`select * from customers where id = ${visit.customer_id}`;
  await sql`update customers set address_line1 = ${d.address_line1}, address_line2 = ${d.address_line2 || null}, town = ${d.town}, postcode = ${d.postcode},
              access_notes = coalesce(${d.access_notes || null}, access_notes), collection_day = coalesce(${d.collection_day || null}, collection_day)
            where id = ${c.id}`;
  const phone = notify.ukMobile(d.phone);
  if (phone && phone !== c.phone) {
    await sql`update visits set attention = ${`New mobile given at booking: ${phone}. Check with the customer, then edit their record.`} where id = ${visit.id}`;
  }
  await sql`update visits set booking_details = null where id = ${visit.id}`;
  try { const [fresh] = await sql`select * from customers where id = ${c.id}`; if (fresh.stripe_customer_id) await ensureStripeCustomer(fresh); } catch (e) { console.error('stripe customer refresh failed', e.message); }
}

export async function upsertCustomer(c, source = 'online') {
  const sql = db();
  const [row] = await sql`
    insert into customers (name, email, phone, address_line1, address_line2, town, postcode, access_notes, collection_day, source)
    values (${c.name}, ${c.email}, ${c.phone}, ${c.address_line1}, ${c.address_line2}, ${c.town}, ${c.postcode}, ${c.access_notes}, ${c.collection_day}, ${source})
    on conflict (lower(email)) do update set
      name = excluded.name, phone = excluded.phone, address_line1 = excluded.address_line1, address_line2 = excluded.address_line2,
      town = excluded.town, postcode = excluded.postcode,
      access_notes = coalesce(excluded.access_notes, customers.access_notes),
      collection_day = coalesce(excluded.collection_day, customers.collection_day)
    returning *`;
  return row;
}

export async function ensureStripeCustomer(customer) {
  const sql = db();
  const s = stripe();
  const fields = {
    name: customer.name, email: customer.email, phone: customer.phone,
    address: { line1: customer.address_line1, line2: customer.address_line2 || undefined, city: customer.town, postal_code: customer.postcode, country: 'GB' },
    metadata: { bf_customer: customer.id },
  };
  if (customer.stripe_customer_id) {
    try { await s.customers.update(customer.stripe_customer_id, fields); return customer.stripe_customer_id; } catch (e) { if (e?.statusCode !== 404) throw e; }
  }
  const sc = await s.customers.create(fields, { idempotencyKey: `cust-${customer.id}` });
  await sql`update customers set stripe_customer_id = ${sc.id} where id = ${customer.id}`;
  return sc.id;
}

// ---------- checkout (§5.2) ----------
export async function createBookingCheckout(input, { now = clockNow() } = {}) {
  const sql = db();
  const settings = await getSettings();
  const area = await inServiceArea(input.postcode);
  if (!area.ok) throw new HttpError(422, area.reason === 'invalid' ? 'Please enter a full postcode, like EX31 1AA.' : 'We don\'t cover that area for online booking yet.', area.reason);
  const customerIn = validateCustomer({ ...input.customer, postcode: input.customer?.postcode || input.postcode });
  if (normalisePostcode(customerIn.postcode).district !== area.district) throw bad('The address postcode must match the postcode you checked.', 'postcode');

  const planType = input.plan === 'recurring' ? 'recurring' : input.plan === 'one-off' ? 'one-off' : null;
  const priced = await priceBooking(planType, input.items, !!input.deep_clean);
  const date = input.date, win = input.window;
  if (!settings.windows.some((w) => w.id === win)) throw bad('Choose a time window.', 'window');
  const rule = dateRuleBlock(settings, date, { now });
  if (rule) throw new HttpError(409, 'That date can\'t be booked any more. Please pick another.', 'date_' + rule);
  if (input.terms !== true) throw bad('Please agree to the terms.', 'terms');

  const { customer, pending } = await customerForBooking(customerIn);
  const stripeCustomer = await ensureStripeCustomer(customer);
  await expireOpenCheckouts(customer.id); // Fix: an older unpaid tab can't also be paid

  let planId = null;
  if (planType === 'recurring') {
    const [plan] = await sql`insert into plans (customer_id, status, anchor_date, time_window) values (${customer.id}, 'pending', ${date}, ${win}) returning id`;
    planId = plan.id;
    for (const l of priced.lines.filter((x) => x.kind === 'recurring')) {
      await sql`insert into plan_items (plan_id, service_id, qty, unit_price_pence) values (${planId}, ${l.service.id}, ${l.qty}, ${l.unit})`;
    }
  }
  const [{ book_slot: visitId }] = await sql`select book_slot(${customer.id}, ${planId}, ${date}, ${win}, ${date}, 'held', ${priced.firstPence}, 'unpaid', ${HOLD_MINUTES + HOLD_GRACE_MINUTES}, false)`;
  if (!visitId) {
    if (planId) await sql`delete from plans where id = ${planId}`;
    throw new HttpError(409, 'Sorry, that time has just filled up. Please pick another.', 'full');
  }
  for (const l of priced.lines) {
    await sql`insert into visit_items (visit_id, service_id, qty, unit_price_pence) values (${visitId}, ${l.service.id}, ${l.qty}, ${l.unit})`;
  }
  if (pending) await sql`update visits set booking_details = ${sql.json(pending)} where id = ${visitId}`;

  const missing = priced.lines.find((l) => !(l.kind === 'recurring' ? l.service.stripe_price_recurring && l.service.stripe_price_first_clean : l.service.stripe_price_one_off));
  if (missing) { await releaseHold(visitId); throw new HttpError(503, 'Online payment isn\'t set up for that service yet.', 'not_seeded'); }

  const expiresAt = Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60; // Stripe validates against real time, never the business clock
  const common = {
    customer: stripeCustomer,
    client_reference_id: visitId,
    metadata: { visit_id: visitId, plan_id: planId || '' },
    success_url: `${siteUrl()}/book/confirmed?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl()}/book/?resume=${encodeURIComponent(planType)}`,
    expires_at: expiresAt,
    locale: 'en-GB',
    customer_update: { name: 'never', address: 'never' },
    payment_method_types: ['card'], // card wallets included; no async methods that could fail after confirmation
  };
  let params;
  if (planType === 'one-off') {
    params = {
      ...common, mode: 'payment',
      line_items: priced.lines.map((l) => ({ price: l.service.stripe_price_one_off, quantity: l.qty })),
      payment_intent_data: { metadata: { visit_id: visitId }, description: `Bin clean ${date} ${win}` },
    };
  } else {
    const trialEnd = Math.floor(londonToUtc(addDays(date, CYCLE_DAYS), settings.charge_time || '07:00').getTime() / 1000);
    params = {
      ...common, mode: 'subscription',
      line_items: [
        ...priced.lines.filter((l) => l.kind === 'recurring').map((l) => ({ price: l.service.stripe_price_recurring, quantity: l.qty })),
        ...priced.lines.filter((l) => l.kind === 'recurring').map((l) => ({ price: l.service.stripe_price_first_clean, quantity: l.qty })),
        ...priced.lines.filter((l) => l.kind === 'addon').map((l) => ({ price: l.service.stripe_price_one_off, quantity: l.qty })),
      ],
      payment_method_collection: 'always',
      subscription_data: { trial_end: trialEnd, metadata: { plan_id: planId }, description: 'Bin Fresh 4-weekly clean' },
    };
  }
  let session;
  try {
    session = await stripe().checkout.sessions.create(params, { idempotencyKey: `checkout-${visitId}` });
  } catch (e) {
    await releaseHold(visitId);
    console.error('checkout create failed', visitId, e?.message);
    throw new HttpError(502, 'We couldn\'t start the payment. Please try again.', 'stripe');
  }
  await sql`update visits set stripe_checkout_session_id = ${session.id} where id = ${visitId}`;
  if (planId) await sql`update plans set stripe_checkout_session_id = ${session.id} where id = ${planId}`;
  return { url: session.url, session_id: session.id, visit_id: visitId };
}

async function expireOpenCheckouts(customerId) {
  const sql = db();
  const open = await sql`select id, stripe_checkout_session_id from visits where customer_id = ${customerId} and status = 'held' and stripe_checkout_session_id is not null`;
  for (const v of open) {
    try { await stripe().checkout.sessions.expire(v.stripe_checkout_session_id); }
    catch (e) { if (!/expire|status|complete/i.test(e?.message || '')) console.error('expire session failed', e?.message); continue; } // already completed: leave it for the webhook
    await releaseHold(v.id);
  }
}

export async function releaseHold(visitId) {
  const sql = db();
  const [v] = await sql`delete from visits where id = ${visitId} and status = 'held' returning plan_id`;
  if (v?.plan_id) await sql`delete from plans where id = ${v.plan_id} and status = 'pending'`;
}

// ---------- payments ----------
export async function recordPayment({ customerId, visitId, paymentIntentId, invoiceId, amount, status = 'succeeded', paidAt }) {
  if (!paymentIntentId) return;
  const sql = db();
  let fee = null, charge = null;
  try { ({ fee, charge } = await paymentDetails(paymentIntentId)); } catch (e) { console.error('fee lookup failed', paymentIntentId, e.message); }
  await sql`
    insert into payments (customer_id, visit_id, stripe_payment_intent_id, stripe_charge_id, stripe_invoice_id, amount_pence, fee_pence, status, paid_at)
    values (${customerId}, ${visitId}, ${paymentIntentId}, ${charge}, ${invoiceId || null}, ${amount}, ${fee}, ${status}, ${paidAt || clockNow()})
    on conflict (stripe_payment_intent_id) do update set
      visit_id = coalesce(excluded.visit_id, payments.visit_id),
      stripe_charge_id = coalesce(excluded.stripe_charge_id, payments.stripe_charge_id),
      fee_pence = coalesce(excluded.fee_pence, payments.fee_pence),
      status = excluded.status`;
}

// ---------- Stripe event handlers (§5.3) ----------
export async function onCheckoutCompleted(session) {
  const sql = db();
  const visitId = session.metadata?.visit_id;
  const planId = session.metadata?.plan_id || null;

  if (session.metadata?.kind === 'plan_confirm') return onPlanConfirmCompleted(session);
  if (!visitId) return 'ignored';
  let [visit] = await sql`select * from visits where id = ${visitId}`;
  if (!visit) {
    // Should not happen (holds outlive their sessions), but the customer has paid: restore the booking.
    console.error('checkout completed for missing visit', visitId);
    await tomAlertSafe('A paid booking needs checking', [`Stripe Checkout ${session.id} completed but its slot hold had gone. Check the Stripe dashboard and add the visit by hand.`]);
    return 'missing_visit';
  }
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  await sql`update visits set status = 'scheduled', hold_expires_at = null,
              payment_status = ${paid ? 'paid' : 'unpaid'},
              stripe_payment_intent_id = coalesce(${typeof session.payment_intent === 'string' ? session.payment_intent : null}, stripe_payment_intent_id),
              stripe_invoice_id = coalesce(${typeof session.invoice === 'string' ? session.invoice : null}, stripe_invoice_id)
            where id = ${visitId} and status in ('held','scheduled')`;
  if (paid) await applyBookingDetails(visit);
  [visit] = await sql`select * from visits where id = ${visitId}`;
  const [customer] = await sql`select * from customers where id = ${visit.customer_id}`;

  let plan = null;
  if (planId) {
    const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    [plan] = await sql`update plans set status = case when status = 'pending' then 'active' else status end,
                         stripe_subscription_id = coalesce(${subId}, stripe_subscription_id)
                       where id = ${planId} returning *`;
    if (subId) await storeSubscriptionItems(planId, subId);
    await generateVisitsForPlan(plan);
  }
  if (session.mode === 'payment' && paid) {
    await recordPayment({ customerId: customer.id, visitId, paymentIntentId: visit.stripe_payment_intent_id, amount: session.amount_total, paidAt: new Date((session.created || Date.now() / 1000) * 1000) });
  }
  if (session.mode === 'subscription' && typeof session.invoice === 'string') {
    try { await recordInvoicePayment(await stripe().invoices.retrieve(session.invoice, { expand: ['payments'] }), visit); } catch (e) { console.error('first invoice lookup failed', e.message); }
  }
  await syncVisitSafe(visitId);
  const items = await visitItems(visitId);
  const recurringPence = plan ? (await sql`select coalesce(sum(qty * unit_price_pence),0)::int as t from plan_items where plan_id = ${plan.id}`)[0].t : 0;
  // Only email once even if Stripe redelivers under a different event id.
  const [already] = await sql`select 1 from message_log where visit_id = ${visitId} and template = 'booking_confirmed' and status = 'sent' limit 1`;
  if (!already) await notify.bookingConfirmed({ customer, visit, itemsText: describeItems(items), plan, firstPence: visit.amount_pence, recurringPence });
  return 'ok';
}

export async function onCheckoutExpired(session) {
  if (session.metadata?.kind === 'plan_confirm') return 'ignored';
  const visitId = session.metadata?.visit_id;
  if (visitId) await releaseHold(visitId);
  return 'released';
}

async function storeSubscriptionItems(planId, subId) {
  const sql = db();
  try {
    const sub = await stripe().subscriptions.retrieve(subId);
    for (const it of sub.items?.data || []) {
      await sql`update plan_items pi set stripe_subscription_item_id = ${it.id}
                from services s where s.id = pi.service_id and pi.plan_id = ${planId} and s.stripe_price_recurring = ${it.price?.id}`;
    }
  } catch (e) { console.error('subscription item lookup failed', subId, e.message); }
}

async function planForInvoice(inv) {
  const sql = db();
  const subId = invoiceSubscriptionId(inv);
  const metaPlan = invoicePlanId(inv);
  if (subId) { const [p] = await sql`select * from plans where stripe_subscription_id = ${subId}`; if (p) return p; }
  if (metaPlan) { const [p] = await sql`select * from plans where id = ${metaPlan}`; if (p) return p; }
  return null;
}

// Which visit an invoice pays: the first clean for subscription_create, else the visit whose
// original_date is the London date of the recurring period start.
async function visitForInvoice(inv, plan) {
  const sql = db();
  if (inv.billing_reason === 'subscription_create') {
    const [v] = await sql`select * from visits where plan_id = ${plan.id} and original_date = ${plan.anchor_date}`;
    return { visit: v || null, billingDate: plan.anchor_date, first: true };
  }
  const start = invoiceRecurringPeriodStart(inv);
  if (!start) return { visit: null };
  const billingDate = londonDate(new Date(start * 1000));
  let [v] = await sql`select * from visits where plan_id = ${plan.id} and original_date = ${billingDate}`;
  if (!v && plan.status !== 'cancelled') v = await placeVisit(plan, billingDate); // generator missed it: create now
  return { visit: v || null, billingDate };
}

async function recordInvoicePayment(inv, visit) {
  const piId = invoicePaymentIntentId(inv);
  if (!piId || !inv.amount_paid) return;
  await recordPayment({ customerId: visit.customer_id, visitId: visit.id, paymentIntentId: piId, invoiceId: inv.id, amount: inv.amount_paid, paidAt: new Date((inv.status_transitions?.paid_at || inv.created) * 1000) });
}

export async function onInvoicePaid(invoiceIn) {
  const sql = db();
  const inv = invoiceIn.payments ? invoiceIn : await stripe().invoices.retrieve(invoiceIn.id, { expand: ['payments'] });
  if (!['subscription_cycle', 'subscription_create'].includes(inv.billing_reason)) return 'ignored';
  const plan = await planForInvoice(inv);
  if (!plan) return 'no_plan';
  const { visit, first } = await visitForInvoice(inv, plan);
  if (!visit) return 'no_visit';
  if (first && !plan.first_paid_upfront) return 'ignored'; // migration confirm: £0 invoice
  if (inv.amount_paid > 0 && !['scheduled', 'done'].includes(visit.status)) {
    await sql`update visits set attention = 'Paid, but this visit was not scheduled: refund or rebook it' where id = ${visit.id}`;
    const [c] = await sql`select name from customers where id = ${visit.customer_id}`;
    await tomAlertSafe('A payment needs checking', [`${c.name} was charged for ${shortDate(visit.original_date)}, but that visit is ${visit.status}. Refund it or move it back onto the round.`], `${appUrl()}/#/visit/${visit.id}`);
  }
  if (inv.amount_paid > 0 || first) {
    await sql`update visits set payment_status = 'paid', stripe_invoice_id = ${inv.id},
                stripe_payment_intent_id = coalesce(${invoicePaymentIntentId(inv)}, stripe_payment_intent_id),
                attention = case when attention like 'Payment failed%' then null else attention end
              where id = ${visit.id} and payment_status <> 'refunded'`;
  }
  await recordInvoicePayment(inv, visit);
  await syncVisitSafe(visit.id);
  return 'paid';
}

export async function onInvoicePaymentFailed(invoiceIn) {
  const sql = db();
  const inv = invoiceIn.lines ? invoiceIn : await stripe().invoices.retrieve(invoiceIn.id);
  if (inv.billing_reason !== 'subscription_cycle') return 'ignored';
  const plan = await planForInvoice(inv);
  if (!plan) return 'no_plan';
  const { visit } = await visitForInvoice(inv, plan);
  if (!visit) return 'no_visit';
  const [already] = await sql`select payment_status from visits where id = ${visit.id}`;
  await sql`update visits set payment_status = 'failed', stripe_invoice_id = ${inv.id}, attention = 'Payment failed' where id = ${visit.id} and payment_status <> 'paid'`;
  await syncVisitSafe(visit.id);
  if (already.payment_status !== 'failed') { // one email per visit, not one per Smart Retry
    const [customer] = await sql`select * from customers where id = ${visit.customer_id}`;
    await notify.tomPaymentFailed({ customer, visit, amountPence: inv.amount_due });
  }
  return 'failed';
}

export async function onSubscriptionDeleted(sub) {
  const sql = db();
  const [plan] = await sql`update plans set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now())
                           where stripe_subscription_id = ${sub.id} returning *`;
  if (!plan) return 'no_plan';
  const ids = await cancelFutureUnpaid(plan.id);
  for (const id of ids) await syncVisitSafe(id);
  return 'cancelled';
}

export async function onChargeRefunded(charge) {
  const sql = db();
  const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!pi) return 'ignored';
  const [p] = await sql`update payments set refunded_pence = ${charge.amount_refunded}, status = ${charge.refunded ? 'refunded' : 'partially_refunded'}
                        where stripe_payment_intent_id = ${pi} returning visit_id`;
  if (p?.visit_id && charge.refunded) {
    await sql`update visits set payment_status = 'refunded' where id = ${p.visit_id}`;
    await syncVisitSafe(p.visit_id);
  }
  return 'refunded';
}

// ---------- recurring engine (§2.5) ----------
export async function planItems(planId) {
  return db()`select pi.*, s.slug, s.name from plan_items pi join services s on s.id = pi.service_id where pi.plan_id = ${planId} order by s.sort`;
}
export async function visitItems(visitId) {
  return db()`select vi.*, s.slug, s.name from visit_items vi join services s on s.id = vi.service_id where vi.visit_id = ${visitId} order by s.sort`;
}

// Candidate slots for a move: +1..+3 days, same ISO week first, plan window before the other window.
export function moveCandidates(settings, fromDate, preferredWindow, { now = clockNow() } = {}) {
  const days = [1, 2, 3].map((n) => addDays(fromDate, n)).filter((d) => !dateRuleBlock(settings, d, { now, ignoreHorizon: true }));
  const wk = isoWeekStart(fromDate);
  days.sort((a, b) => ((isoWeekStart(a) === wk ? 0 : 1) - (isoWeekStart(b) === wk ? 0 : 1)) || a.localeCompare(b));
  const wins = [preferredWindow, ...settings.windows.map((w) => w.id).filter((w) => w !== preferredWindow)];
  return days.flatMap((d) => wins.map((w) => ({ date: d, window: w })));
}

// Create the visit for (plan, originalDate). Applies the block/full move rule. Idempotent.
export async function placeVisit(plan, originalDate, { notifyMove = true } = {}) {
  const sql = db();
  const settings = await getSettings();
  const [existing] = await sql`select * from visits where plan_id = ${plan.id} and original_date = ${originalDate}`;
  if (existing && !(existing.status === 'cancelled' && ['due', 'unpaid', 'failed'].includes(existing.payment_status))) return existing;
  if (existing) { // cancelled while paused (never charged): replace it with a live visit
    await sql`delete from visits where id = ${existing.id}`;
    if (existing.google_event_id) await deleteEventSafe(existing.google_event_id);
  }
  const items = await planItems(plan.id);
  if (!items.length) return null;
  const amount = items.reduce((a, i) => a + i.qty * i.unit_price_pence, 0);
  const paymentStatus = 'due';
  let id = null, moved = false, attention = null;
  try {
    [{ book_slot: id }] = await sql`select book_slot(${plan.customer_id}, ${plan.id}, ${originalDate}, ${plan.time_window}, ${originalDate}, 'scheduled', ${amount}, ${paymentStatus}, 0, false)`;
    if (!id) {
      for (const c of moveCandidates(settings, originalDate, plan.time_window)) {
        [{ book_slot: id }] = await sql`select book_slot(${plan.customer_id}, ${plan.id}, ${c.date}, ${c.window}, ${originalDate}, 'scheduled', ${amount}, ${paymentStatus}, 0, false)`;
        if (id) { moved = true; break; }
      }
    }
    if (!id) {
      [{ book_slot: id }] = await sql`select book_slot(${plan.customer_id}, ${plan.id}, ${originalDate}, ${plan.time_window}, ${originalDate}, 'scheduled', ${amount}, ${paymentStatus}, 0, true)`;
      attention = 'Needs moving: no space within 3 days';
    }
  } catch (e) {
    if (e.code === '23505') { const [v] = await sql`select * from visits where plan_id = ${plan.id} and original_date = ${originalDate}`; return v; }
    throw e;
  }
  for (const i of items) await sql`insert into visit_items (visit_id, service_id, qty, unit_price_pence) values (${id}, ${i.service_id}, ${i.qty}, ${i.unit_price_pence}) on conflict do nothing`;
  if (moved) attention = `Moved by system from ${shortDate(originalDate)}`;
  if (moved || attention) await sql`update visits set moved_by_system = ${moved}, attention = ${attention} where id = ${id}`;
  const [visit] = await sql`select * from visits where id = ${id}`;
  if (moved && notifyMove) {
    const [customer] = await sql`select * from customers where id = ${plan.customer_id}`;
    await notify.visitMoved({ customer, visit, fromDate: originalDate, fromWindow: plan.time_window, reason: 'We aren\'t working that day' });
  }
  if (attention && !moved) await tomAlertSafe('A visit needs moving', [`No space within 3 days of ${shortDate(originalDate)} for a 4-weekly customer. It's on the original day; please move it in the app.`], `${appUrl()}/#/visit/${id}`);
  await syncVisitSafe(id);
  return visit;
}

export function cycleDates(anchor, from, until) {
  const out = [];
  let n = Math.max(0, Math.ceil(diffDays(anchor, from) / CYCLE_DAYS));
  for (let d = addDays(anchor, n * CYCLE_DAYS); d <= until; n++, d = addDays(anchor, n * CYCLE_DAYS)) out.push(d);
  return out;
}

// Make sure visits exist for the next 8 weeks (§10). Paused/cancelled plans get nothing new.
export async function generateVisitsForPlan(plan, { now = clockNow() } = {}) {
  if (!plan || plan.status !== 'active') return [];
  const today = londonDate(now);
  const until = addDays(today, GENERATE_WEEKS * 7);
  const from = plan.anchor_date > today ? plan.anchor_date : addDays(today, 1);
  const made = [];
  for (const d of cycleDates(plan.anchor_date, from, until)) {
    const v = await placeVisit(plan, d);
    if (v) made.push(v.id);
  }
  return made;
}

// ---------- moves ----------
// Move a visit off a blocked day (Tom's "Move all to next available"). Keeps original_date and billing.
export async function systemMoveVisit(visitId, { reason = 'We aren\'t working that day', actor = 'system' } = {}) {
  const sql = db();
  const settings = await getSettings();
  const [v] = await sql`select * from visits where id = ${visitId}`;
  if (!v || v.status !== 'scheduled') return { moved: false };
  for (const c of moveCandidates(settings, v.visit_date, v.time_window)) {
    const [{ move_slot: ok }] = await sql`select move_slot(${v.id}, ${c.date}, ${c.window}, false)`;
    if (ok) {
      await sql`update visits set moved_by_system = true, attention = ${`Moved from ${shortDate(v.visit_date)}`}, reminder_sent_at = null where id = ${v.id}`;
      const [nv] = await sql`select * from visits where id = ${v.id}`;
      const [customer] = await sql`select * from customers where id = ${v.customer_id}`;
      await notify.visitMoved({ customer, visit: nv, fromDate: v.visit_date, fromWindow: v.time_window, reason });
      await audit(actor, 'visit.system_move', 'visit', v.id, { from: v.visit_date, to: c.date, window: c.window });
      await syncVisitSafe(v.id);
      return { moved: true, date: c.date, window: c.window };
    }
  }
  await sql`update visits set attention = 'Needs moving: no space within 3 days' where id = ${v.id}`;
  return { moved: false };
}

// Customer or Tom reschedules one visit. Plan cadence and billing dates don't change.
export async function rescheduleVisit(visitId, date, win, { by = 'customer', customerId = null, now = clockNow(), force = false } = {}) {
  const sql = db();
  const settings = await getSettings();
  const [v] = await sql`select * from visits where id = ${visitId}`;
  if (!v || (customerId && v.customer_id !== customerId)) throw new HttpError(404, 'Visit not found');
  if (v.status !== 'scheduled') throw bad('That visit can\'t be moved.', 'status');
  if (!settings.windows.some((w) => w.id === win)) throw bad('Choose a time window.', 'window');
  if (!isDate(date)) throw bad('Choose a date.', 'date');
  if (by === 'customer') {
    if (windowStart(settings, v.visit_date, v.time_window) - now < DAY_MS) throw new HttpError(409, 'Visits can only be moved up to 24 hours before they start.', 'too_late');
    if (Math.abs(diffDays(v.original_date, date)) > 7) throw bad('Pick a date within 7 days of your usual clean.', 'range');
    const rule = dateRuleBlock(settings, date, { now, ignoreHorizon: true });
    if (rule) throw new HttpError(409, 'That date isn\'t available.', 'date_' + rule);
  }
  if (date === v.visit_date && win === v.time_window) return v;
  const [{ move_slot: ok }] = await sql`select move_slot(${v.id}, ${date}, ${win}, ${force && by !== 'customer'})`;
  if (!ok) throw new HttpError(409, 'That time is full. Please pick another.', 'full');
  await sql`update visits set reminder_sent_at = null, attention = null where id = ${v.id}`;
  await audit(by, 'visit.reschedule', 'visit', v.id, { from: [v.visit_date, v.time_window], to: [date, win] });
  const [nv] = await sql`select * from visits where id = ${v.id}`;
  await syncVisitSafe(v.id);
  if (by === 'customer') {
    const [customer] = await sql`select * from customers where id = ${v.customer_id}`;
    await notify.rescheduled({ customer, visit: nv });
  }
  return nv;
}

async function cancelFutureUnpaid(planId) {
  const sql = db();
  const today = londonDate(clockNow());
  const rows = await sql`update visits set status = 'cancelled', attention = null
                         where plan_id = ${planId} and visit_date >= ${today} and status = 'scheduled'
                           and payment_status in ('due','unpaid','failed') returning id`;
  return rows.map((r) => r.id);
}

// ---------- refunds ----------
export async function refundVisit(visitId, { actor = 'system', cancel = false } = {}) {
  const sql = db();
  const [v] = await sql`select * from visits where id = ${visitId}`;
  if (!v) throw new HttpError(404, 'Visit not found');
  if (v.payment_status !== 'paid') throw bad('Only paid visits can be refunded.', 'not_paid');
  let pi = v.stripe_payment_intent_id;
  if (!pi) { const [p] = await sql`select stripe_payment_intent_id from payments where visit_id = ${v.id} order by paid_at desc limit 1`; pi = p?.stripe_payment_intent_id; }
  if (!pi) throw bad('No card payment found for this visit.', 'no_payment');
  const [pay] = await sql`select * from payments where stripe_payment_intent_id = ${pi}`;
  const refundable = pay ? pay.amount_pence - (pay.refunded_pence || 0) : v.amount_pence;
  const amount = Math.min(v.amount_pence, refundable); // never more than is left on the charge
  if (amount <= 0) throw bad('This payment has already been refunded.', 'refunded');
  const refund = await stripe().refunds.create({ payment_intent: pi, amount, metadata: { visit_id: v.id } }, { idempotencyKey: `refund-${v.id}` });
  await sql`update payments set refunded_pence = refunded_pence + ${refund.amount}, refund_ids = array_append(refund_ids, ${refund.id}),
              status = case when refunded_pence + ${refund.amount} >= amount_pence then 'refunded' else 'partially_refunded' end
            where stripe_payment_intent_id = ${pi} and not (${refund.id} = any(refund_ids))`;
  await sql`update visits set payment_status = 'refunded', status = ${cancel ? 'cancelled' : v.status} where id = ${v.id}`;
  await audit(actor, 'visit.refund', 'visit', v.id, { amount: refund.amount });
  await syncVisitSafe(v.id);
  return refund.amount;
}

// ---------- plan lifecycle ----------
// §2.6: cancel now, no more charges. A paid visit >24h away is refunded and cancelled if refundNext.
export async function cancelPlan(planId, { actor = 'customer', refundNext = false, customerId = null, now = clockNow() } = {}) {
  const sql = db();
  const settings = await getSettings();
  const [plan] = await sql`select * from plans where id = ${planId}`;
  if (!plan || (customerId && plan.customer_id !== customerId)) throw new HttpError(404, 'Plan not found');
  if (plan.status === 'cancelled') return { already: true };
  if (plan.stripe_subscription_id) {
    try { await stripe().subscriptions.cancel(plan.stripe_subscription_id, { prorate: false }); }
    catch (e) { if (e?.code !== 'resource_missing' && e?.statusCode !== 404) throw e; }
  }
  await sql`update plans set status = 'cancelled', cancelled_at = ${now} where id = ${planId}`;
  const cancelledIds = await cancelFutureUnpaid(planId);
  const today = londonDate(now);
  const paidUpcoming = await sql`select * from visits where plan_id = ${planId} and status = 'scheduled' and payment_status = 'paid' and visit_date >= ${today} order by visit_date`;
  let refunded = 0, kept = null;
  for (const v of paidUpcoming) {
    const far = windowStart(settings, v.visit_date, v.time_window) - now > DAY_MS;
    if (far && refundNext) refunded += await refundVisit(v.id, { actor, cancel: true });
    else kept = kept || v;
  }
  for (const id of cancelledIds) await syncVisitSafe(id);
  await audit(actor, 'plan.cancel', 'plan', planId, { refunded, kept: kept?.id || null });
  const [customer] = await sql`select * from customers where id = ${plan.customer_id}`;
  await notify.planCancelled({ customer, refundedPence: refunded, keptVisit: kept });
  return { refunded, kept: kept ? { id: kept.id, date: kept.visit_date, window: kept.time_window } : null, cancelled: cancelledIds.length };
}

// Customer cancels a one-off visit (free up to 24h before, refunded).
export async function cancelOneOffVisit(visitId, { customerId, now = clockNow() }) {
  const sql = db();
  const settings = await getSettings();
  const [v] = await sql`select * from visits where id = ${visitId} and customer_id = ${customerId}`;
  if (!v || v.plan_id) throw new HttpError(404, 'Visit not found');
  if (v.status !== 'scheduled') throw bad('That visit can\'t be cancelled.', 'status');
  if (windowStart(settings, v.visit_date, v.time_window) - now < DAY_MS) throw new HttpError(409, 'Within 24 hours of your clean it can\'t be cancelled online. Please call us.', 'too_late');
  let refunded = 0;
  if (v.payment_status === 'paid') refunded = await refundVisit(v.id, { actor: 'customer', cancel: true });
  else await sql`update visits set status = 'cancelled' where id = ${v.id}`;
  await syncVisitSafe(v.id);
  const [customer] = await sql`select * from customers where id = ${customerId}`;
  await notify.visitCancelled({ customer, visit: v, refundedPence: refunded });
  return { refunded };
}

export async function pausePlan(planId, actor) {
  const sql = db();
  const [plan] = await sql`select * from plans where id = ${planId}`;
  if (!plan || plan.status !== 'active') throw bad('Only active plans can be paused.');
  if (plan.stripe_subscription_id) await stripe().subscriptions.update(plan.stripe_subscription_id, { pause_collection: { behavior: 'void' } });
  await sql`update plans set status = 'paused', paused_at = now() where id = ${planId}`;
  const ids = await cancelFutureUnpaid(planId);
  for (const id of ids) await syncVisitSafe(id);
  await audit(actor, 'plan.pause', 'plan', planId, { cancelled_visits: ids.length });
  return { cancelled: ids.length };
}

// Resume from a new next-visit date: billing re-anchors there (§2.5 cadence move).
export async function resumePlan(planId, nextDate, actor) {
  const sql = db();
  const [plan] = await sql`select * from plans where id = ${planId}`;
  if (!plan || plan.status !== 'paused') throw bad('Only paused plans can be resumed.');
  await assertCadenceDate(plan, nextDate);
  if (plan.stripe_subscription_id) await stripe().subscriptions.update(plan.stripe_subscription_id, { pause_collection: '' });
  await sql`update plans set status = 'active', paused_at = null where id = ${planId}`;
  return movePlanCadence(planId, nextDate, actor);
}

// A new cadence must start on a working day 3+ days away, and after any clean already paid for
// (otherwise the customer would be charged on the new date and still have the paid visit).
async function assertCadenceDate(plan, nextDate, { now = clockNow() } = {}) {
  const settings = await getSettings();
  if (!isDate(nextDate) || nextDate <= addDays(londonDate(now), 2)) throw bad('Pick a next visit date at least 3 days away.', 'date');
  if (!settings.bookable_weekdays.includes(isoWeekday(nextDate))) throw bad('Pick a working day.', 'date');
  const [paid] = await db()`select max(visit_date) as d from visits where plan_id = ${plan.id} and status = 'scheduled' and payment_status = 'paid' and visit_date >= ${londonDate(now)}`;
  if (paid?.d && nextDate <= paid.d) throw bad(`This plan has a paid clean on ${shortDate(paid.d)}. Pick a date after it.`, 'date');
}

// Tom moves a whole plan: new anchor, billing re-anchored with no proration, future visits regenerated.
export async function movePlanCadence(planId, nextDate, actor, { now = clockNow() } = {}) {
  const sql = db();
  const settings = await getSettings();
  const [plan] = await sql`select * from plans where id = ${planId}`;
  if (!plan || plan.status !== 'active') throw bad('Only active plans can be moved.');
  await assertCadenceDate(plan, nextDate, { now });
  const trialEnd = Math.floor(londonToUtc(nextDate, settings.charge_time || '07:00').getTime() / 1000);
  if (plan.stripe_subscription_id) await stripe().subscriptions.update(plan.stripe_subscription_id, { trial_end: trialEnd, proration_behavior: 'none' });
  // Future unpaid visits go (including ones cancelled by a pause); paid ones stay (they were paid for).
  const today = londonDate(now);
  const gone = await sql`delete from visits where plan_id = ${planId} and visit_date > ${today} and status in ('scheduled','cancelled') and payment_status in ('due','failed','unpaid') returning id, google_event_id`;
  await sql`update plans set anchor_date = ${nextDate}, first_paid_upfront = false where id = ${planId}`;
  const [np] = await sql`select * from plans where id = ${planId}`;
  await generateVisitsForPlan(np, { now });
  await deleteCalendarEvents(gone);
  await audit(actor, 'plan.move_cadence', 'plan', planId, { next: nextDate });
  return { next: nextDate };
}

async function deleteCalendarEvents(rows) {
  for (const r of rows.filter((x) => x.google_event_id)) await deleteEventSafe(r.google_event_id);
}

// ---------- manual / Square-migration customers ----------
export async function createPlanConfirm({ customer: cin, items, nextDate, window: win, actor }) {
  const sql = db();
  const settings = await getSettings();
  const c = validateCustomer(cin);
  if (!isDate(nextDate) || diffDays(londonDate(clockNow()), nextDate) < 3) throw bad('The next due date must be at least 3 days away.', 'date');
  if (!settings.bookable_weekdays.includes(isoWeekday(nextDate))) throw bad('The next due date must be a working day.', 'date');
  if (!settings.windows.some((w) => w.id === win)) throw bad('Choose a window.', 'window');
  const priced = await priceBooking('recurring', items, false, { onlineOnly: false });
  const customer = await upsertCustomer(c, cin.source === 'square-migration' ? 'square-migration' : 'manual');
  const stripeCustomer = await ensureStripeCustomer(customer);
  const [plan] = await sql`insert into plans (customer_id, status, anchor_date, time_window, first_paid_upfront) values (${customer.id}, 'pending', ${nextDate}, ${win}, false) returning *`;
  for (const l of priced.lines) await sql`insert into plan_items (plan_id, service_id, qty, unit_price_pence) values (${plan.id}, ${l.service.id}, ${l.qty}, ${l.unit})`;
  const trialEnd = Math.floor(londonToUtc(nextDate, settings.charge_time || '07:00').getTime() / 1000);
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription', customer: stripeCustomer,
    line_items: priced.lines.map((l) => ({ price: l.service.stripe_price_recurring, quantity: l.qty })),
    payment_method_collection: 'always',
    subscription_data: { trial_end: trialEnd, metadata: { plan_id: plan.id }, description: 'Bin Fresh 4-weekly clean' },
    metadata: { kind: 'plan_confirm', plan_id: plan.id },
    success_url: `${siteUrl()}/book/confirmed?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl()}/`,
    expires_at: Math.floor(Date.now() / 1000) + 23 * 3600, // Checkout's maximum is 24h
    locale: 'en-GB',
  }, { idempotencyKey: `planconfirm-${plan.id}` });
  await sql`update plans set stripe_checkout_session_id = ${session.id} where id = ${plan.id}`;
  await notify.planConfirmRequest({ customer, url: session.url, nextDate, windowId: win, recurringPence: priced.recurringPence, itemsText: priced.summary });
  await audit(actor, 'plan.confirm_link', 'plan', plan.id, { next: nextDate });
  return { plan_id: plan.id, customer_id: customer.id, url: session.url, expires: '23 hours' };
}

async function onPlanConfirmCompleted(session) {
  const sql = db();
  const planId = session.metadata.plan_id;
  const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  const [plan] = await sql`update plans set status = 'active', stripe_subscription_id = ${subId}
                           where id = ${planId} and status = 'pending' returning *`;
  if (!plan) return 'ignored';
  await storeSubscriptionItems(planId, subId);
  await generateVisitsForPlan(plan);
  const [first] = await sql`select * from visits where plan_id = ${planId} order by visit_date limit 1`;
  const [customer] = await sql`select * from customers where id = ${plan.customer_id}`;
  if (first) {
    const items = await visitItems(first.id);
    const rec = items.reduce((a, i) => a + i.qty * i.unit_price_pence, 0);
    await notify.bookingConfirmed({ customer, visit: first, itemsText: describeItems(items), plan, firstPence: 0, recurringPence: rec });
  }
  await audit('customer', 'plan.confirmed', 'plan', planId, {});
  return 'ok';
}

async function tomAlertSafe(subject, lines, link) {
  try { await notify.tomAlert({ subject, lines, link }); } catch (e) { console.error('tom alert failed', e.message); }
}

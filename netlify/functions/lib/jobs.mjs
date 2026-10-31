// Scheduled work (§10). Each job is idempotent and safe to re-run.
import { db, getSettings, audit } from './db.mjs';
import { generateVisitsForPlan, recordPayment } from './booking.mjs';
import { staleVisitIds, syncMany, calendarConfig } from './calendar.mjs';
import { reminderSms } from './notify.mjs';
import { stripe } from './stripe.mjs';
import { store } from './store.mjs';
import { addDays, londonDate, londonParts, now as clockNow } from './time.mjs';

// Daily 02:00: visits 8 weeks ahead for every active plan, expired holds, scheduled price changes, missing fees.
export async function generateAll({ now = clockNow() } = {}) {
  const sql = db();
  const out = { plans: 0, visits_created: 0, holds_removed: 0, price_changes: 0, fees_filled: 0 };
  // holds whose Checkout session is long gone (sessions live 31 minutes)
  const holds = await sql`delete from visits where status = 'held' and hold_expires_at < now() - interval '2 hours' returning plan_id`;
  out.holds_removed = holds.length;
  for (const h of holds) if (h.plan_id) await sql`delete from plans where id = ${h.plan_id} and status = 'pending' and not exists (select 1 from visits where plan_id = ${h.plan_id})`;
  await sql`delete from plans p where p.status = 'pending' and p.created_at < now() - interval '2 days' and not exists (select 1 from visits v where v.plan_id = p.id)`;

  out.price_changes = await applyPriceChanges({ now });

  const plans = await sql`select * from plans where status = 'active'`;
  for (const p of plans) {
    out.plans++;
    const before = (await sql`select count(*)::int as n from visits where plan_id = ${p.id}`)[0].n;
    await generateVisitsForPlan(p, { now });
    out.visits_created += (await sql`select count(*)::int as n from visits where plan_id = ${p.id}`)[0].n - before;
  }

  const missing = await sql`select * from payments where fee_pence is null and stripe_payment_intent_id is not null and paid_at > now() - interval '14 days' limit 50`;
  for (const p of missing) {
    await recordPayment({ customerId: p.customer_id, visitId: p.visit_id, paymentIntentId: p.stripe_payment_intent_id, invoiceId: p.stripe_invoice_id, amount: p.amount_pence, status: p.status, paidAt: p.paid_at });
    const [r] = await sql`select fee_pence from payments where id = ${p.id}`;
    if (r.fee_pence != null) out.fees_filled++;
  }
  await sql`delete from manage_tokens where expires_at < now()`;
  return out;
}

// Move existing plans to a new 4-weekly price the day before it takes effect (customers were told 14 days ahead).
export async function applyPriceChanges({ now = clockNow() } = {}) {
  const sql = db();
  const today = londonDate(now);
  const due = await sql`select * from price_changes where applied_at is null and effective_date <= ${addDays(today, 1)}`;
  for (const pc of due) {
    const items = await sql`select pi.*, p.stripe_subscription_id from plan_items pi join plans p on p.id = pi.plan_id
                            where pi.service_id = ${pc.service_id} and p.status in ('active','paused') and pi.unit_price_pence <> ${pc.new_recurring_pence}`;
    for (const it of items) {
      if (it.stripe_subscription_item_id) {
        await stripe().subscriptionItems.update(it.stripe_subscription_item_id, { price: pc.new_stripe_price, proration_behavior: 'none' });
      }
      await sql`update plan_items set unit_price_pence = ${pc.new_recurring_pence} where plan_id = ${it.plan_id} and service_id = ${pc.service_id}`;
      const vids = await sql`select id from visits where plan_id = ${it.plan_id} and original_date >= ${pc.effective_date} and payment_status = 'due' and status = 'scheduled'`;
      for (const v of vids) {
        await sql`update visit_items set unit_price_pence = ${pc.new_recurring_pence} where visit_id = ${v.id} and service_id = ${pc.service_id}`;
        await sql`update visits set amount_pence = (select coalesce(sum(qty * unit_price_pence),0) from visit_items where visit_id = ${v.id}) where id = ${v.id}`;
      }
    }
    await sql`update price_changes set applied_at = now() where id = ${pc.id}`;
    await audit('system', 'price_change.applied', 'service', pc.service_id, { plans: items.length });
  }
  return due.length;
}

// Hourly: from reminder_time (17:00 UK) until 21:00, text everyone with a visit tomorrow, once.
export async function sendReminders({ now = clockNow() } = {}) {
  const sql = db();
  const s = await getSettings({ fresh: true });
  const hour = Number(String(s.reminder_time || '17:00').split(':')[0]);
  const h = londonParts(now).hh;
  if (h < hour || h > hour + 4) return { skipped: 'not reminder time', london_hour: h };
  const tomorrow = addDays(londonDate(now), 1);
  // claim first so overlapping runs can't double-send
  const claimed = await sql`update visits set reminder_sent_at = ${now}
                            where visit_date = ${tomorrow} and status = 'scheduled' and reminder_sent_at is null returning *`;
  let sent = 0, failed = 0;
  for (const v of claimed) {
    const [customer] = await sql`select * from customers where id = ${v.customer_id}`;
    const r = await reminderSms({ customer, visit: v });
    if (r.error) { failed++; await sql`update visits set reminder_sent_at = null where id = ${v.id}`; } else sent++;
  }
  return { date: tomorrow, sent, failed };
}

export async function reconcileCalendar() {
  if (!(await calendarConfig())) return { skipped: 'calendar not connected' };
  return syncMany(await staleVisitIds({ limit: 150 }));
}

const BACKUP_TABLES = ['services', 'customers', 'plans', 'plan_items', 'visits', 'visit_items', 'payments', 'blocks', 'capacity_overrides', 'settings', 'price_changes', 'audit_log'];
export async function backup({ now = clockNow(), keepDays = 30 } = {}) {
  const sql = db();
  const dump = { created_at: now.toISOString(), tables: {} };
  for (const t of BACKUP_TABLES) dump.tables[t] = await sql.unsafe(`select * from public.${t}`);
  // never back up the encrypted Google token in the clear set of settings
  dump.tables.settings = dump.tables.settings.map((r) => (r.key === 'google_calendar' ? { key: r.key, value: { ...r.value, refresh_enc: r.value?.refresh_enc ? '[omitted]' : null } } : r));
  const s = store('backups');
  const key = `${londonDate(now)}.json`;
  await s.set(key, JSON.stringify(dump));
  const cutoff = addDays(londonDate(now), -keepDays);
  const { blobs } = await s.list();
  let removed = 0;
  for (const b of blobs) if (b.key.slice(0, 10) < cutoff) { await s.delete(b.key); removed++; }
  return { key, rows: Object.fromEntries(Object.entries(dump.tables).map(([k, v]) => [k, v.length])), removed };
}

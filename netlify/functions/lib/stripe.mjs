import Stripe from 'stripe';
import { env } from './env.mjs';
import { HttpError } from './http.mjs';

let _stripe = null;
export function stripe() {
  if (_stripe) return _stripe;
  const key = env('STRIPE_SECRET_KEY');
  if (!key) throw new HttpError(503, 'Payments are not configured yet.');
  const opts = { maxNetworkRetries: 1, timeout: 12000, appInfo: { name: 'Bin Fresh Rounds' } };
  // Tests point the SDK at a local fake Stripe.
  if (env('STRIPE_API_HOST')) {
    opts.host = env('STRIPE_API_HOST');
    opts.port = Number(env('STRIPE_API_PORT', '443'));
    opts.protocol = env('STRIPE_API_PROTOCOL', 'https');
  }
  _stripe = new Stripe(key, opts);
  return _stripe;
}
export function _resetStripe() { _stripe = null; }

// Subscription id from an invoice in current API versions (invoice.parent.subscription_details).
export function invoiceSubscriptionId(inv) {
  const s = inv?.parent?.subscription_details?.subscription ?? inv?.subscription;
  return typeof s === 'string' ? s : s?.id || null;
}
export function invoicePlanId(inv) {
  return inv?.parent?.subscription_details?.metadata?.plan_id || inv?.subscription_details?.metadata?.plan_id || null;
}
// Payment intent id from an invoice expanded with 'payments'.
export function invoicePaymentIntentId(inv) {
  const p = inv?.payments?.data?.find((x) => x.status === 'paid') || inv?.payments?.data?.[0];
  const pi = p?.payment?.payment_intent ?? inv?.payment_intent;
  return typeof pi === 'string' ? pi : pi?.id || null;
}
// Start of the recurring period this invoice bills (the visit's billing date).
export function invoiceRecurringPeriodStart(inv) {
  // Only a subscription-item line carries the cycle's period. Other lines (e.g. an extra invoice item)
  // have their own creation-time periods and must never decide which visit is paid.
  const lines = inv?.lines?.data || [];
  const rec = lines.find((l) => l.parent?.type === 'subscription_item_details' || l.parent?.subscription_item_details)
    || lines.find((l) => l.price?.recurring);
  return rec?.period?.start ?? inv?.period_end ?? null;
}

// Stripe fee for a payment intent, in pence (null if not settled yet).
export async function paymentDetails(paymentIntentId) {
  if (!paymentIntentId) return { fee: null, charge: null };
  const pi = await stripe().paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge.balance_transaction'] });
  const ch = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const bt = ch?.balance_transaction && typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null;
  return { fee: bt ? bt.fee : null, charge: ch?.id || (typeof pi.latest_charge === 'string' ? pi.latest_charge : null), amount: pi.amount_received ?? pi.amount };
}

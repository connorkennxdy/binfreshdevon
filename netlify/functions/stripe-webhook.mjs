// POST /api/stripe/webhook — signature verified on the raw body; each event processed once.
import { stripe } from './lib/stripe.mjs';
import { db } from './lib/db.mjs';
import { env } from './lib/env.mjs';
import { json } from './lib/http.mjs';
import * as B from './lib/booking.mjs';

const HANDLERS = {
  'checkout.session.completed': (o) => B.onCheckoutCompleted(o),
  'checkout.session.async_payment_succeeded': (o) => B.onCheckoutCompleted(o),
  'checkout.session.expired': (o) => B.onCheckoutExpired(o),
  'invoice.paid': (o) => B.onInvoicePaid(o),
  'invoice.payment_failed': (o) => B.onInvoicePaymentFailed(o),
  'customer.subscription.deleted': (o) => B.onSubscriptionDeleted(o),
  'charge.refunded': (o) => B.onChargeRefunded(o),
};

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const raw = await req.text();
  let event;
  try {
    event = await stripe().webhooks.constructEventAsync(raw, req.headers.get('stripe-signature') || '', env('STRIPE_WEBHOOK_SECRET'));
  } catch (e) {
    return json({ error: 'Invalid signature' }, 400);
  }
  const fn = HANDLERS[event.type];
  if (!fn) return json({ received: true, ignored: true });
  const sql = db();
  const [fresh] = await sql`insert into stripe_events (id, type) values (${event.id}, ${event.type}) on conflict (id) do nothing returning id`;
  if (!fresh) return json({ received: true, duplicate: true });
  try {
    const result = await fn(event.data.object);
    console.log('stripe event', event.type, event.id, result);
    return json({ received: true, result });
  } catch (e) {
    // Let Stripe retry: forget the event id so the retry is processed.
    await sql`delete from stripe_events where id = ${event.id}`;
    console.error('stripe event failed', event.type, event.id, e?.message);
    return json({ error: 'processing failed' }, 500);
  }
};

export const config = { path: '/api/stripe/webhook', method: ['POST'] };

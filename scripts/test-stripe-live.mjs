// P2-6 against REAL Stripe test mode with a test clock. The fake Stripe in `npm test` can't prove how Stripe
// bills trials, so this script does. Needs a TEST secret key; refuses live keys.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/test-stripe-live.mjs              # API mode (fully automatic)
//   STRIPE_SECRET_KEY=sk_test_... node scripts/test-stripe-live.mjs --checkout   # also via a real Checkout page you complete with 4242
//
// What it proves (handoff §2.4): first visit 5 days out; exactly one charge at sign-up (the first clean); nothing
// charged before trial_end (first visit + 28 days, 07:00 UK); then a charge every 28 days, each on a visit date.
// If any step fails it stops and says so: per the handoff, report back rather than change the payment model.
import Stripe from 'stripe';
import { londonToUtc, addDays, londonDate } from '../netlify/functions/lib/time.mjs';

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) { console.error('Set STRIPE_SECRET_KEY to a TEST key (sk_test_…).'); process.exit(1); }
const stripe = new Stripe(key);
const useCheckout = process.argv.includes('--checkout');
const ok = (m) => console.log('  ✔ ' + m);
const fail = (m) => { console.error('  ✖ ' + m); process.exitCode = 1; throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

async function advance(clock, to) {
  await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: to });
  for (let i = 0; i < 120; i++) {
    const c = await stripe.testHelpers.testClocks.retrieve(clock.id);
    if (c.status === 'ready') return c;
    if (c.status === 'internal_failure') fail('test clock failed');
    await sleep(2000);
  }
  fail('test clock did not settle');
}
async function paidCharges(customer) {
  const list = await stripe.charges.list({ customer, limit: 100 });
  return list.data.filter((c) => c.paid && c.status === 'succeeded').sort((a, b) => a.created - b.created);
}

const now = Math.floor(Date.now() / 1000);
const first = addDays(londonDate(new Date(now * 1000)), 5);
const trialEnd = Math.floor(londonToUtc(addDays(first, 28), '07:00').getTime() / 1000);
console.log(`First visit ${first}; trial_end ${fmt(trialEnd)} (07:00 UK on ${addDays(first, 28)})`);

const product = await stripe.products.create({ name: 'BF live test: 2 household bins' });
const recurring = await stripe.prices.create({ product: product.id, currency: 'gbp', unit_amount: 1350, recurring: { interval: 'week', interval_count: 4 } });
const firstClean = await stripe.prices.create({ product: product.id, currency: 'gbp', unit_amount: 1350 });
const clock = await stripe.testHelpers.testClocks.create({ frozen_time: now, name: 'Bin Fresh P2-6' });
const customer = await stripe.customers.create({ name: 'P2-6 Test', email: 'p26@example.com', test_clock: clock.id });
let sub;

try {
  if (useCheckout) {
    const s = await stripe.checkout.sessions.create({
      mode: 'subscription', customer: customer.id, payment_method_collection: 'always',
      line_items: [{ price: recurring.id, quantity: 1 }, { price: firstClean.id, quantity: 1 }],
      subscription_data: { trial_end: trialEnd, metadata: { plan_id: 'p26-test' } },
      success_url: 'https://binfreshdevon.co.uk/book/confirmed?session_id={CHECKOUT_SESSION_ID}', cancel_url: 'https://binfreshdevon.co.uk/book',
    });
    console.log(`\nOpen this and pay with 4242 4242 4242 4242, any future date, any CVC:\n${s.url}\n`);
    for (;;) { const x = await stripe.checkout.sessions.retrieve(s.id); if (x.status === 'complete') { sub = await stripe.subscriptions.retrieve(x.subscription); break; } if (x.status === 'expired') fail('session expired'); await sleep(3000); }
    ok('Checkout completed');
  } else {
    // What Checkout creates for us: recurring item + the one-time first clean added to the first invoice.
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
    sub = await stripe.subscriptions.create({
      customer: customer.id, items: [{ price: recurring.id }], add_invoice_items: [{ price: firstClean.id }],
      trial_end: trialEnd, metadata: { plan_id: 'p26-test' },
    });
  }
  await sleep(2000);
  let charges = await paidCharges(customer.id);
  if (charges.length !== 1) fail(`expected exactly 1 charge at sign-up, got ${charges.length}`);
  if (charges[0].amount !== 1350) fail(`first charge was ${charges[0].amount}p, expected 1350p`);
  ok('exactly one charge at sign-up: £13.50 (the first clean)');
  if (sub.status !== 'trialing' || sub.trial_end !== trialEnd) fail(`subscription ${sub.status}, trial_end ${sub.trial_end}`);
  ok(`subscription trialing until ${fmt(sub.trial_end)}`);

  await advance(clock, trialEnd - 3600);
  charges = await paidCharges(customer.id);
  if (charges.length !== 1) fail(`charged before trial_end (${charges.length} charges)`);
  ok('nothing charged before trial_end (clock at trial_end − 1h)');

  let expectDate = addDays(first, 28);
  for (let cycle = 1; cycle <= 2; cycle++) {
    const at = cycle === 1 ? trialEnd : trialEnd + 28 * 86400 * (cycle - 1);
    await advance(clock, at + 2 * 3600);
    await sleep(3000);
    charges = await paidCharges(customer.id);
    if (charges.length !== 1 + cycle) fail(`cycle ${cycle}: expected ${1 + cycle} charges, got ${charges.length}`);
    const inv = (await stripe.invoices.list({ customer: customer.id, limit: 10, expand: ['data.lines'] })).data.find((i) => i.billing_reason === 'subscription_cycle' && i.status === 'paid' && i.lines.data.some((l) => londonDate(new Date(l.period.start * 1000)) === expectDate));
    if (!inv) fail(`cycle ${cycle}: no paid renewal invoice whose period starts on ${expectDate}`);
    if (inv.amount_paid !== 1350) fail(`cycle ${cycle}: charged ${inv.amount_paid}p`);
    ok(`cycle ${cycle}: £13.50 charged; invoice period starts ${expectDate} (a visit date) — this is how the webhook finds the visit`);
    expectDate = addDays(expectDate, 28);
  }
  console.log('\nP2-6 PASSED against real Stripe test mode.');
} catch (e) {
  console.error('\nP2-6 FAILED: ' + e.message + '\nStop and report back (handoff §2.4) rather than changing the payment model.');
} finally {
  await stripe.testHelpers.testClocks.del(clock.id).catch(() => {});
  await stripe.products.update(product.id, { active: false }).catch(() => {});
}

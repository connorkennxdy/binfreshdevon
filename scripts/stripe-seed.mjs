// Creates the Stripe catalogue from the services table and writes the price IDs back (§5.1).
// Idempotent: products have fixed IDs (bf_<slug>), prices are found by lookup_key. A price whose amount
// no longer matches the services table gets a new Price (lookup_key transferred) and the old one archived.
//
//   STRIPE_SECRET_KEY=sk_test_... SUPABASE_DB_URL=postgres://... node scripts/stripe-seed.mjs [--portal] [--dry-run]
import { fileURLToPath } from 'node:url';

export const lookupKeys = (slug) => ({ oneoff: `bf_${slug}_oneoff`, recurring: `bf_${slug}_4wk`, first: `bf_${slug}_first` });

export async function seed({ stripe, sql, log = console.log, dryRun = false }) {
  const services = await sql`select * from services order by sort`;
  const report = [];
  for (const s of services) {
    const productId = `bf_${s.slug}`;
    let product;
    try { product = await stripe.products.retrieve(productId); } catch (e) { if (e?.statusCode !== 404 && e?.code !== 'resource_missing') throw e; }
    if (!product && !dryRun) product = await stripe.products.create({ id: productId, name: s.name, metadata: { bf_service: s.slug } });
    else if (product && product.name !== s.name && !dryRun) await stripe.products.update(productId, { name: s.name });

    const keys = lookupKeys(s.slug);
    const existing = await stripe.prices.list({ lookup_keys: Object.values(keys), limit: 10 });
    const byKey = Object.fromEntries(existing.data.map((p) => [p.lookup_key, p]));
    const want = {
      oneoff: s.price_one_off_pence != null ? { unit_amount: s.price_one_off_pence } : null,
      recurring: s.price_recurring_pence != null ? { unit_amount: s.price_recurring_pence, recurring: { interval: 'week', interval_count: 4 } } : null,
      first: s.price_recurring_pence != null ? { unit_amount: s.price_recurring_pence } : null,
    };
    const ids = {};
    for (const kind of ['oneoff', 'recurring', 'first']) {
      const cur = byKey[keys[kind]];
      const w = want[kind];
      if (!w) {
        if (cur && cur.active && !dryRun) await stripe.prices.update(cur.id, { active: false, lookup_key: '' });
        ids[kind] = null; continue;
      }
      const matches = cur && cur.active && cur.unit_amount === w.unit_amount && !!cur.recurring === !!w.recurring
        && (!w.recurring || (cur.recurring.interval === 'week' && cur.recurring.interval_count === 4));
      if (matches) { ids[kind] = cur.id; report.push([s.slug, kind, 'ok', cur.id]); continue; }
      if (dryRun) { report.push([s.slug, kind, cur ? 'would replace' : 'would create']); continue; }
      const nickname = kind === 'first' ? `${s.name}: first clean` : kind === 'recurring' ? `${s.name}: every 4 weeks` : `${s.name}: one-off`;
      const created = await stripe.prices.create({
        product: productId, currency: 'gbp', unit_amount: w.unit_amount, nickname,
        ...(w.recurring ? { recurring: w.recurring } : {}),
        lookup_key: keys[kind], transfer_lookup_key: true, tax_behavior: 'inclusive',
        metadata: { bf_service: s.slug, bf_kind: kind },
      });
      if (cur) await stripe.prices.update(cur.id, { active: false });
      ids[kind] = created.id;
      report.push([s.slug, kind, cur ? 'replaced' : 'created', created.id]);
    }
    if (!dryRun) {
      await sql`update services set stripe_product = ${productId}, stripe_price_one_off = ${ids.oneoff}, stripe_price_recurring = ${ids.recurring},
                  stripe_price_first_clean = ${ids.first} where id = ${s.id}`;
    }
  }
  for (const r of report) log(r.join('  '));
  return report;
}

// Customer Portal limited to updating the card (§5.4). Prints the configuration ID for STRIPE_PORTAL_CONFIG_ID.
export async function createPortalConfig({ stripe, siteUrl }) {
  const cfg = await stripe.billingPortal.configurations.create({
    business_profile: { headline: 'Bin Fresh Devon: update your card', privacy_policy_url: `${siteUrl}/privacy`, terms_of_service_url: `${siteUrl}/terms` },
    features: {
      payment_method_update: { enabled: true },
      customer_update: { enabled: false },
      invoice_history: { enabled: false },
      subscription_cancel: { enabled: false },
      subscription_update: { enabled: false },
    },
    default_return_url: `${siteUrl}/manage/`,
  });
  return cfg.id;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { default: Stripe } = await import('stripe');
  const { default: postgres } = await import('postgres');
  const key = process.env.STRIPE_SECRET_KEY, url = process.env.SUPABASE_DB_URL;
  if (!key || !url) { console.error('Set STRIPE_SECRET_KEY and SUPABASE_DB_URL'); process.exit(1); }
  console.log(`Seeding Stripe in ${key.startsWith('sk_live') ? 'LIVE' : 'test'} mode`);
  const stripe = new Stripe(key);
  const sql = postgres(url, { prepare: false, max: 1 });
  try {
    await seed({ stripe, sql, dryRun: process.argv.includes('--dry-run') });
    if (process.argv.includes('--portal')) console.log('STRIPE_PORTAL_CONFIG_ID =', await createPortalConfig({ stripe, siteUrl: process.env.SITE_URL || 'https://binfreshdevon.co.uk' }));
  } finally { await sql.end(); }
}

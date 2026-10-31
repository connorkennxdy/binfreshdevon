// Creates the Stripe catalogue from the services table and writes the price IDs back (§5.1).
// Idempotent: products have fixed IDs (bf_<slug>), prices are found by lookup_key. A price whose amount
// no longer matches the services table gets a new Price (lookup_key transferred) and the old one archived.
//
//   STRIPE_SECRET_KEY=sk_test_... SUPABASE_DB_URL=postgres://... node scripts/stripe-seed.mjs [--portal] [--dry-run]
import { fileURLToPath } from 'node:url';
import { seed, createPortalConfig } from '../netlify/functions/lib/stripe-catalogue.mjs';
export { seed, createPortalConfig, lookupKeys } from '../netlify/functions/lib/stripe-catalogue.mjs';

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

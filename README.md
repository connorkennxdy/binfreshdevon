# Bin Fresh Devon: site, bookings and rounds app

One Netlify project, two hostnames:

| URL | Who | What |
|---|---|---|
| `binfreshdevon.co.uk` | Customers | Marketing site, `/book` (booking + Stripe Checkout), `/manage` (reschedule, cancel, update card) |
| `app.binfreshdevon.co.uk` | Tom, Connor | Bin Fresh Rounds: Today, Calendar, Customers, Money, Settings (installable on iPhone) |

Stack: static HTML/CSS/JS (no build step) in `public/`, Netlify Functions in `netlify/functions/` (Node 20, ESM), Postgres on Supabase, Stripe, Google Calendar, Resend, Twilio. See `HANDOFF.md` for the status of every acceptance test and what's left to do.

## Layout

```
public/                  marketing site + book/ + manage/ + app/   (_headers, _redirects)
netlify/functions/
  lib/                   db, auth, http, stripe, stripe-catalogue, catalogue, availability, booking, calendar, notify, jobs, admin, time, money, store, env
  public-*.mjs           /api/services, /api/postcode, /api/availability, /api/quote-price, /api/checkout, /api/booking-status, /api/manage/*, /m/:code
  admin-*.mjs            /api/admin/* (app host only, session required)
  google-oauth.mjs       /api/google/signin | calendar | callback
  stripe-webhook.mjs     /api/stripe/webhook
  calendar-ics.mjs       /api/calendar.ics?k=…  (fallback feed)
  cron-*.mjs             generate-visits (02:00 UTC), reminders (hourly, acts 17:00 UK), calendar-reconcile (hourly), backup (03:00 UTC)
supabase/migrations/     0001_init.sql
scripts/                 stripe-seed.mjs, run-tests.mjs, test-stripe-live.mjs, test-hosting.mjs, dev-local.mjs, tests/
```

## Running the tests

Needs a Postgres 15+ server you can create databases on (Supabase isn't needed; tests run against a local cluster, with Supabase's `anon`/`authenticated` roles emulated).

```bash
npm install
# e.g. with Docker:  docker run -d -p 54329:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres npm test          # 41 tests, ~10s
STRIPE_SECRET_KEY=sk_test_... npm run test:stripe-live                      # P2-6 on real Stripe with a test clock
node scripts/test-hosting.mjs                                               # P0-3 against the deployed site
```

`npm test` uses an in-process fake Stripe and fake Resend/Twilio/Google, so it proves our logic, not Stripe's behaviour. `test:stripe-live` proves Stripe's.

## Local preview (no Netlify CLI, no real Stripe)

```bash
TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres node scripts/dev-local.mjs --seed-demo
```

- Booking: <http://localhost:8888/book>. Checkout goes to a local fake Stripe page.
- Rounds app: <http://app.localhost:8888/> (passcode `letmein`).
- Manage page as a customer: `http://localhost:8888/__magic?email=jason@example.com`

`netlify dev` also works once env vars are set, but host-based rewrites to the app need the real domain.

## Setting up a fresh environment

1. **Supabase**: create a project in `eu-west-2` (London). Run `supabase/migrations/0001_init.sql` in the SQL editor. Copy the transaction pooler connection string into `SUPABASE_DB_URL`.
2. **Stripe** (Tom's account, test mode first): set `STRIPE_SECRET_KEY`, then `node scripts/stripe-seed.mjs --portal` (creates products and prices, writes price IDs to `services`, prints `STRIPE_PORTAL_CONFIG_ID`). Add a webhook endpoint `https://binfreshdevon.co.uk/api/stripe/webhook` for: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`. Turn on Smart Retries, customer emails for successful payments and refunds, and the "update payment method" emails for failed payments.
3. **Google**: Cloud project → enable Google Calendar API → OAuth consent screen (External, **publish to In production**) → OAuth client (Web) with redirect URI `https://app.binfreshdevon.co.uk/api/google/callback`.
4. **Resend**: add and verify the `binfreshdevon.co.uk` domain (DNS records at Namecheap/Netlify DNS).
5. **Twilio**: register the alphanumeric sender ID `BinFresh` for the UK.
6. **Netlify**: add `app.binfreshdevon.co.uk` as a domain alias (DNS: `CNAME app → binfreshdevon.netlify.app`). Set all env vars from `.env.example`. Set Functions region to London or Dublin (Project configuration → Build & deploy → Functions region) so functions sit next to the database.
7. In the app: Settings → Connect Google Calendar, set alert email and mobile, send a test SMS and email.

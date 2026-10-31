# Bin Fresh: Rounds & Bookings — build status

Built 31 Oct 2026 against the handoff spec. Everything in the spec is implemented. All 50 automated tests pass locally against Postgres 16 with fake Stripe/Resend/Twilio/Google. Anything that needs real accounts, a deploy or an iPhone is still to do, and is listed below.

## Branches

| Branch | Contents | Deploy |
|---|---|---|
| `main` | Phase 0 only: the live site as served on 31 Oct (plus the restored Netlify Forms attributes), `netlify.toml`, `_redirects`, `_headers` | Link the Netlify project to this first and run P0-1/P0-2/P0-3 |
| `build` | Everything (Phases 0–8 code) | Deploy as a branch deploy for testing; merge to `main` at go-live |

Merging `build` replaces the Square booking on the live site, so don't merge until Stripe, Supabase, Resend and Twilio are configured (see Go-live).

## Acceptance tests

⚙ = automated (`npm test`). ☐ = manual / needs real services.

| Test | Status |
|---|---|
| ☐ P0-1 push deploys, site byte-identical | Ready: `node scripts/test-hosting.mjs --phase0` after linking `main`. index/styles/main.js are byte-identical to the live deploy as served |
| ☐ P0-2 quote form reaches Netlify Forms and Make | Needs a deploy. See "Netlify Forms" below: this was at risk and is fixed |
| ⚙ P0-3 `/app/` 404 on marketing host, app on `app.` | Rules tested locally; `scripts/test-hosting.mjs` checks the deployed result |
| ⚙ P1-1 migration, RLS on, anon reads nothing | Pass |
| ⚙ P1-2 seed idempotent, prices match §2.3, 4-weekly recurs every 4 weeks | Pass (fake Stripe) |
| ⚙ P1-3 `book_slot` never exceeds cap, 20 parallel | Pass (exactly 6 of 20 succeed) |
| ⚙ P2-1 availability rules, incl. BST→GMT cut-off | Pass |
| ⚙ P2-2 tampered price/service ignored or rejected | Pass |
| ⚙ P2-3 out-of-area refused by API | Pass |
| ⚙ P2-4 one-off: paid, payment recorded, email sent | Pass |
| ⚙ P2-5 abandoned checkout frees slot | Pass |
| ⚙ P2-6 4-weekly billing (critical) | Our side passes against the fake. **Real Stripe not yet run:** `STRIPE_SECRET_KEY=sk_test_… npm run test:stripe-live` (test clock, fully automatic; add `--checkout` to also go through a real Checkout page). Stripe's docs confirm the model: one-time items on a trialing subscription are invoiced immediately, recurring billing starts at trial end |
| ⚙ P2-7 duplicate webhook processed once | Pass |
| ☐ P2-8 full booking on a real iPhone | Checked in Chromium at iPhone 13 size (screenshots in the session); needs a real device |
| ☐ P2-9 marketing site updated, Rich Results valid | Copy, prices, JSON-LD done; all JSON-LD parses. Run Google's Rich Results Test after deploy |
| ⚙ P3-1 401 without session, passcode, Google allowlist | Pass |
| ☐ P3-2 installs to iPhone home screen | Manifest, icons, apple-touch-icon in place; needs a device |
| ⚙/☐ P3-3 Today with 10 visits | API half passes (totals, done, skip, reorder persist). Maps/Call/Text need a device |
| ⚙ P3-4 block a day with visits → move + notify | Pass |
| ⚙ P4-1 generation idempotent, 8 weeks | Pass |
| ⚙ P4-2 blocked day → move within 3 days, keeps original_date | Pass, and the renewal still pays the moved visit |
| ⚙ P4-3 failed payment → flagged, Tom emailed once, banner | Pass (test card `4000 0000 0000 0341` needs the live-mode run) |
| ⚙ P4-4 reminder once at 17:00 UK across clocks change | Pass |
| ☐ P4-5 real SMS from "BinFresh" | Needs Twilio + sender ID |
| ☐ P5-1 connect creates "Bin Fresh Rounds" on iPhone | Flow passes against fake Google; needs Tom's account |
| ⚙ P5-2 create/reschedule/cancel → event created/moved/deleted | Pass (immediate, not just within 1 min) |
| ⚙ P5-3 Google errors → reconcile retries, nothing lost | Pass |
| ☐ P5-4 refresh token works 8+ days later | Publish the consent screen to In production, then check on day 9 |
| ⚙ P6-1 magic link, expired/wrong refused, lost-link neutral | Pass |
| ⚙ P6-2 reschedule 25h ok, 23h refused | Pass |
| ⚙ P6-3 cancel plan per §2.6 | Pass |
| ☐ P6-4 update card via portal | Portal session is created with `payment_method_update` only (tested); real card swap needs Stripe |
| ⚙ P7-1 money matches Stripe | Pass against the fake's own charge/fee/refund records; repeat against the real dashboard |
| ☐ P7-2 Money screen readable on iPhone | Checked at iPhone 13 size |

## Independent review of the payment code

A separate reviewer went through the money paths before handover and found nine issues the tests didn't cover. All are fixed, and each has a regression test in `scripts/tests/r-review-fixes.test.mjs`:

1. **Account takeover by email (high).** A booking with an existing customer's email used to overwrite their phone before payment, which would route their magic-link texts to whoever typed it. Now an existing customer record is never changed by an unpaid booking. Once paid, the address is applied but a different phone is only flagged for Tom.
2. **Pause → resume charged for a cancelled visit (high).** Resume now recreates the visit, and any payment that lands on a non-scheduled visit is flagged and emailed to Tom.
3. **A webhook killed mid-way was never retried (high).** Event claims now record `processed_at`; a claim stuck for 5+ minutes is reprocessed on Stripe's retry.
4. **Last-slot race at the 30-minute mark.** The slot hold now outlives the Checkout session by 15 minutes.
5. **A renewal invoice with an extra item could pay the wrong visit.** Visits are now matched from the subscription line only.
6. **Refund amounts.** Refunds are capped at what's left on the charge and recorded once.
7. **Two open checkouts for one customer.** Starting a new one expires the older tab.
8. **Moving a plan before its paid first clean double-charged.** Now refused with a clear message.
9. **Async payment methods.** Checkout is card-only (Apple Pay and Google Pay still work).

## Where I deviated from the spec, and why

1. **`window` column is `time_window`.** `WINDOW` is a reserved word in Postgres; values are unchanged (`'14-16'`, `'16-18'`).
2. **Database access uses the `postgres` driver over Supabase's transaction pooler, not `@supabase/supabase-js`.** The capacity guarantee needs real transactions with an advisory lock, and the whole test suite runs against a plain Postgres. RLS is still on with no policies, so the anon key reads nothing (P1-1 proves it). The secret is now `SUPABASE_DB_URL` (pooler connection string) instead of `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
3. **SMS links use a 12-character code, email links the full 32-byte token.** A 32-byte token makes the reminder 190+ characters (two SMS segments). Codes are 71 bits, hashed at rest, 90-day expiry, and `/m/` is rate-limited per IP. The reminder also uses `2-4pm` with a hyphen: the en dash in the spec template switches the whole SMS to UCS-2 (70 characters a segment, so 3 segments). Worst case is now 155 characters, one segment.
4. **Card-update links send the manage link, not a Customer Portal URL.** Portal session URLs expire after a few minutes, too short for an email or text. "Update card" on `/manage` opens a fresh portal session.
5. **Extra columns:** `visits.booking_details` (see review fix 1), `payments.refund_ids`, `stripe_events.processed_at`.
6. **Extra tables:** `capacity_overrides` (Tom's per-day caps), `price_changes` (14-day notice, applied by the daily job the day before), `message_log` (every email/SMS, IDs and template names only, no message bodies).
7. **Customers can cancel a one-off visit** on `/manage` (refunded, 24h+ before). §2.6 only lists plan cancellation, but §2.7 promises free cancellation for every visit.
8. **Hold = 46 minutes, Checkout session = 31.** Stripe requires a session to live at least 30 minutes; the hold outlives it so a last-second payment keeps its slot.
9. **Pause plan** uses Stripe `pause_collection: void` and cancels future unpaid visits. **Resume** asks for a next visit date and re-anchors billing there (same mechanism as "move cadence").

## Things I found that you should know

- **Netlify Forms would have broken on the first Git deploy.** The live HTML is Netlify's post-processed output, which strips `data-netlify` and `netlify-honeypot` from the form. Deploying it as-is would have unregistered the quote form. I restored both attributes (`data-netlify='true' netlify-honeypot='bf-check'`, matching the registered form, which has a honeypot). Netlify strips them again on deploy, so the served page stays identical. If your byte-exact source copy differs from `public/`, use yours for everything except `public/_headers`, `_redirects`, and the Phase 2 changes.
- **`_headers` is reconstructed** from the live response headers (your copy wasn't available to me). Swap in yours if it differs.
- **Header rules on the rewritten app host:** Netlify's docs don't say whether `_headers` match the request path (`/`) or the rewritten path (`/app/`). The app also carries a robots meta tag and a JS frame-buster, and function responses set `X-Robots-Tag`/`X-Frame-Options` in code. `scripts/test-hosting.mjs` reports which applies.
- **Functions region:** the database should be in London/Dublin and functions default to Ohio. Set the Functions region to `lhr` or `dub` in the Netlify UI (your team plan allows it), or bookings will feel slow.
- **Supabase free tier:** the org already has two projects (the free limit). "connorkennxdy's Project" (26 Oct) may be spare; otherwise pause one or create Bin Fresh's under Tom's own Supabase account (better for handover anyway).
- **Deep clean** is one £17.50 add-on per booking (toggle), per the spec. The old site said "£20 per bin". If it should be per bin, it's a one-line change to make it a quantity.
- **Commercial 240L/360L prices** (£14/£9, £18/£12) in the commercial table aren't in §2.3, so I left them. They're quote-only anyway.
- **Opening hours** in the LocalBusiness JSON-LD now say Mon–Sat 14:00–18:00 (they listed Sunday before).

## Open items (§15) still needed from Connor

1. Online-bookable services: seeded with the default (household 1/2/3, 360L, deep clean online; commercial quote-only). Toggle in Settings → Services.
2. Tom's Stripe account, with Connor as Developer.
3. Tom's Google email → `ADMIN_EMAILS`.
4. Tom's alert email and mobile → Settings in the app.
5. Third Square customer: name and next due date.
6. Contact email: the site shows `info@binfreshdevon.com` (.com). Bookings send from `bookings@binfreshdevon.co.uk`. Set `EMAIL_REPLY_TO` to whichever mailbox exists.
7. Build price with Tom.

## Go-live (Phase 8)

1. Live Stripe: switch keys, create the live webhook endpoint, run `node scripts/stripe-seed.mjs --portal` with the live key, set `STRIPE_PORTAL_CONFIG_ID`.
2. Verify Resend domain, register the Twilio sender, publish the Google consent screen.
3. Merge `build` → `main`.
4. In the app: Customers → Add customer → "From Square" for Jason Wonnacott (next due Wed 25 Nov), Steph Cleak (Fri 20 Nov) and the third customer. Each gets a "Confirm your plan" email and text (card only, nothing charged until the due date at 7am). The link lasts 23 hours (Stripe's Checkout maximum is 24h), so resend from the customer page if it lapses.
5. Once each confirms, end their Square recurring appointment and any Square recurring invoice.
6. Live test: book a one-off with your own card, Tom marks it done, refund it from the app; check Stripe, the app and Google Calendar.
7. Replace the Square link on Google Business Profile once it exists.

## Running costs

Unchanged from the spec: £0 fixed on Netlify/Supabase free/Resend free/Google, about 4p per SMS. Backups go to Netlify Blobs (30 days). The daily job keeps the free Supabase project awake.

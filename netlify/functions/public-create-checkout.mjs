// POST /api/checkout — validate everything server-side, hold the slot, create the Stripe Checkout Session.
import { handler, json, readJson, rateLimit, clientIp, HttpError } from './lib/http.mjs';
import { createBookingCheckout } from './lib/booking.mjs';

export default handler(async (req, context) => {
  const body = await readJson(req);
  if (String(body['bf-check'] || '').trim()) return json({ error: 'Something went wrong. Please try again.' }, 400); // honeypot
  if (!(await rateLimit('book', clientIp(req, context), 5, 600))) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.', 'rate_limited');
  const r = await createBookingCheckout(body);
  return json({ url: r.url });
});

export const config = { path: '/api/checkout', method: ['POST'] };

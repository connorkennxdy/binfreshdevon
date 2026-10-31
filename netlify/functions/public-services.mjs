// GET /api/services  — catalogue + booking settings for the booking page
// GET /api/postcode?pc=EX31 1AA — is this postcode in the online-booking area?
import { handler, json } from './lib/http.mjs';
import { listServices, publicService } from './lib/catalogue.mjs';
import { getSettings } from './lib/db.mjs';
import { inServiceArea } from './lib/booking.mjs';
import { bookingRange } from './lib/availability.mjs';
import { windowLabel } from './lib/time.mjs';

export default handler(async (req) => {
  const url = new URL(req.url);
  if (url.pathname === '/api/postcode') {
    const r = await inServiceArea(url.searchParams.get('pc') || '');
    return json({ ok: r.ok, reason: r.ok ? null : r.reason, postcode: r.postcode || null });
  }
  const [services, s] = await Promise.all([listServices({ onlineOnly: true }), getSettings()]);
  return json({
    services: services.map(publicService),
    windows: s.windows.map((w) => ({ id: w.id, label: windowLabel(w), start: w.start, end: w.end })),
    range: bookingRange(s),
    vat_registered: !!s.vat_registered,
  }, 200, { 'cache-control': 'public, max-age=60' });
});

export const config = { path: ['/api/services', '/api/postcode'], method: ['GET'] };

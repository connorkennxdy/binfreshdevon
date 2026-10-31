// GET /api/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
import { handler, json } from './lib/http.mjs';
import { availability } from './lib/availability.mjs';

export default handler(async (req) => {
  const u = new URL(req.url);
  const { days } = await availability(u.searchParams.get('from'), u.searchParams.get('to'));
  return json({ days: days.map((d) => ({ date: d.date, bookable: d.bookable, reason: d.reason, windows: d.windows.map((w) => ({ id: w.id, label: w.label, left: w.left })) })) });
});

export const config = { path: '/api/availability', method: ['GET'] };

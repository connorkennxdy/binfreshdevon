// POST /api/quote-price {plan, items, deep_clean} -> the server's price (what will actually be charged)
import { handler, json, readJson } from './lib/http.mjs';
import { priceBooking } from './lib/catalogue.mjs';

export default handler(async (req) => {
  const b = await readJson(req);
  const p = await priceBooking(b.plan, b.items, !!b.deep_clean);
  return json({ first_pence: p.firstPence, recurring_pence: p.recurringPence, summary: p.summary,
    lines: p.lines.map((l) => ({ slug: l.service.slug, name: l.service.name, qty: l.qty, unit_pence: l.unit, kind: l.kind })) });
});

export const config = { path: '/api/quote-price', method: ['POST'] };

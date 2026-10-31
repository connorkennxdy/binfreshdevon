// Services and server-side pricing. Prices from the browser are never trusted.
import { db } from './db.mjs';
import { bad } from './http.mjs';

export async function listServices({ onlineOnly = false } = {}) {
  const sql = db();
  return sql`select * from services where active ${onlineOnly ? sql`and online_bookable` : sql``} order by sort, name`;
}

export function publicService(s) {
  return {
    slug: s.slug, name: s.name, category: s.category, photo: s.photo,
    one_off_pence: s.price_one_off_pence, recurring_pence: s.price_recurring_pence,
  };
}

const HOUSEHOLD_TIERS = ['household-1', 'household-2', 'household-3'];
export const MAX_QTY = { 'household-360': 3, 'commercial-660': 6, 'commercial-1100': 6 };

/**
 * Price a booking.
 * @param {'recurring'|'one-off'} planType
 * @param {Record<string, number>} items  slug -> qty (main services only)
 * @param {boolean} deepClean            one-off add-on
 * @param {{ onlineOnly?: boolean }} opts
 * @returns {{ lines, firstPence, recurringPence, summary }}
 *   lines: [{ service, qty, unit, kind: 'recurring'|'first'|'one-off'|'addon' }]
 */
export async function priceBooking(planType, items, deepClean, { onlineOnly = true } = {}) {
  if (planType !== 'recurring' && planType !== 'one-off') throw bad('Choose every 4 weeks or a one-off clean.', 'plan');
  if (!items || typeof items !== 'object' || Array.isArray(items)) throw bad('Choose at least one bin.', 'items');
  const services = await listServices({ onlineOnly });
  const bySlug = new Map(services.map((s) => [s.slug, s]));
  const chosen = Object.entries(items).filter(([, q]) => Number(q) > 0);
  if (!chosen.length) throw bad('Choose at least one bin.', 'items');
  if (chosen.length > 6) throw bad('Too many items.', 'items');
  if (chosen.filter(([slug]) => HOUSEHOLD_TIERS.includes(slug)).length > 1) throw bad('Choose one of 1, 2 or 3 household bins.', 'items');

  const lines = [];
  for (const [slug, rawQty] of chosen) {
    const s = bySlug.get(slug);
    if (!s || s.category === 'addon') throw bad('That service can\'t be booked online. Ask us for a quote instead.', 'service');
    const qty = Number(rawQty);
    const max = HOUSEHOLD_TIERS.includes(slug) ? 1 : (MAX_QTY[slug] || 3);
    if (!Number.isInteger(qty) || qty < 1 || qty > max) throw bad(`Quantity for ${s.name} must be between 1 and ${max}.`, 'qty');
    const unit = planType === 'recurring' ? s.price_recurring_pence : s.price_one_off_pence;
    if (unit == null) throw bad(`${s.name} isn't available ${planType === 'recurring' ? 'every 4 weeks' : 'as a one-off'}.`, 'service');
    lines.push({ service: s, qty, unit, kind: planType === 'recurring' ? 'recurring' : 'one-off' });
  }
  if (deepClean) {
    const dc = bySlug.get('deep-clean');
    if (!dc || dc.price_one_off_pence == null) throw bad('Deep clean isn\'t available online.', 'service');
    lines.push({ service: dc, qty: 1, unit: dc.price_one_off_pence, kind: 'addon' });
  }
  const main = lines.filter((l) => l.kind !== 'addon');
  const addon = lines.filter((l) => l.kind === 'addon');
  const mainTotal = main.reduce((a, l) => a + l.unit * l.qty, 0);
  const addonTotal = addon.reduce((a, l) => a + l.unit * l.qty, 0);
  return {
    lines,
    firstPence: mainTotal + addonTotal,                 // paid today
    recurringPence: planType === 'recurring' ? mainTotal : 0, // then each 4-weekly clean
    summary: describeItems(lines.map((l) => ({ name: l.service.name, slug: l.service.slug, qty: l.qty }))),
  };
}

// "2 household bins + 360L household bin ×2 + deep clean"
export function describeItems(items) {
  return items.map((i) => {
    if (i.slug === 'deep-clean') return 'deep clean';
    return i.qty > 1 ? `${i.name} ×${i.qty}` : i.name;
  }).join(' + ');
}

// Short form for calendar titles: "2 bins", "3 bins + 360L", "1,100L ×2"
export function shortItems(items) {
  const parts = [];
  for (const i of items) {
    if (i.slug === 'household-1') parts.push('1 bin');
    else if (i.slug === 'household-2') parts.push('2 bins');
    else if (i.slug === 'household-3') parts.push('3 bins');
    else if (i.slug === 'household-360') parts.push(i.qty > 1 ? `360L ×${i.qty}` : '360L');
    else if (i.slug === 'commercial-660') parts.push(i.qty > 1 ? `660L ×${i.qty}` : '660L');
    else if (i.slug === 'commercial-1100') parts.push(i.qty > 1 ? `1,100L ×${i.qty}` : '1,100L');
    else if (i.slug === 'deep-clean') parts.push('deep');
    else parts.push(i.name);
  }
  return parts.join(' + ');
}

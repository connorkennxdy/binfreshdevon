// GET  /m/:code               — redeem a magic link, set the manage cookie, go to /manage
// POST /api/manage/lost-link  — email a fresh link (same reply whether or not the email exists)
import { handler, json, redirect, readJson, rateLimit, clientIp } from './lib/http.mjs';
import { redeemManageToken, manageSessionCookie } from './lib/auth.mjs';
import { db } from './lib/db.mjs';
import { manageLinkEmail } from './lib/notify.mjs';

const NEUTRAL = 'If we have a booking for that email, we\'ve sent a new link. Check your inbox (and spam folder).';

export default handler(async (req, context) => {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname.startsWith('/m/')) {
    if (!(await rateLimit('m', clientIp(req, context), 30, 600))) return redirect('/manage/?e=busy');
    const code = context?.params?.code || url.pathname.slice(3);
    const customerId = await redeemManageToken(code);
    if (!customerId) return redirect('/manage/?e=expired');
    return redirect('/manage/', { 'set-cookie': manageSessionCookie(customerId), 'referrer-policy': 'no-referrer' });
  }
  if (req.method === 'POST' && url.pathname === '/api/manage/lost-link') {
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
    if (String(b['bf-check'] || '').trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ message: NEUTRAL });
    const okEmail = await rateLimit('lostlink', email, 3, 3600);
    const okIp = await rateLimit('lostlink-ip', clientIp(req, context), 10, 3600);
    if (okEmail && okIp) {
      const [c] = await db()`select * from customers where lower(email) = ${email}`;
      if (c) await manageLinkEmail({ customer: c });
    }
    return json({ message: NEUTRAL });
  }
  return json({ error: 'Not found' }, 404);
});

export const config = { path: ['/m/:code', '/api/manage/lost-link'], method: ['GET', 'POST'] };

// /api/admin/session — GET (who am I), POST {passcode}, DELETE (sign out). KWT passcode flow + shared session.
import { handler, adminJson, readJson, requireAppHost } from './lib/http.mjs';
import { checkPasscode, adminSessionCookie, clearAdminCookie, adminSession, passcode } from './lib/auth.mjs';
import { audit } from './lib/db.mjs';
import { env } from './lib/env.mjs';

export default handler(async (req) => {
  requireAppHost(req);
  if (req.method === 'GET') {
    const s = adminSession(req);
    return adminJson({ authed: !!s, actor: s?.actor || null, passcode_configured: !!passcode(), google_configured: !!(env('GOOGLE_CLIENT_ID') && env('ADMIN_EMAILS')) });
  }
  if (req.method === 'DELETE') return adminJson({ ok: true }, 200, { 'set-cookie': clearAdminCookie() });
  if (req.method !== 'POST') return adminJson({ error: 'method' }, 405);
  if (!passcode()) return adminJson({ error: 'The APP_PASSCODE environment variable is not set.' }, 503);
  const body = await readJson(req);
  await new Promise((r) => setTimeout(r, 400)); // blunt brute forcing
  if (!checkPasscode(body.passcode ?? '')) return adminJson({ error: 'That passcode is not right.' }, 401);
  await audit('passcode', 'session.signin', 'admin', null, {});
  return adminJson({ ok: true, actor: 'passcode' }, 200, { 'set-cookie': adminSessionCookie('passcode') });
}, { admin: true });

export const config = { path: '/api/admin/session' };

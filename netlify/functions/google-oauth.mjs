// Google OAuth for two things, one callback URL (register https://app.binfreshdevon.co.uk/api/google/callback):
//   GET /api/google/signin    — Sign in with Google (openid email); only ADMIN_EMAILS get in
//   GET /api/google/calendar  — Connect Tom's calendar (needs an admin session; state is bound to it)
//   GET /api/google/callback
import { randomBytes } from 'node:crypto';
import { handler, redirect, requireAppHost, HttpError } from './lib/http.mjs';
import { adminSession, adminSessionCookie, adminEmails, oauthStateCookie, readOauthState, clearOauthCookie } from './lib/auth.mjs';
import { env, appUrl } from './lib/env.mjs';
import { audit } from './lib/db.mjs';
import { connectCalendar, CALENDAR_SCOPE } from './lib/calendar.mjs';

const AUTH = () => env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth');
const TOKEN = () => env('GOOGLE_OAUTH_BASE', 'https://oauth2.googleapis.com') + '/token';
const USERINFO = () => env('GOOGLE_USERINFO_URL', 'https://openidconnect.googleapis.com/v1/userinfo');
const callback = () => `${appUrl()}/api/google/callback`;

function start(purpose, nonce, scope, extra = {}) {
  const state = `${purpose}.${nonce}.${randomBytes(16).toString('base64url')}`;
  const q = new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), redirect_uri: callback(), response_type: 'code', scope, state, ...extra });
  return redirect(`${AUTH()}?${q}`, { 'set-cookie': oauthStateCookie(state) });
}

export default handler(async (req) => {
  requireAppHost(req);
  if (!env('GOOGLE_CLIENT_ID')) throw new HttpError(503, 'Google sign-in is not configured.');
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/$/, '');
  if (p === '/api/google/signin') return start('signin', '-', 'openid email', { prompt: 'select_account' });
  if (p === '/api/google/calendar') {
    const s = adminSession(req);
    if (!s) return redirect(`${appUrl()}/#/signin`);
    return start('calendar', s.nonce, `openid email ${CALENDAR_SCOPE()}`, { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' });
  }
  if (p !== '/api/google/callback') throw new HttpError(404, 'Not found');

  const expected = readOauthState(req);
  const state = url.searchParams.get('state') || '';
  const fail = (msg) => redirect(`${appUrl()}/#/${state.startsWith('calendar') ? 'settings' : 'signin'}?error=${encodeURIComponent(msg)}`, { 'set-cookie': clearOauthCookie() });
  if (!expected || expected !== state) return fail('Sign-in expired. Please try again.');
  if (url.searchParams.get('error')) return fail('Google sign-in was cancelled.');
  const [purpose, nonce] = state.split('.');
  if (purpose === 'calendar') {
    const s = adminSession(req);
    if (!s || s.nonce !== nonce) return fail('Your session changed. Please try again.');
  }
  const r = await fetch(TOKEN(), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), redirect_uri: callback(), grant_type: 'authorization_code' }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.access_token) return fail('Google sign-in failed. Please try again.');
  const ui = await fetch(USERINFO(), { headers: { authorization: `Bearer ${tok.access_token}` } }).then((x) => x.json()).catch(() => ({}));
  const email = String(ui.email || '').toLowerCase();
  if (!email || ui.email_verified === false) return fail('Google did not confirm your email address.');

  if (purpose === 'signin') {
    if (!adminEmails().includes(email)) { await audit(email, 'session.refused', 'admin', null, {}); return fail(`${email} doesn't have access to Bin Fresh Rounds.`); }
    await audit(email, 'session.signin', 'admin', null, { method: 'google' });
    const h = new Headers({ location: `${appUrl()}/#/today`, 'cache-control': 'no-store' });
    h.append('set-cookie', adminSessionCookie(email));
    h.append('set-cookie', clearOauthCookie());
    return new Response(null, { status: 302, headers: h });
  }
  if (!tok.refresh_token) return fail('Google did not return offline access. Remove the app from your Google account permissions and try again.');
  try {
    await connectCalendar({ refreshToken: tok.refresh_token, email });
  } catch (e) {
    console.error('calendar connect failed', e.message);
    return fail('Connected to Google but could not create the calendar. Check the Calendar API is enabled.');
  }
  await audit(adminSession(req).actor, 'calendar.connect', 'settings', null, { email });
  return redirect(`${appUrl()}/#/settings?calendar=connected`, { 'set-cookie': clearOauthCookie() });
}, { admin: true });

export const config = { path: ['/api/google/signin', '/api/google/calendar', '/api/google/callback'], method: ['GET'] };

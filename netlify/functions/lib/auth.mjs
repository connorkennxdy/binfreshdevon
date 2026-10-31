// Admin sessions (Tom & Connor) and customer manage sessions.
// Admin: passcode (KWT implementation) or Google sign-in, both issue the same HMAC-signed bf_session cookie.
// Customers: magic links (/m/<code>) -> bf_manage cookie scoped to one customer.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { env } from './env.mjs';
import { db } from './db.mjs';
import { cookie, hash, HttpError } from './http.mjs';
import { now } from './time.mjs';

const ADMIN_COOKIE = 'bf_session';
const ADMIN_MAX_AGE = 60 * 60 * 24 * 30;
const MANAGE_COOKIE = 'bf_manage';
const MANAGE_MAX_AGE = 60 * 60 * 24 * 7;
export const MANAGE_TOKEN_DAYS = 90;

// Fail closed: no SESSION_SECRET (or passcode-derived secret) = nobody can sign in.
const secret = () => env('SESSION_SECRET') || (env('APP_PASSCODE') ? `bf:${env('APP_PASSCODE')}` : '');
export const passcode = () => env('APP_PASSCODE');
export const adminEmails = () => env('ADMIN_EMAILS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');
function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkPasscode(given) {
  const real = passcode();
  if (!real) return false;
  const h = (s) => createHmac('sha256', 'cmp').update(String(s)).digest();
  return timingSafeEqual(h(given), h(real));
}

function signed(value) { return `${value}.${sign(value)}`; }
function unsign(raw) {
  if (!raw || !secret()) return null;
  const i = raw.lastIndexOf('.');
  if (i < 1) return null;
  const value = raw.slice(0, i), sig = raw.slice(i + 1);
  return same(sig, sign(value)) ? value : null;
}

// Session payload: exp|actor(base64url)|nonce. SameSite=Lax so the Google redirect back works.
export function adminSessionCookie(actor) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_MAX_AGE;
  const value = signed(`${exp}|${Buffer.from(actor).toString('base64url')}|${randomBytes(8).toString('base64url')}`);
  return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ADMIN_MAX_AGE}`;
}
export const clearAdminCookie = () => `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function adminSession(req) {
  const v = unsign(cookie(req, ADMIN_COOKIE));
  if (!v) return null;
  const [exp, actorB64, nonce] = v.split('|');
  if (!(Number(exp) > Math.floor(Date.now() / 1000))) return null;
  const actor = Buffer.from(actorB64 || '', 'base64url').toString();
  if (actor !== 'passcode' && !adminEmails().includes(actor)) return null; // removed from the allowlist = signed out
  if (actor === 'passcode' && !passcode()) return null;
  return { actor, nonce };
}

export function requireAdmin(req) {
  const s = adminSession(req);
  if (!s) throw new HttpError(401, 'Sign in required', 'unauthenticated');
  return s;
}

// Short-lived signed cookie for OAuth state (bound to purpose, and to the admin session for calendar connects).
export function oauthStateCookie(state) {
  const exp = Math.floor(Date.now() / 1000) + 600;
  return `bf_oauth=${signed(`${exp}|${state}`)}; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}
export function readOauthState(req) {
  const v = unsign(cookie(req, 'bf_oauth'));
  if (!v) return null;
  const i = v.indexOf('|');
  if (!(Number(v.slice(0, i)) > Math.floor(Date.now() / 1000))) return null;
  return v.slice(i + 1);
}
export const clearOauthCookie = () => 'bf_oauth=; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

// ----- customer magic links -----
// Email links carry a 32-byte token. SMS links carry a 12-character base62 code (~71 bits) so the
// reminder fits one 160-character GSM-7 segment. Both are stored only as SHA-256 hashes, expire after
// 90 days, and /m/ redemption is rate-limited per IP.
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function shortCode(n = 12) {
  let out = '';
  while (out.length < n) for (const b of randomBytes(n * 2)) if (b < 248 && out.length < n) out += B62[b % 62];
  return out;
}
export async function createManageToken(customerId, { short = false } = {}) {
  const token = short ? shortCode() : randomBytes(32).toString('base64url');
  const exp = new Date(now().getTime() + MANAGE_TOKEN_DAYS * 86400000);
  await db()`insert into manage_tokens (token_hash, customer_id, expires_at) values (${hash(token)}, ${customerId}, ${exp})`;
  return token;
}

export async function redeemManageToken(token) {
  if (!token || typeof token !== 'string' || token.length < 12 || token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const [row] = await db()`select customer_id from manage_tokens where token_hash = ${hash(token)} and expires_at > ${now()}`;
  return row ? row.customer_id : null;
}

export function manageSessionCookie(customerId) {
  const exp = Math.floor(Date.now() / 1000) + MANAGE_MAX_AGE;
  return `${MANAGE_COOKIE}=${signed(`${exp}|${customerId}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MANAGE_MAX_AGE}`;
}
export const clearManageCookie = () => `${MANAGE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function manageCustomer(req) {
  const v = unsign(cookie(req, MANAGE_COOKIE));
  if (!v) return null;
  const [exp, id] = v.split('|');
  if (!(Number(exp) > Math.floor(Date.now() / 1000))) return null;
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}
export function requireManage(req) {
  const id = manageCustomer(req);
  if (!id) throw new HttpError(401, 'Your link has expired. Request a new one below.', 'unauthenticated');
  return id;
}

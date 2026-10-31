import { createHash } from 'node:crypto';
import { store } from './store.mjs';
import { appUrl } from './env.mjs';

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });

// Function responses don't get _headers; app-host API responses carry noindex in code.
export const adminJson = (body, status = 200, headers = {}) =>
  json(body, status, { 'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY', ...headers });

export const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...headers } });

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const bad = (msg, code = 'bad_request') => new HttpError(400, msg, code);

export async function readJson(req, limit = 20000) {
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, 'Request too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw bad('Invalid JSON'); }
}

// Wrap a handler: turns HttpError into JSON, hides internals, logs IDs only.
export function handler(fn, { admin = false } = {}) {
  const out = admin ? adminJson : json;
  return async (req, context) => {
    try {
      return await fn(req, context);
    } catch (e) {
      if (e instanceof HttpError) return out({ error: e.message, code: e.code }, e.status);
      console.error('handler error', new URL(req.url).pathname, e?.message, e?.stack?.split('\n')[1]?.trim());
      return out({ error: 'Something went wrong. Please try again.' }, 500);
    }
  };
}

export function clientIp(req, context) {
  return context?.ip || req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

export function cookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  const m = raw.split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

export const hash = (s) => createHash('sha256').update(String(s)).digest('hex');

// Fixed-window rate limit in Netlify Blobs. Approximate (no atomic increment), fine for abuse damping.
export async function rateLimit(bucket, key, limit, windowSeconds) {
  const s = store('ratelimit');
  const slot = Math.floor(Date.now() / 1000 / windowSeconds);
  const k = `${bucket}/${hash(key).slice(0, 24)}/${slot}`;
  const cur = Number((await s.get(k)) || 0);
  if (cur >= limit) return false;
  await s.set(k, String(cur + 1));
  return true;
}

export function requireAppHost(req) {
  // Admin APIs only answer on the app hostname (and localhost for dev/tests).
  const host = new URL(req.url).host;
  const allowed = new URL(appUrl()).host;
  if (host !== allowed && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && !host.endsWith('--binfreshdevon.netlify.app')) {
    throw new HttpError(404, 'Not found');
  }
}

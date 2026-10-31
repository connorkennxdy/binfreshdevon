// Local preview without Netlify or real Stripe: serves public/ and routes /api/* to the function handlers,
// backed by a throwaway database (local Postgres) and the fake Stripe / email / SMS / Google services.
//   TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres node scripts/dev-local.mjs [--port 8888] [--seed-demo]
// Open http://localhost:8888/book and http://app.localhost:8888/ (the rounds app).
// Checkout redirects to a local "fake Stripe" page that completes the payment via the webhook.
import http from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setup } from './test-support/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8888;
// make sure the template database exists
spawnSync(process.execPath, [path.join(root, 'scripts/run-tests.mjs'), '__none__'], { stdio: 'ignore', env: process.env });
const h = await setup();
delete process.env.BF_TEST_MODE; // real clock in the preview, but keep the in-memory blob store:
process.env.BF_TEST_MODE = '1';
process.env.SITE_URL = `http://localhost:${port}`;
process.env.APP_URL = `http://app.localhost:${port}`;

const fnDir = path.join(root, 'netlify/functions');
const routes = [];
for (const f of (await readdir(fnDir)).filter((x) => x.endsWith('.mjs'))) {
  const mod = await import(path.join(fnDir, f));
  const cfg = mod.config || {};
  if (!cfg.path) continue;
  const excluded = [].concat(cfg.excludedPath || []);
  for (const p of [].concat(cfg.path)) {
    const keys = [];
    const re = new RegExp('^' + p.replace(/\*/g, '.*').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ re, keys, mod, excluded: excluded.map((e) => new RegExp('^' + e.replace(/\*/g, '.*') + '$')) });
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' };

async function serveStatic(res, rel) {
  let p = path.join(root, 'public', decodeURIComponent(rel));
  if (!p.startsWith(path.join(root, 'public'))) { res.writeHead(403); return res.end(); }
  try {
    let s = await stat(p);
    if (s.isDirectory()) { p = path.join(p, 'index.html'); s = await stat(p); }
  } catch {
    try { await stat(p + '.html'); p += '.html'; } catch { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(await readFile(path.join(root, 'public/404.html'))); }
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(await readFile(p));
}

// Fake Stripe Checkout page: completes the session and fires the webhooks the real Stripe would.
async function fakeCheckout(req, res, url) {
  const sid = url.searchParams.get('s');
  const s = h.stripe.db.sessions[sid];
  if (!s) { res.writeHead(404); return res.end('no session'); }
  if (req.method === 'POST') {
    const { session, invoice } = h.stripe.completeSession(sid);
    await h.webhook('checkout.session.completed', session);
    if (invoice) await h.webhook('invoice.paid', invoice);
    res.writeHead(303, { location: s._params.success_url.replace('{CHECKOUT_SESSION_ID}', sid) });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px"><h1>Fake Stripe Checkout</h1><p>Mode: ${s.mode}. Charged today: £${(s.amount_total / 100).toFixed(2)}</p><form method=post><button style="font-size:18px;padding:12px 20px">Pay with test card 4242</button></form><p><a href="${s._params.cancel_url}">Back (cancel)</a></p>`);
}

http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/__fake-checkout') return fakeCheckout(req, res, url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/m/')) {
      const r = routes.find((x) => x.re.test(url.pathname) && !x.excluded.some((e) => e.test(url.pathname)));
      if (!r) { res.writeHead(404); return res.end(); }
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const body = await new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
      const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const out = await r.mod.default(request, { params, ip: req.socket.remoteAddress });
      const headers = Object.fromEntries(out.headers);
      // local http: drop Secure so cookies work on localhost
      const cookies = out.headers.getSetCookie ? out.headers.getSetCookie() : [];
      if (cookies.length) headers['set-cookie'] = cookies.map((c) => c.replace(/; Secure/g, ''));
      let text = await out.text();
      if (url.pathname === '/api/checkout' && out.status === 200) {
        const j = JSON.parse(text); const sid = Object.values(h.stripe.db.sessions).at(-1).id;
        j.url = `/__fake-checkout?s=${sid}`; text = JSON.stringify(j);
      }
      res.writeHead(out.status, headers);
      return res.end(text);
    }
    if (host.startsWith('app.')) return serveStatic(res, '/app' + (url.pathname === '/' ? '/' : url.pathname));
    if (url.pathname.startsWith('/app')) { res.writeHead(404); return res.end('404'); }
    return serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e); res.writeHead(500); res.end('dev server error');
  }
}).listen(port, () => console.log(`Bin Fresh local preview: http://localhost:${port}/book  ·  app: http://app.localhost:${port}/  (passcode: letmein)`));

if (process.argv.includes('--seed-demo')) {
  const { seedDemo } = await import('./test-support/demo-data.mjs');
  await seedDemo(h);
  console.log('demo data seeded');
}
process.on('SIGINT', async () => { await h.teardown(); process.exit(0); });

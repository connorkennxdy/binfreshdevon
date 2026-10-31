// P0-3 (static half): the routing rules that make the app host-only. The deployed half runs in scripts/test-hosting.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const redirects = readFileSync('public/_redirects', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
const headers = readFileSync('public/_headers', 'utf8');

test('P0-3 app host: /api passes through first, everything else rewrites to /app/', () => {
  const i = redirects.findIndex((r) => r[0] === 'https://app.binfreshdevon.co.uk/api/*');
  const j = redirects.findIndex((r) => r[0] === 'https://app.binfreshdevon.co.uk/*');
  assert.ok(i >= 0 && j > i, 'api rule must precede the catch-all');
  assert.deepEqual(redirects[i].slice(1), ['/api/:splat', '200!']);
  assert.deepEqual(redirects[j].slice(1), ['/app/:splat', '200!']);
});

test('P0-3 marketing host: /app/* is a 404', () => {
  const r = redirects.find((x) => x[0] === '/app/*');
  assert.deepEqual(r.slice(1), ['/404.html', '404']);
  const k = redirects.indexOf(r);
  assert.ok(k > redirects.findIndex((x) => x[0] === 'https://app.binfreshdevon.co.uk/*'), 'host rules first');
});

test('P0-3 app pages carry noindex and DENY framing', () => {
  const block = headers.split(/\n(?=\/)/).find((b) => b.startsWith('/app/*'));
  assert.match(block, /X-Robots-Tag: noindex, nofollow/);
  assert.match(block, /X-Frame-Options: DENY/);
  const html = readFileSync('public/app/index.html', 'utf8');
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
});

test('P0-1 marketing core files are untouched where required (quote form + Make webhook)', () => {
  const js = readFileSync('public/main.js', 'utf8');
  assert.match(js, /https:\/\/hook\.eu1\.make\.com\/k2xdbl3n6lku33rhid51jbjvkqyif5yb/);
  assert.match(js, /fetch\('\/', \{\s*method: 'POST'/);
  const html = readFileSync('public/index.html', 'utf8');
  assert.match(html, /data-netlify='true'/);
  assert.match(html, /netlify-honeypot='bf-check'/);
});

// Checks the DEPLOYED site (run after a deploy):
//   node scripts/test-hosting.mjs                 P0-3 (+ the security headers)
//   node scripts/test-hosting.mjs --phase0        P0-1: core marketing files byte-identical to the 31 Oct 2026 live site
//                                                 (only meaningful while main is at the Phase 0 commit)
import { createHash } from 'node:crypto';

const SITE = process.env.SITE_URL || 'https://binfreshdevon.co.uk';
const APP = process.env.APP_URL || 'https://app.binfreshdevon.co.uk';
let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? '✔' : '✖'} ${msg}`); if (!cond) failed++; };

if (process.argv.includes('--phase0')) {
  const BASELINE = { // sha256 of the live files, 31 Oct 2026 (served output)
    'index.html': '4cd72f837c23e279', 'styles.css': '81290e4c8aa05781', 'main.js': '2e3b0b0b996e6594',
  };
  for (const [f, want] of Object.entries(BASELINE)) {
    const body = Buffer.from(await (await fetch(`${SITE}/${f}`)).arrayBuffer());
    check(createHash('sha256').update(body).digest('hex').startsWith(want), `P0-1 ${f} byte-identical to the 31 Oct deploy`);
  }
}

const a = await fetch(`${SITE}/app/`, { redirect: 'manual' });
check(a.status === 404, `P0-3 ${SITE}/app/ returns 404 (got ${a.status})`);
const b = await fetch(`${APP}/`, { redirect: 'manual' });
const html = await b.text();
check(b.status === 200 && html.includes('Bin Fresh Rounds'), `P0-3 ${APP}/ serves the app shell (got ${b.status})`);
check(/noindex/.test(b.headers.get('x-robots-tag') || '') || /<meta name="robots" content="noindex,nofollow">/.test(html), 'P0-3 app shell is noindex (header or meta)');
check((b.headers.get('x-robots-tag') || '').includes('noindex'), `   X-Robots-Tag header on the rewritten app page: ${b.headers.get('x-robots-tag') || 'missing (Netlify matched headers on the request path; see HANDOFF)'}`);
check((b.headers.get('x-frame-options') || '').toUpperCase() === 'DENY', `   X-Frame-Options on the app: ${b.headers.get('x-frame-options') || 'missing'}`);
const s = await fetch(`${APP}/api/admin/session`);
check(s.status === 200 && (await s.json()).authed === false, 'app API reachable on the app host and signed out');
const t = await fetch(`${APP}/api/admin/today`);
check(t.status === 401, `admin API refuses without a session (got ${t.status})`);
const m = await fetch(`${SITE}/api/admin/today`);
check(m.status === 404 || m.status === 401, `admin API not usable on the marketing host (got ${m.status})`);
const bk = await fetch(`${SITE}/book/`);
check(bk.status === 200 && /Content-Security-Policy/i.test([...bk.headers.keys()].join(' ')), '/book has a Content-Security-Policy');
const sv = await fetch(`${SITE}/api/services`);
check(sv.ok && (await sv.json()).services?.length > 0, '/api/services answers (database + functions wired)');
console.log(failed ? `\n${failed} check(s) failed` : '\nAll hosting checks passed');
process.exit(failed ? 1 : 0);

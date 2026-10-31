// npm test: builds a migrated template database, then runs every scripts/tests/*.test.mjs file.
// Needs a Postgres 15+ server you can create databases on: TEST_PG_URL (default postgres://postgres@127.0.0.1:54329/postgres).
// Each test file clones the template into its own database, so files never share state.
import postgres from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_URL = process.env.TEST_PG_URL || 'postgres://postgres@127.0.0.1:54329/postgres';
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
try {
  await admin`select 1`;
} catch (e) {
  console.error(`Cannot reach Postgres at ${ADMIN_URL}. Start one (see README "Running the tests") or set TEST_PG_URL.`);
  process.exit(1);
}
const stale = await admin`select datname from pg_database where datname like 'bf_t_%' or datname = 'bf_template'`;
for (const { datname } of stale) await admin.unsafe(`drop database if exists ${datname} with (force)`);
await admin.unsafe('create database bf_template');
await admin.end();

const tpl = postgres(ADMIN_URL.replace(/\/[^/]*$/, '/bf_template'), { max: 1, onnotice: () => {} });
await tpl.unsafe(readFileSync(path.join(root, 'scripts/test-support/supabase-roles.sql'), 'utf8'));
for (const f of readdirSync(path.join(root, 'supabase/migrations')).filter((x) => x.endsWith('.sql')).sort()) {
  await tpl.unsafe(readFileSync(path.join(root, 'supabase/migrations', f), 'utf8'));
}
await tpl.end();

const only = process.argv.slice(2);
const files = readdirSync(path.join(root, 'scripts/tests')).filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !only.length || only.some((o) => f.includes(o))).sort().map((f) => path.join('scripts/tests', f));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, TEST_PG_URL: ADMIN_URL, TZ: 'UTC' } });
process.exit(r.status ?? 1);

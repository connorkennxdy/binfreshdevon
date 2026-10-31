import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { setup } from '../test-support/harness.mjs';

let h;
before(async () => { h = await setup(); });
after(async () => { await h.teardown(); });

test('P1-1 RLS is enabled on every table', async () => {
  const rows = await h.sql`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`;
  assert.ok(rows.length >= 15);
  for (const r of rows) assert.ok(r.relrowsecurity, `${r.relname} has RLS`);
});

test('P1-1 the anon role can read nothing from any table', async () => {
  const tables = (await h.sql`select tablename from pg_tables where schemaname = 'public'`).map((r) => r.tablename);
  const anon = postgres(process.env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
  const c = await anon.reserve();
  try {
    await c`set role anon`;
    for (const t of tables) {
      let r;
      try { r = (await c.unsafe(`select * from public.${t} limit 1`)).length; } catch (e) { r = e.code; }
      assert.ok(r === 0 || r === '42501', `${t}: anon got ${r}`);
    }
    let fn;
    try { fn = await c`select book_slot(null,null,'2030-01-08','14-16','2030-01-08','held',1,'unpaid',30,false)`; } catch (e) { fn = e.code; }
    assert.equal(fn, '42501', 'anon cannot call book_slot');
  } finally { c.release(); await anon.end(); }
});

test('P1-2 stripe-seed run twice creates no duplicates and prices match §2.3', async () => {
  const { seed } = await import('../stripe-seed.mjs');
  const { stripe } = await import('../../netlify/functions/lib/stripe.mjs');
  const before = Object.keys(h.stripe.db.prices).length;
  const report = await seed({ stripe: stripe(), sql: h.sql, log: () => {} });
  assert.equal(Object.keys(h.stripe.db.prices).length, before, 'second run created nothing');
  assert.ok(report.every((r) => r[2] === 'ok'));
  const expected = {
    'household-1': [1250, 800], 'household-2': [2100, 1350], 'household-3': [2850, 1850], 'household-360': [1500, 1000],
    'commercial-660': [2800, 1800], 'commercial-1100': [4000, 2500], 'deep-clean': [1750, null],
  };
  const services = await h.sql`select * from services`;
  assert.equal(services.length, 7);
  for (const s of services) {
    const [one, rec] = expected[s.slug];
    assert.equal(h.stripe.db.prices[s.stripe_price_one_off].unit_amount, one, s.slug + ' one-off');
    if (rec == null) { assert.equal(s.stripe_price_recurring, null); assert.equal(s.stripe_price_first_clean, null); continue; }
    const r = h.stripe.db.prices[s.stripe_price_recurring];
    assert.equal(r.unit_amount, rec, s.slug + ' 4-weekly');
    assert.deepEqual(r.recurring, { interval: 'week', interval_count: 4 });
    const f = h.stripe.db.prices[s.stripe_price_first_clean];
    assert.equal(f.unit_amount, rec); assert.equal(f.type, 'one_time');
  }
});

test('P1-2 a changed price creates a new Price and archives the old one', async () => {
  const { seed } = await import('../stripe-seed.mjs');
  const { stripe } = await import('../../netlify/functions/lib/stripe.mjs');
  const [old] = await h.sql`select * from services where slug = 'household-1'`;
  await h.sql`update services set price_recurring_pence = 850 where slug = 'household-1'`;
  await seed({ stripe: stripe(), sql: h.sql, log: () => {} });
  const [now] = await h.sql`select * from services where slug = 'household-1'`;
  assert.notEqual(now.stripe_price_recurring, old.stripe_price_recurring);
  assert.equal(h.stripe.db.prices[old.stripe_price_recurring].active, false);
  assert.equal(h.stripe.db.prices[now.stripe_price_recurring].lookup_key, 'bf_household-1_4wk');
  await h.sql`update services set price_recurring_pence = 800 where slug = 'household-1'`;
  await seed({ stripe: stripe(), sql: h.sql, log: () => {} });
});

test('P1-3 book_slot never exceeds the cap under 20 parallel requests', async () => {
  const [c] = await h.sql`insert into customers (name,email,phone,address_line1,town,postcode) values ('A','a@x.com','+447700900123','1 St','Town','EX31 1AA') returning id`;
  const pool = postgres(process.env.SUPABASE_DB_URL, { max: 20, onnotice: () => {}, prepare: false });
  try {
    const date = '2030-01-08'; // a Tuesday
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      pool`select book_slot(${c.id}, null, ${date}, '14-16', ${date}, 'held', 1250, 'unpaid', 30, false) as id`.then((r) => r[0].id)));
    assert.equal(results.filter(Boolean).length, 6, 'exactly the cap of 6 succeeded');
    const [{ n }] = await pool`select count(*)::int as n from visits where visit_date = ${date} and time_window = '14-16'`;
    assert.equal(n, 6);
    // expired holds stop counting
    await pool`update visits set hold_expires_at = now() - interval '1 minute' where visit_date = ${date}`;
    const [{ id }] = await pool`select book_slot(${c.id}, null, ${date}, '14-16', ${date}, 'held', 1250, 'unpaid', 30, false) as id`;
    assert.ok(id, 'slot frees once holds expire');
    // a blocked window has zero capacity
    await pool`insert into blocks (block_date, time_window) values ('2030-01-09', '16-18')`;
    const [{ id: blocked }] = await pool`select book_slot(${c.id}, null, '2030-01-09', '16-18', '2030-01-09', 'held', 1250, 'unpaid', 30, false) as id`;
    assert.equal(blocked, null);
  } finally { await pool.end(); }
});

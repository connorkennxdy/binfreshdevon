-- Bin Fresh Devon: rounds & bookings. Initial schema.
-- All access goes through Netlify Functions. RLS is on for every table with no policies,
-- so the anon / authenticated keys can read and write nothing.
-- Note: the handoff calls the window column `window`; WINDOW is a reserved word in Postgres,
-- so it is `time_window` here. Values are unchanged ('14-16', '16-18').

create extension if not exists pgcrypto;

create table services (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  category text not null check (category in ('household','commercial','addon')),
  price_one_off_pence int check (price_one_off_pence is null or price_one_off_pence >= 0),
  price_recurring_pence int check (price_recurring_pence is null or price_recurring_pence >= 0),
  stripe_price_one_off text,
  stripe_price_recurring text,
  stripe_price_first_clean text,
  stripe_product text,
  photo text,
  online_bookable boolean not null default false,
  active boolean not null default true,
  sort int not null default 0
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null, email text not null, phone text not null,
  address_line1 text not null, address_line2 text, town text not null, postcode text not null,
  access_notes text,
  collection_day text,
  notes text,
  stripe_customer_id text unique,
  source text default 'online' check (source in ('online','manual','square-migration')),
  created_at timestamptz default now()
);
create unique index customers_email_idx on customers (lower(email));

create table plans (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  status text not null check (status in ('pending','active','paused','cancelled')),
  anchor_date date not null,                 -- first visit date (cadence anchor)
  time_window text not null check (time_window in ('14-16','16-18')),
  first_paid_upfront boolean not null default true, -- false for migrated plans (first visit billed at trial_end)
  stripe_subscription_id text unique,
  stripe_checkout_session_id text,
  paused_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz default now()
);

create table plan_items (
  plan_id uuid references plans(id) on delete cascade,
  service_id uuid references services(id),
  qty int not null default 1 check (qty between 1 and 10),
  unit_price_pence int not null,
  stripe_subscription_item_id text,
  primary key (plan_id, service_id)
);

create table visits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  plan_id uuid references plans(id),
  original_date date not null,
  visit_date date not null,
  time_window text not null check (time_window in ('14-16','16-18')),
  route_order int,
  status text not null check (status in ('held','scheduled','done','skipped','cancelled')),
  skip_reason text,
  amount_pence int not null,
  payment_status text not null check (payment_status in ('unpaid','paid','failed','refunded','due')),
  stripe_checkout_session_id text, stripe_invoice_id text, stripe_payment_intent_id text,
  google_event_id text, calendar_synced_at timestamptz,
  reminder_sent_at timestamptz,
  hold_expires_at timestamptz,
  completed_at timestamptz,
  moved_by_system boolean not null default false,
  attention text,                            -- non-null = flag shown in Tom's app (e.g. moved, overbooked)
  booking_details jsonb,                     -- details typed at booking for an existing customer; applied only once paid
  notes text,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);
create index visits_date_window_idx on visits (visit_date, time_window);
create index visits_customer_idx on visits (customer_id);
create unique index visits_plan_original_idx on visits (plan_id, original_date) where plan_id is not null;

-- updated_at only moves when something that matters to the calendar / app changes,
-- so writing calendar_synced_at or reminder_sent_at does not make a visit look stale.
create or replace function visits_touch() returns trigger language plpgsql as $$
begin
  if (new.visit_date, new.time_window, new.status, new.payment_status, new.amount_pence, new.notes, new.attention, new.customer_id)
     is distinct from
     (old.visit_date, old.time_window, old.status, old.payment_status, old.amount_pence, old.notes, old.attention, old.customer_id) then
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger visits_touch before update on visits for each row execute function visits_touch();

create table visit_items (
  visit_id uuid references visits(id) on delete cascade,
  service_id uuid references services(id),
  qty int not null,
  unit_price_pence int not null,
  primary key (visit_id, service_id)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  visit_id uuid references visits(id) on delete set null,
  stripe_payment_intent_id text unique,
  stripe_charge_id text,
  stripe_invoice_id text,
  amount_pence int not null,
  fee_pence int,
  refunded_pence int default 0,
  refund_ids text[] not null default '{}',
  status text not null,
  paid_at timestamptz
);
create index payments_paid_at_idx on payments (paid_at);

create table blocks (
  id uuid primary key default gen_random_uuid(),
  block_date date not null,
  time_window text check (time_window is null or time_window in ('14-16','16-18')), -- null = whole day
  reason text,
  created_at timestamptz default now()
);
create index blocks_date_idx on blocks (block_date);

-- Tom's per-day cap override ("only 4 in 4–6pm on Friday").
create table capacity_overrides (
  cap_date date not null,
  time_window text not null check (time_window in ('14-16','16-18')),
  cap int not null check (cap >= 0),
  primary key (cap_date, time_window)
);

create table settings (key text primary key, value jsonb not null);

create table manage_tokens (
  token_hash text primary key,
  customer_id uuid not null references customers(id),
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

create table stripe_events (id text primary key, type text, received_at timestamptz default now(), processed_at timestamptz);

-- Scheduled price changes: customers get 14 days' notice before a plan price moves.
create table price_changes (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references services(id),
  new_recurring_pence int not null,
  new_stripe_price text not null,
  effective_date date not null,
  notified_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz default now()
);

-- Record of every email / SMS we send (no message bodies, IDs only).
create table message_log (
  id bigserial primary key,
  customer_id uuid references customers(id),
  visit_id uuid,
  channel text not null check (channel in ('email','sms')),
  template text not null,
  status text not null,          -- sent | skipped | failed
  provider_id text,
  error text,
  at timestamptz default now()
);

create table audit_log (id bigserial primary key, actor text, action text, entity text, entity_id text, detail jsonb, at timestamptz default now());

-- Row level security on, no policies: nothing is readable with the anon key.
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
-- The service connection bypasses RLS as table owner; revoke API roles' table rights as a second lock.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
    execute 'revoke all on all functions in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
    execute 'revoke all on all functions in schema public from authenticated';
  end if;
end $$;

-- ===== Capacity =====
-- Effective cap for a date + window: 0 when blocked, else the per-day override, else the settings cap.
create or replace function slot_cap(p_date date, p_window text) returns int language sql stable as $$
  select case
    when exists (select 1 from blocks b where b.block_date = p_date and (b.time_window is null or b.time_window = p_window)) then 0
    else coalesce(
      (select cap from capacity_overrides o where o.cap_date = p_date and o.time_window = p_window),
      (select (w->>'cap')::int from settings s, jsonb_array_elements(s.value) w where s.key = 'windows' and w->>'id' = p_window),
      0)
  end
$$;

create or replace function slot_used(p_date date, p_window text, p_exclude uuid default null) returns int language sql stable as $$
  select count(*)::int from visits v
  where v.visit_date = p_date and v.time_window = p_window
    and (p_exclude is null or v.id <> p_exclude)
    and (v.status in ('scheduled','done') or (v.status = 'held' and v.hold_expires_at > now()))
$$;

-- Atomically take a slot. Returns the new visit id, or null if the window is blocked or full.
-- An advisory lock per date+window serialises concurrent bookings for the same slot.
create or replace function book_slot(
  p_customer uuid, p_plan uuid, p_date date, p_window text, p_original date,
  p_status text, p_amount int, p_payment_status text, p_hold_minutes int default 30, p_force boolean default false
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('slot:' || p_date::text || ':' || p_window));
  if not p_force and slot_used(p_date, p_window) >= slot_cap(p_date, p_window) then
    return null;
  end if;
  insert into visits (customer_id, plan_id, original_date, visit_date, time_window, status, amount_pence, payment_status, hold_expires_at)
  values (p_customer, p_plan, coalesce(p_original, p_date), p_date, p_window, p_status, p_amount, p_payment_status,
          case when p_status = 'held' then now() + make_interval(mins => p_hold_minutes) end)
  returning id into v_id;
  return v_id;
end $$;

-- Atomically move an existing visit. Returns true if moved.
create or replace function move_slot(p_visit uuid, p_date date, p_window text, p_force boolean default false)
returns boolean language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('slot:' || p_date::text || ':' || p_window));
  if not p_force and slot_used(p_date, p_window, p_visit) >= slot_cap(p_date, p_window) then
    return false;
  end if;
  update visits set visit_date = p_date, time_window = p_window, route_order = null where id = p_visit;
  return found;
end $$;

-- ===== Seed: settings =====
insert into settings (key, value) values
  ('windows', '[{"id":"14-16","start":"14:00","end":"16:00","cap":6},{"id":"16-18","start":"16:00","end":"18:00","cap":6}]'),
  ('bookable_weekdays', '[1,2,3,4,5,6]'),
  ('postcode_districts', '["EX31","EX32","EX33","EX34","EX39"]'),
  ('booking_cutoff_time', '"18:00"'),
  ('horizon_weeks', '6'),
  ('reminder_time', '"17:00"'),
  ('charge_time', '"07:00"'),
  ('tom_alert_email', '""'),
  ('tom_mobile', '""'),
  ('sms_enabled', 'true'),
  ('vat_registered', 'false');

-- ===== Seed: services (prices in pence, §2.3). online_bookable per the default until Connor confirms. =====
insert into services (slug, name, category, price_one_off_pence, price_recurring_pence, online_bookable, photo, sort) values
  ('household-1',     '1 household bin',             'household',  1250,  800, true,  'assets/service-bin-wash-600.webp', 10),
  ('household-2',     '2 household bins',            'household',  2100, 1350, true,  'assets/service-recycling-garden-600.webp', 20),
  ('household-3',     '3 household bins',            'household',  2850, 1850, true,  'assets/service-sanitising-600.webp', 30),
  ('household-360',   '360L household bin',          'household',  1500, 1000, true,  'assets/after-clean-bin-600.webp', 40),
  ('commercial-660',  '660L commercial bin',         'commercial', 2800, 1800, false, 'assets/commercial-bin-store-600.webp', 50),
  ('commercial-1100', '1,100L commercial bin',       'commercial', 4000, 2500, false, 'assets/commercial-bins-1100l-600.webp', 60),
  ('deep-clean',      'Deep clean (very dirty bin)', 'addon',      1750, null, true,  'assets/before-dirty-bin-600.webp', 70);

-- WARDOGS Code Breaker coordinator: Supabase schema.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to run again; it only creates what is missing.

-- Live groups (one row per group, whole state as JSON). Expired rows are
-- deleted by the app after GROUP_TTL_HOURS of inactivity.
create table if not exists public.groups (
  id          text primary key check (id ~ '^[A-Z0-9]{8}$'),
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
create index if not exists groups_updated_at_idx on public.groups (updated_at);

-- Permanent log of codes marked correct, used by the /stats page.
create table if not exists public.solves (
  id             text primary key,
  code           text not null check (code ~ '^[0-9]{3,5}$'),
  map            text not null default '',
  unknown_count  smallint not null check (unknown_count between 0 and 5),
  revealed       text not null check (revealed ~ '^[0-9x]{3,5}$'),
  wrong_before   integer not null default 0,
  group_hash     text not null,
  round          integer not null default 1,
  created_at     timestamptz not null default now()
);
create index if not exists solves_created_at_idx on public.solves (created_at);

-- Lock both tables down. Row Level Security with no policies means the
-- public (publishable/anon) key can neither read nor write them. Only the
-- app server, using the secret key, can access them.
alter table public.groups enable row level security;
alter table public.solves enable row level security;
revoke all on public.groups from anon, authenticated;
revoke all on public.solves from anon, authenticated;

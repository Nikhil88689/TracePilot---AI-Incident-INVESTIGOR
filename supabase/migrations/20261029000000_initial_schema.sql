-- TracePilot initial schema.
-- Ownership model: every row traces back to projects.owner_id = auth.uid().
-- Event ingestion (API-key authenticated) writes through the service role on the server,
-- so no anonymous INSERT policy is granted on events.

create extension if not exists pgcrypto;

create type public.incident_status as enum ('open', 'investigating', 'resolved');
create type public.incident_severity as enum ('low', 'medium', 'high', 'critical');
create type public.analysis_status as enum ('pending', 'complete', 'failed');

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);
create index projects_owner_idx on public.projects (owner_id);

-- Only a SHA-256 hash of the key is stored; the plaintext is shown once at creation.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  key_prefix text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_project_idx on public.api_keys (project_id);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  fingerprint text not null,
  title text not null,
  status public.incident_status not null default 'open',
  severity public.incident_severity not null default 'medium',
  event_count integer not null default 0 check (event_count >= 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (project_id, fingerprint)
);
create index incidents_project_last_seen_idx on public.incidents (project_id, last_seen_at desc);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  incident_id uuid references public.incidents (id) on delete set null,
  occurred_at timestamptz not null,
  level text not null default 'error' check (level in ('debug', 'info', 'warning', 'error', 'fatal')),
  message text not null,
  stack_trace text,
  environment text,
  release text,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index events_incident_idx on public.events (incident_id, occurred_at desc);
create index events_project_time_idx on public.events (project_id, occurred_at desc);

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents (id) on delete cascade,
  status public.analysis_status not null default 'pending',
  model text,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index analyses_incident_idx on public.analyses (incident_id, created_at desc);

-- Row Level Security -------------------------------------------------------

alter table public.projects enable row level security;
alter table public.api_keys enable row level security;
alter table public.incidents enable row level security;
alter table public.events enable row level security;
alter table public.analyses enable row level security;

create policy "projects: owner full access" on public.projects
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "api_keys: owner full access" on public.api_keys
  for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));

create policy "incidents: owner full access" on public.incidents
  for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));

create policy "events: owner read" on public.events
  for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));

create policy "analyses: owner full access" on public.analyses
  for all to authenticated
  using (exists (
    select 1 from public.incidents i join public.projects p on p.id = i.project_id
    where i.id = incident_id and p.owner_id = (select auth.uid())))
  with check (exists (
    select 1 from public.incidents i join public.projects p on p.id = i.project_id
    where i.id = incident_id and p.owner_id = (select auth.uid())));

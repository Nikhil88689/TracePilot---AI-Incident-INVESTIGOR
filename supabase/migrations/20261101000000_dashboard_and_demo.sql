-- Dashboard metrics hardening, deployments, and the deterministic demo scenario.
--
-- Time model: every window is half-open and UTC, [from, to): an event at exactly `from` is inside,
-- one at exactly `to` is outside. All timestamps are timestamptz, so there is no local-time ambiguity.
-- Aggregates exclude demo projects unless one is selected explicitly, so simulated data can never be
-- mixed into real totals by accident.

-- Demo flag ---------------------------------------------------------------------------------------
alter table public.projects add column is_demo boolean not null default false;
-- At most one demo project per user: makes seeding idempotent and race-safe.
create unique index projects_owner_demo_uniq on public.projects (owner_id) where is_demo;

-- Users create projects through onboarding; they must not be able to mark one as demo (or flip it) from
-- the client. Only the seeding function below (SECURITY DEFINER) sets is_demo.
revoke insert, update on public.projects from authenticated;
grant insert (owner_id, name, environment, idempotency_key) on public.projects to authenticated;
grant update (name, environment) on public.projects to authenticated;

-- Deployments -------------------------------------------------------------------------------------
-- A minimal deployment record, used for chart markers, incident context, and AI evidence context.
-- Written only by the demo seeder for now; there is no public ingestion path for deployments yet.
create table public.deployments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  version text not null check (char_length(version) between 1 and 100),
  description text check (description is null or char_length(description) <= 500),
  deployed_at timestamptz not null,
  source text not null default 'api' check (source in ('api', 'demo')),
  created_at timestamptz not null default now()
);
create index deployments_project_time_idx on public.deployments (project_id, deployed_at desc);

alter table public.deployments enable row level security;
create policy "deployments: owner read" on public.deployments
  for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));
revoke all on public.deployments from anon, authenticated;
grant select on public.deployments to authenticated;

-- Indexes for the dashboard's aggregates -----------------------------------------------------------
-- events: (project_id, occurred_at desc) already exists. Error counts and "affected endpoints" filter on level.
create index events_project_level_time_idx on public.events (project_id, level, occurred_at desc);
-- "Unresolved incidents active in the window" filters status + last_seen per project.
create index incidents_project_status_last_seen_idx on public.incidents (project_id, status, last_seen_at desc);

-- Demo-aware queries ---------------------------------------------------------------------------------
-- In every function below, `p_project is null` means "all of my projects, EXCLUDING demo projects".

create or replace function public.list_incidents(
  p_project uuid default null,
  p_search text default null,
  p_status text default null,
  p_severity text default null,
  p_environment text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_sort text default 'last_seen',
  p_dir text default 'desc',
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid, project_id uuid, project_name text, environment text, title text,
  severity public.incident_severity, status public.incident_status, occurrence_count integer,
  first_seen_at timestamptz, last_seen_at timestamptz, endpoint text, total_count bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_order text;
  v_dir text;
  v_pattern text;
begin
  v_order := case p_sort
    when 'title' then 'i.title'
    when 'severity' then 'i.severity'
    when 'status' then 'i.status'
    when 'occurrences' then 'i.occurrence_count'
    when 'first_seen' then 'i.first_seen_at'
    when 'last_seen' then 'i.last_seen_at'
    when 'endpoint' then 'i.endpoint'
  end;
  v_dir := case lower(p_dir) when 'asc' then 'asc' when 'desc' then 'desc' end;
  if v_order is null or v_dir is null then
    raise exception 'invalid sort' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('open', 'investigating', 'resolved', 'unresolved') then
    raise exception 'invalid status' using errcode = '22023';
  end if;

  v_pattern := case when nullif(btrim(p_search), '') is null then null
    else '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  return query execute format($q$
    select i.id, i.project_id, p.name, p.environment, i.title, i.severity, i.status,
           i.occurrence_count, i.first_seen_at, i.last_seen_at, i.endpoint, count(*) over () as total_count
      from public.incidents i
      join public.projects p on p.id = i.project_id
     where (case when $1::uuid is null then not p.is_demo else i.project_id = $1 end)
       and ($2::text is null or i.title ilike $2 or i.endpoint ilike $2)
       and ($3::text is null
            or (case when $3 = 'unresolved' then i.status <> 'resolved' else i.status = $3::public.incident_status end))
       and ($4::text is null or i.severity = $4::public.incident_severity)
       and ($5::text is null or p.environment = $5)
       and ($6::timestamptz is null or i.last_seen_at >= $6)
       and ($7::timestamptz is null or i.last_seen_at < $7)
     order by %s %s nulls last, i.id
     limit $8 offset $9
  $q$, v_order, v_dir)
  using p_project, v_pattern, p_status, p_severity, p_environment, p_from, p_to,
        least(greatest(coalesce(p_limit, 20), 1), 100), greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.incident_counts(p_project uuid default null, p_environment text default null)
returns table (unresolved bigint, critical bigint, recently_resolved bigint, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (where i.status <> 'resolved'),
    count(*) filter (where i.status <> 'resolved' and i.severity = 'critical'),
    count(*) filter (where i.status = 'resolved' and i.resolved_at >= now() - interval '7 days'),
    count(*)
  from public.incidents i
  join public.projects p on p.id = i.project_id
  where (case when p_project is null then not p.is_demo else i.project_id = p_project end)
    and (p_environment is null or p.environment = p_environment);
$$;

create or replace function public.list_events(
  p_project uuid default null,
  p_search text default null,
  p_event_type text default null,
  p_level text default null,
  p_endpoint text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_incident uuid default null,
  p_include_details boolean default false,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid, project_id uuid, project_name text, external_event_id text, event_type text, level text,
  message text, endpoint text, occurred_at timestamptz, incident_id uuid, incident_title text,
  stack_trace text, attributes jsonb, total_count bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_search text;
  v_endpoint text;
begin
  v_search := case when nullif(btrim(p_search), '') is null then null
    else '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_endpoint := case when nullif(btrim(p_endpoint), '') is null then null
    else '%' || replace(replace(replace(btrim(p_endpoint), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  return query
    select e.id, e.project_id, p.name, e.external_event_id, e.event_type, e.level, e.message, e.endpoint,
           e.occurred_at, ie.incident_id, i.title,
           case when p_include_details then e.stack_trace end,
           case when p_include_details then e.attributes end,
           count(*) over ()
      from public.events e
      join public.projects p on p.id = e.project_id
      left join public.incident_events ie on ie.event_id = e.id
      left join public.incidents i on i.id = ie.incident_id
     where (case when p_project is null and p_incident is null then not p.is_demo
                 when p_project is null then true
                 else e.project_id = p_project end)
       and (p_incident is null or ie.incident_id = p_incident)
       and (v_search is null or e.message ilike v_search or e.endpoint ilike v_search or e.event_type ilike v_search)
       and (p_event_type is null or e.event_type = p_event_type)
       and (p_level is null or e.level = p_level)
       and (v_endpoint is null or e.endpoint ilike v_endpoint)
       and (p_from is null or e.occurred_at >= p_from)
       and (p_to is null or e.occurred_at < p_to)
     order by e.occurred_at desc, e.id
     limit least(greatest(coalesce(p_limit, 25), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.event_filter_options(p_project uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'event_types', coalesce((
      select jsonb_agg(t.event_type) from (
        select e.event_type from public.events e join public.projects p on p.id = e.project_id
         where (case when p_project is null then not p.is_demo else e.project_id = p_project end)
         group by e.event_type order by count(*) desc, e.event_type limit 50) t), '[]'::jsonb),
    'endpoints', coalesce((
      select jsonb_agg(t.endpoint) from (
        select e.endpoint from public.events e join public.projects p on p.id = e.project_id
         where (case when p_project is null then not p.is_demo else e.project_id = p_project end) and e.endpoint is not null
         group by e.endpoint order by count(*) desc, e.endpoint limit 50) t), '[]'::jsonb)
  );
$$;

create or replace function public.list_deployments(p_project uuid, p_from timestamptz, p_to timestamptz)
returns table (id uuid, project_id uuid, version text, description text, deployed_at timestamptz, source text)
language sql
stable
security invoker
set search_path = public
as $$
  select d.id, d.project_id, d.version, d.description, d.deployed_at, d.source
    from public.deployments d
    join public.projects p on p.id = d.project_id
   where (case when p_project is null then not p.is_demo else d.project_id = p_project end)
     and d.deployed_at >= p_from and d.deployed_at < p_to
   order by d.deployed_at, d.id
   limit 50;
$$;

-- Dashboard aggregates. Formulas (also documented in src/lib/dashboard/metrics.ts):
--   events      = count of events with occurred_at in [from, to)
--   errors      = events in the window whose level is 'error' or 'fatal'
--   error rate  = errors / events (undefined when events = 0)
--   unresolved  = incidents with status <> 'resolved' and last_seen_at in [from, to)
--   endpoints   = distinct non-null endpoint among the error-level events in the window
--   severity    = the unresolved incidents above, grouped by severity
--   series      = the same events/errors, bucketed into equal slices of [from, to)
-- first_event_at lets the caller tell whether the comparison period has any history behind it.
create or replace function public.dashboard_overview(
  p_project uuid, p_from timestamptz, p_to timestamptz, p_buckets integer default 24
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_span interval := p_to - p_from;
  v_prev_from timestamptz := p_from - (p_to - p_from);
  v_buckets integer := least(greatest(coalesce(p_buckets, 24), 1), 100);
  v_events bigint; v_errors bigint; v_pev bigint; v_per bigint;
  v_endpoints bigint; v_pendpoints bigint; v_unres bigint; v_punres bigint;
  v_first timestamptz;
  v_series jsonb; v_severity jsonb;
begin
  if p_to <= p_from then
    raise exception 'p_to must be after p_from' using errcode = '22023';
  end if;

  select count(*), count(*) filter (where e.level in ('error', 'fatal')),
         count(distinct e.endpoint) filter (where e.level in ('error', 'fatal'))
    into v_events, v_errors, v_endpoints
    from public.events e join public.projects p on p.id = e.project_id
   where (case when p_project is null then not p.is_demo else e.project_id = p_project end)
     and e.occurred_at >= p_from and e.occurred_at < p_to;

  select count(*), count(*) filter (where e.level in ('error', 'fatal')),
         count(distinct e.endpoint) filter (where e.level in ('error', 'fatal'))
    into v_pev, v_per, v_pendpoints
    from public.events e join public.projects p on p.id = e.project_id
   where (case when p_project is null then not p.is_demo else e.project_id = p_project end)
     and e.occurred_at >= v_prev_from and e.occurred_at < p_from;

  select min(e.occurred_at) into v_first
    from public.events e join public.projects p on p.id = e.project_id
   where (case when p_project is null then not p.is_demo else e.project_id = p_project end);

  select count(*) into v_unres from public.incidents i join public.projects p on p.id = i.project_id
   where i.status <> 'resolved' and (case when p_project is null then not p.is_demo else i.project_id = p_project end)
     and i.last_seen_at >= p_from and i.last_seen_at < p_to;
  select count(*) into v_punres from public.incidents i join public.projects p on p.id = i.project_id
   where i.status <> 'resolved' and (case when p_project is null then not p.is_demo else i.project_id = p_project end)
     and i.last_seen_at >= v_prev_from and i.last_seen_at < p_from;

  select coalesce(jsonb_agg(jsonb_build_object(
           'time', to_char(b.start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'events', coalesce(c.events, 0), 'errors', coalesce(c.errors, 0)) order by b.n), '[]'::jsonb)
    into v_series
    from (select g.n, p_from + v_span * g.n / v_buckets as start from generate_series(0, v_buckets - 1) as g(n)) b
    left join (
      -- multiply before dividing: epoch is exact numeric, so an event on a bucket edge lands in the later bucket
      select least(v_buckets - 1, floor(extract(epoch from (e.occurred_at - p_from)) * v_buckets / extract(epoch from v_span)))::int as n,
             count(*) as events, count(*) filter (where e.level in ('error', 'fatal')) as errors
        from public.events e join public.projects p on p.id = e.project_id
       where (case when p_project is null then not p.is_demo else e.project_id = p_project end)
         and e.occurred_at >= p_from and e.occurred_at < p_to
       group by 1) c on c.n = b.n;

  select coalesce(jsonb_object_agg(s.severity, s.n), '{}'::jsonb) into v_severity
    from (select i.severity, count(*) as n from public.incidents i join public.projects p on p.id = i.project_id
           where i.status <> 'resolved' and (case when p_project is null then not p.is_demo else i.project_id = p_project end)
             and i.last_seen_at >= p_from and i.last_seen_at < p_to
           group by i.severity) s;

  return jsonb_build_object(
    'events', v_events, 'errors', v_errors, 'prev_events', v_pev, 'prev_errors', v_per,
    'endpoints', v_endpoints, 'prev_endpoints', v_pendpoints,
    'unresolved', v_unres, 'prev_unresolved', v_punres,
    'first_event_at', v_first,
    'series', v_series, 'severity', v_severity);
end;
$$;

-- Demo scenario -------------------------------------------------------------------------------------

-- Stable id from (scope, key): the same inputs always give the same UUID. Version/variant bits are set so
-- the result is a well-formed v4-style UUID (strict validators reject a raw md5 hash).
create or replace function public.demo_uuid(p_scope uuid, p_key text)
returns uuid
language sql
immutable
as $$
  select (substr(h, 1, 12) || '4' || substr(h, 14, 3) || substr('89ab', 1 + (get_byte(decode(substr(h, 17, 2), 'hex'), 0) % 4), 1) || substr(h, 18, 15))::uuid
  from (select md5(p_scope::text || ':' || p_key) as h) x
$$;

-- Creates (or returns) the caller's own simulated project. Consent is explicit in the app (a dialog) and
-- structural here: it only ever creates a NEW project owned by the caller and never touches existing ones.
--
-- Timeline, relative to the demo clock A (= p_anchor truncated to the minute):
--   A-7d .. A      steady normal traffic (1 request log / 10 min), running through the whole story
--   A-150m         deployment 2.14.0
--   A-145m .. A-100m  60 HTTP 500s on POST /api/checkout + 24 related database timeouts (one incident)
--   A-99m          rollback to 2.13.2; errors stop; the rest of the window is recovery
-- Seeding is idempotent: calling it again returns the existing project untouched. p_reset re-seeds
-- from scratch against a new demo clock. Baseline request logs are deliberately NOT grouped into
-- incidents, so the demo has exactly one incident.
create or replace function public.seed_demo_project(p_anchor timestamptz default now(), p_reset boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  a timestamptz := date_trunc('minute', p_anchor);
  v_project uuid;
  v_incident uuid;
  v_fp text := left(md5('demo-checkout-incident'), 32);
  v_first public.events;
  v_db public.events;
  v_mid public.events;
  v_last public.events;
  v_stack_http constant text := E'Error: Request failed with status 500\n    at reserveInventory (/app/src/checkout/inventory.ts:88:11)\n    at async Promise.all (index 2)\n    at async processCheckout (/app/src/checkout/process.ts:41:5)\n    at async POST (/app/src/app/api/checkout/route.ts:19:3)';
  v_stack_db constant text := E'DatabaseTimeoutError: Database query timed out after 5000ms\n    at acquireConnection (/app/src/db/pool.ts:57:13)\n    at async reserveInventory (/app/src/checkout/inventory.ts:73:20)\n    at async processCheckout (/app/src/checkout/process.ts:41:5)\n    at async POST (/app/src/app/api/checkout/route.ts:19:3)';
begin
  if v_uid is null then
    raise exception 'sign in to create the demo' using errcode = '28000';
  end if;

  if p_reset then
    delete from public.projects where owner_id = v_uid and is_demo;
  end if;

  select id into v_project from public.projects where owner_id = v_uid and is_demo;
  if v_project is not null then
    return jsonb_build_object('project_id', v_project, 'created', false);
  end if;

  insert into public.projects (id, owner_id, name, environment, is_demo)
  values (public.demo_uuid(v_uid, 'project'), v_uid, 'Demo (simulated storefront)', 'development', true)
  on conflict do nothing
  returning id into v_project;

  if v_project is null then
    -- A concurrent call created it first (return it), or the name clashes with one of the user's own projects.
    select id into v_project from public.projects where owner_id = v_uid and is_demo;
    if v_project is null then
      raise exception 'a project named "Demo (simulated storefront)" already exists; rename it to create the demo' using errcode = '23505';
    end if;
    return jsonb_build_object('project_id', v_project, 'created', false);
  end if;

  -- Normal request traffic (info level): one log every 10 minutes for the whole 7 days, at a steady rate so
  -- that any trend the dashboard shows is real, not an artefact of how the demo was seeded.
  insert into public.events (id, project_id, external_event_id, event_type, level, message, fingerprint, endpoint, occurred_at, attributes)
  select public.demo_uuid(v_project, 'traffic:' || t.k), v_project, 'demo-traffic-' || t.k, 'RequestLog', 'info',
         e.route || ' 200 OK (' || (40 + (t.k * 37) % 160) || 'ms)', md5('demo-traffic'), e.route, t.at,
         jsonb_build_object(
           'release', case when t.at >= a - interval '150 minutes' and t.at < a - interval '99 minutes' then '2.14.0' else '2.13.2' end,
           'durationMs', 40 + (t.k * 37) % 160, 'simulated', true)
    from (
      select k, a - interval '7 days' + k * interval '10 minutes' as at from generate_series(1, 1008) as k
    ) t
    cross join lateral (
      select (array['GET /api/products', 'GET /api/cart', 'POST /api/cart', 'GET /api/search', 'POST /api/checkout'])[1 + t.k % 5] as route
    ) e;

  -- The burst: HTTP 500s on /api/checkout...
  insert into public.events (id, project_id, external_event_id, event_type, level, message, stack_trace, fingerprint, endpoint, occurred_at, attributes)
  select public.demo_uuid(v_project, 'http500:' || i), v_project, 'demo-http500-' || i, 'HttpError', 'error',
         'Checkout failed: inventory service returned HTTP 500', v_stack_http, v_fp, 'POST /api/checkout',
         a - interval '145 minutes' + i * interval '45 seconds',
         jsonb_build_object('release', '2.14.0', 'statusCode', 500, 'requestId', 'req_' || lpad(i::text, 4, '0'), 'simulated', true)
    from generate_series(0, 59) as i;

  -- ...and the related database timeouts, interleaved with them.
  insert into public.events (id, project_id, external_event_id, event_type, level, message, stack_trace, fingerprint, endpoint, occurred_at, attributes)
  select public.demo_uuid(v_project, 'dbtimeout:' || j), v_project, 'demo-dbtimeout-' || j, 'DatabaseTimeoutError', 'error',
         'Database query timed out after 5000ms: connection pool exhausted (20/20 connections in use)', v_stack_db, v_fp, 'POST /api/checkout',
         a - interval '142 minutes' + j * interval '110 seconds',
         jsonb_build_object('release', '2.14.0', 'poolSize', 20, 'poolInUse', 20, 'queryTimeoutMs', 5000, 'simulated', true)
    from generate_series(0, 23) as j;

  -- One incident groups all 84 burst events (a custom grouping key, as the SDK allows).
  v_incident := public.demo_uuid(v_project, 'incident');
  insert into public.incidents (id, project_id, fingerprint, title, severity, status, occurrence_count, first_seen_at, last_seen_at, endpoint)
  select v_incident, v_project, v_fp, 'HTTP 500 on POST /api/checkout with database timeouts after v2.14.0', 'critical', 'open',
         count(*), min(e.occurred_at), max(e.occurred_at), 'POST /api/checkout'
    from public.events e where e.project_id = v_project and e.fingerprint = v_fp;

  insert into public.incident_events (incident_id, event_id)
  select v_incident, e.id from public.events e where e.project_id = v_project and e.fingerprint = v_fp;

  insert into public.deployments (id, project_id, version, description, deployed_at, source) values
    (public.demo_uuid(v_project, 'deploy:2.14.0'), v_project, '2.14.0', 'Checkout: reserve inventory in parallel (simulated deployment)', a - interval '150 minutes', 'demo'),
    (public.demo_uuid(v_project, 'deploy:2.13.2'), v_project, '2.13.2', 'Rollback of 2.14.0 (simulated deployment)', a - interval '99 minutes', 'demo');

  -- A pre-written, clearly simulated investigation, so the walkthrough works without an AI key.
  select * into v_first from public.events where id = public.demo_uuid(v_project, 'http500:0');
  select * into v_db from public.events where id = public.demo_uuid(v_project, 'dbtimeout:0');
  select * into v_mid from public.events where id = public.demo_uuid(v_project, 'http500:30');
  select * into v_last from public.events where id = public.demo_uuid(v_project, 'http500:59');

  insert into public.analyses (
    id, incident_id, status, model, summary, hypotheses, recommended_steps, missing_information, limitations,
    evidence_event_ids, input_event_count, created_at, completed_at
  ) values (
    public.demo_uuid(v_project, 'analysis'), v_incident, 'complete', 'demo-fixture',
    'Checkout started failing about 5 minutes after release 2.14.0 was deployed. Every failure is in the inventory reservation step, and the first database timeout reports a fully used connection pool (20 of 20). That points at the new parallel reservation exhausting the database pool, though the events alone cannot prove it.',
    jsonb_build_array(
      jsonb_build_object(
        'title', 'Parallel inventory reservation in 2.14.0 exhausts the database connection pool',
        'explanation', 'The failures begin shortly after the deployment, all run through reserveInventory, and the timeouts say the pool is at 20/20. Reserving inventory in parallel would multiply concurrent connections per checkout.',
        'confidence', 'high',
        'evidence', jsonb_build_array(
          jsonb_build_object('eventId', v_first.id, 'occurredAt', v_first.occurred_at, 'message', v_first.message, 'why', 'The first 500 is raised in reserveInventory, inside Promise.all: the parallel code path introduced in this release.'),
          jsonb_build_object('eventId', v_db.id, 'occurredAt', v_db.occurred_at, 'message', v_db.message, 'why', 'States that the pool is exhausted (20/20 connections in use), a direct sign of connection starvation.'),
          jsonb_build_object('eventId', v_mid.id, 'occurredAt', v_mid.occurred_at, 'message', v_mid.message, 'why', 'Mid-burst the same failure and stack repeat, so this is sustained rather than a single blip.')
        )
      ),
      jsonb_build_object(
        'title', 'The inventory service itself became unhealthy at the same time',
        'explanation', 'The user-facing error is an HTTP 500 from the inventory service. It could be failing independently of this release, for example if it shares the same database.',
        'confidence', 'low',
        'evidence', jsonb_build_array(
          jsonb_build_object('eventId', v_first.id, 'occurredAt', v_first.occurred_at, 'message', v_first.message, 'why', 'The visible symptom is an upstream HTTP 500, which is consistent with a failing dependency.'),
          jsonb_build_object('eventId', v_last.id, 'occurredAt', v_last.occurred_at, 'message', v_last.message, 'why', 'The last 500 is still the same upstream error, with no change in behaviour before the failures stop.')
        )
      )
    ),
    jsonb_build_array(
      jsonb_build_object('step', 'Read reserveInventory (inventory.ts) and count how many connections one checkout can hold at once now that it runs in parallel.', 'rationale', 'Both stack traces pass through it.'),
      jsonb_build_object('step', 'Compare database pool usage before and after 2.14.0 in your database dashboard.', 'rationale', 'Checks whether the pool saturates only after the release.'),
      jsonb_build_object('step', 'Check whether the inventory service reported errors or latency during the same period.', 'rationale', 'Separates a release regression from a dependency outage.'),
      jsonb_build_object('step', 'Reproduce in a staging environment with 2.14.0 under concurrent checkouts.', 'rationale', 'Confirms or rules out the pool-exhaustion hypothesis.')
    ),
    jsonb_build_array(
      'Database pool metrics (connections in use, wait times) over time.',
      'Inventory service logs and latency for the same window.',
      'The diff of release 2.14.0, in particular the reservation change.'
    ),
    jsonb_build_array(
      'This is a SIMULATED demo analysis, written in advance. No AI model was called and it describes fictional data.',
      'Only the stored events were considered; nothing was reproduced or verified.',
      'The recovery after the 2.13.2 rollback is consistent with, but does not prove, a regression in 2.14.0.'
    ),
    array[v_first.id, v_db.id, v_mid.id, v_last.id],
    4, a - interval '90 minutes', a - interval '90 minutes'
  );

  return jsonb_build_object('project_id', v_project, 'created', true);
end;
$$;

-- Removes the caller's demo project and everything under it (cascades). Invoker: RLS limits it to their own rows.
create or replace function public.remove_demo_project()
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  delete from public.projects where is_demo and owner_id = (select auth.uid());
  return found;
end;
$$;

-- Grants -------------------------------------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'list_incidents(uuid,text,text,text,text,timestamptz,timestamptz,text,text,integer,integer)',
    'incident_counts(uuid,text)',
    'list_events(uuid,text,text,text,text,timestamptz,timestamptz,uuid,boolean,integer,integer)',
    'event_filter_options(uuid)',
    'list_deployments(uuid,timestamptz,timestamptz)',
    'dashboard_overview(uuid,timestamptz,timestamptz,integer)',
    'seed_demo_project(timestamptz,boolean)',
    'remove_demo_project()',
    'demo_uuid(uuid,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

-- Read/write API for the incidents, events, and dashboard screens.
--
-- Everything here is SECURITY INVOKER: it runs as the signed-in user, so Row Level Security
-- (project ownership) applies to every row touched. Nothing in this file can see or change
-- another user's data. Execute is granted to `authenticated` only.

-- incidents: endpoint + resolved_at ----------------------------------------------------
alter table public.incidents
  add column endpoint text check (char_length(endpoint) <= 300),
  add column resolved_at timestamptz;

update public.incidents i
   set endpoint = (
     select e.endpoint
       from public.events e
       join public.incident_events ie on ie.event_id = e.id
      where ie.incident_id = i.id and e.endpoint is not null
      order by e.occurred_at desc
      limit 1);
update public.incidents set resolved_at = last_seen_at where status = 'resolved' and resolved_at is null;

-- Activity log (status changes) -----------------------------------------------------------
create table public.incident_activity (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents (id) on delete cascade,
  kind text not null check (kind in ('status_changed')),
  from_status public.incident_status,
  to_status public.incident_status,
  -- null = the system (e.g. ingestion reopening a resolved incident)
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index incident_activity_incident_idx on public.incident_activity (incident_id, created_at desc);

alter table public.incident_activity enable row level security;
create policy "incident_activity: owner read" on public.incident_activity
  for select to authenticated
  using (exists (
    select 1 from public.incidents i join public.projects p on p.id = i.project_id
    where i.id = incident_id and p.owner_id = (select auth.uid())));
revoke all on public.incident_activity from anon, authenticated;
grant select on public.incident_activity to authenticated;

-- One analysis in flight per incident, enforced by the database.
create unique index analyses_one_pending_per_incident on public.analyses (incident_id) where status = 'pending';

-- Status transitions: validated and logged in the database, whoever makes the change ---------
--   open -> investigating | resolved,  investigating -> resolved,  resolved -> open (reopen)
create or replace function public.incidents_status_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
    (old.status = 'open' and new.status in ('investigating', 'resolved'))
    or (old.status = 'investigating' and new.status = 'resolved')
    or (old.status = 'resolved' and new.status = 'open')
  ) then
    raise exception 'invalid incident status transition: % -> %', old.status, new.status
      using errcode = '23514';
  end if;

  new.resolved_at := case when new.status = 'resolved' then now() else null end;

  insert into public.incident_activity (incident_id, kind, from_status, to_status, actor_id)
  values (new.id, 'status_changed', old.status, new.status, auth.uid());

  return new;
end;
$$;

create trigger incidents_status_guard
  before update of status on public.incidents
  for each row execute function public.incidents_status_guard();

-- Ingestion: also maintain incidents.endpoint (latest known endpoint) ----------------------
create or replace function public.ingest_events(p_project_id uuid, p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ev jsonb;
  v_event_id uuid;
  v_incident_id uuid;
  v_count integer;
  v_results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 100 then
    raise exception 'p_events must be an array of at most 100 events' using errcode = '22023';
  end if;

  for ev in
    select t.value
      from jsonb_array_elements(p_events) with ordinality as t(value, ord)
     order by t.value ->> 'fingerprint', t.ord
  loop
    v_event_id := null;

    insert into public.events as e (
      project_id, external_event_id, event_type, level, message, stack_trace,
      fingerprint, endpoint, occurred_at, attributes
    ) values (
      p_project_id,
      ev ->> 'external_event_id',
      ev ->> 'event_type',
      ev ->> 'level',
      ev ->> 'message',
      ev ->> 'stack_trace',
      ev ->> 'fingerprint',
      ev ->> 'endpoint',
      (ev ->> 'occurred_at')::timestamptz,
      coalesce(ev -> 'attributes', '{}'::jsonb)
    )
    on conflict (project_id, external_event_id) do nothing
    returning e.id into v_event_id;

    if v_event_id is null then
      select ie.incident_id, i.occurrence_count
        into v_incident_id, v_count
        from public.events e
        join public.incident_events ie on ie.event_id = e.id
        join public.incidents i on i.id = ie.incident_id
       where e.project_id = p_project_id and e.external_event_id = ev ->> 'external_event_id';

      v_results := v_results || jsonb_build_object(
        'external_event_id', ev ->> 'external_event_id',
        'status', 'duplicate',
        'incident_id', v_incident_id,
        'occurrence_count', v_count
      );
    else
      insert into public.incidents as i (
        project_id, fingerprint, title, severity, status, occurrence_count,
        first_seen_at, last_seen_at, endpoint
      ) values (
        p_project_id,
        ev ->> 'fingerprint',
        ev ->> 'title',
        (ev ->> 'severity')::public.incident_severity,
        'open',
        1,
        (ev ->> 'occurred_at')::timestamptz,
        (ev ->> 'occurred_at')::timestamptz,
        ev ->> 'endpoint'
      )
      on conflict (project_id, fingerprint) do update set
        occurrence_count = i.occurrence_count + 1,
        first_seen_at = least(i.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(i.last_seen_at, excluded.last_seen_at),
        severity = greatest(i.severity, excluded.severity),
        -- The endpoint shown is the one from the most recent event that named one.
        endpoint = case
          when excluded.last_seen_at >= i.last_seen_at then coalesce(excluded.endpoint, i.endpoint)
          else coalesce(i.endpoint, excluded.endpoint)
        end,
        -- A resolved incident that recurs is reopened (the trigger validates and logs it).
        status = case
          when i.status = 'resolved' and excluded.last_seen_at > i.last_seen_at then 'open'::public.incident_status
          else i.status
        end
      returning i.id, i.occurrence_count into v_incident_id, v_count;

      insert into public.incident_events (incident_id, event_id) values (v_incident_id, v_event_id);

      v_results := v_results || jsonb_build_object(
        'external_event_id', ev ->> 'external_event_id',
        'status', 'accepted',
        'incident_id', v_incident_id,
        'occurrence_count', v_count
      );
    end if;
  end loop;

  return jsonb_build_object('results', v_results);
end;
$$;

-- Query functions ---------------------------------------------------------------------------

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
  -- Only whitelisted identifiers are ever interpolated; every value is a bound parameter.
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

  v_pattern := case when nullif(btrim(p_search), '') is null then null
    else '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  return query execute format($q$
    select i.id, i.project_id, p.name, p.environment, i.title, i.severity, i.status,
           i.occurrence_count, i.first_seen_at, i.last_seen_at, i.endpoint, count(*) over () as total_count
      from public.incidents i
      join public.projects p on p.id = i.project_id
     where ($1::uuid is null or i.project_id = $1)
       and ($2::text is null or i.title ilike $2 or i.endpoint ilike $2)
       and ($3::text is null or i.status = $3::public.incident_status)
       and ($4::text is null or i.severity = $4::public.incident_severity)
       and ($5::text is null or p.environment = $5)
       and ($6::timestamptz is null or i.last_seen_at >= $6)
       and ($7::timestamptz is null or i.last_seen_at <= $7)
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
  where (p_project is null or i.project_id = p_project)
    and (p_environment is null or p.environment = p_environment);
$$;

create or replace function public.unresolved_by_project()
returns table (project_id uuid, unresolved bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select p.id, count(i.id) filter (where i.status <> 'resolved')
  from public.projects p
  left join public.incidents i on i.project_id = p.id
  group by p.id;
$$;

create or replace function public.get_incident(p_id uuid)
returns table (
  id uuid, project_id uuid, project_name text, environment text, title text, fingerprint text,
  severity public.incident_severity, status public.incident_status, occurrence_count integer,
  first_seen_at timestamptz, last_seen_at timestamptz, endpoint text, resolved_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select i.id, i.project_id, p.name, p.environment, i.title, i.fingerprint, i.severity, i.status,
         i.occurrence_count, i.first_seen_at, i.last_seen_at, i.endpoint, i.resolved_at
    from public.incidents i
    join public.projects p on p.id = i.project_id
   where i.id = p_id;
$$;

create or replace function public.list_incident_activity(p_incident uuid, p_limit integer default 50)
returns table (id uuid, kind text, from_status public.incident_status, to_status public.incident_status, actor text, created_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select a.id, a.kind, a.from_status, a.to_status,
         case when a.actor_id is null then 'system' when a.actor_id = auth.uid() then 'you' else 'teammate' end,
         a.created_at
    from public.incident_activity a
   where a.incident_id = p_incident
   order by a.created_at desc, a.id
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function public.incident_histogram(p_incident uuid, p_buckets integer default 24)
returns table (bucket_start timestamptz, bucket_end timestamptz, event_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with inc as (
    select i.first_seen_at as f,
           greatest(i.last_seen_at, i.first_seen_at + interval '1 minute') as l,
           least(greatest(coalesce(p_buckets, 24), 1), 100) as n
      from public.incidents i where i.id = p_incident
  ),
  hits as (
    select least(inc.n - 1, floor(extract(epoch from (e.occurred_at - inc.f)) / extract(epoch from (inc.l - inc.f)) * inc.n))::int as b
      from inc
      join public.incident_events ie on ie.incident_id = p_incident
      join public.events e on e.id = ie.event_id
     where e.occurred_at >= inc.f
  )
  select inc.f + (inc.l - inc.f) * g.b / inc.n,
         inc.f + (inc.l - inc.f) * (g.b + 1) / inc.n,
         count(hits.b)
    from inc
    cross join lateral generate_series(0, inc.n - 1) as g(b)
    left join hits on hits.b = g.b
   group by g.b, inc.f, inc.l, inc.n
   order by g.b;
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
     where (p_project is null or e.project_id = p_project)
       and (p_incident is null or ie.incident_id = p_incident)
       and (v_search is null or e.message ilike v_search or e.endpoint ilike v_search or e.event_type ilike v_search)
       and (p_event_type is null or e.event_type = p_event_type)
       and (p_level is null or e.level = p_level)
       and (v_endpoint is null or e.endpoint ilike v_endpoint)
       and (p_from is null or e.occurred_at >= p_from)
       and (p_to is null or e.occurred_at <= p_to)
     order by e.occurred_at desc, e.id
     limit least(greatest(coalesce(p_limit, 25), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.get_event(p_id uuid)
returns table (
  id uuid, project_id uuid, project_name text, external_event_id text, event_type text, level text,
  message text, endpoint text, occurred_at timestamptz, incident_id uuid, incident_title text,
  stack_trace text, attributes jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  select e.id, e.project_id, p.name, e.external_event_id, e.event_type, e.level, e.message, e.endpoint,
         e.occurred_at, ie.incident_id, i.title, e.stack_trace, e.attributes
    from public.events e
    join public.projects p on p.id = e.project_id
    left join public.incident_events ie on ie.event_id = e.id
    left join public.incidents i on i.id = ie.incident_id
   where e.id = p_id;
$$;

-- Distinct event types and endpoints (most frequent first) for the explorer's filter menus.
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
        select e.event_type from public.events e
         where (p_project is null or e.project_id = p_project)
         group by e.event_type order by count(*) desc, e.event_type limit 50) t), '[]'::jsonb),
    'endpoints', coalesce((
      select jsonb_agg(t.endpoint) from (
        select e.endpoint from public.events e
         where (p_project is null or e.project_id = p_project) and e.endpoint is not null
         group by e.endpoint order by count(*) desc, e.endpoint limit 50) t), '[]'::jsonb)
  );
$$;

-- Dashboard: KPIs (with previous-period baselines), time-bucketed series, severity mix ------------
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
  v_series jsonb; v_severity jsonb;
begin
  if p_to <= p_from then
    raise exception 'p_to must be after p_from' using errcode = '22023';
  end if;

  select count(*), count(*) filter (where e.level in ('error', 'fatal')),
         count(distinct e.endpoint) filter (where e.level in ('error', 'fatal'))
    into v_events, v_errors, v_endpoints
    from public.events e
   where (p_project is null or e.project_id = p_project) and e.occurred_at >= p_from and e.occurred_at < p_to;

  select count(*), count(*) filter (where e.level in ('error', 'fatal')),
         count(distinct e.endpoint) filter (where e.level in ('error', 'fatal'))
    into v_pev, v_per, v_pendpoints
    from public.events e
   where (p_project is null or e.project_id = p_project) and e.occurred_at >= v_prev_from and e.occurred_at < p_from;

  select count(*) into v_unres from public.incidents i
   where i.status <> 'resolved' and (p_project is null or i.project_id = p_project)
     and i.last_seen_at >= p_from and i.last_seen_at < p_to;
  select count(*) into v_punres from public.incidents i
   where i.status <> 'resolved' and (p_project is null or i.project_id = p_project)
     and i.last_seen_at >= v_prev_from and i.last_seen_at < p_from;

  select coalesce(jsonb_agg(jsonb_build_object(
           'time', b.start, 'events', coalesce(c.events, 0), 'errors', coalesce(c.errors, 0)) order by b.n), '[]'::jsonb)
    into v_series
    from (select g.n, p_from + v_span * g.n / v_buckets as start from generate_series(0, v_buckets - 1) as g(n)) b
    left join (
      select least(v_buckets - 1, floor(extract(epoch from (e.occurred_at - p_from)) / extract(epoch from v_span) * v_buckets))::int as n,
             count(*) as events, count(*) filter (where e.level in ('error', 'fatal')) as errors
        from public.events e
       where (p_project is null or e.project_id = p_project) and e.occurred_at >= p_from and e.occurred_at < p_to
       group by 1) c on c.n = b.n;

  select coalesce(jsonb_object_agg(s.severity, s.n), '{}'::jsonb) into v_severity
    from (select i.severity, count(*) as n from public.incidents i
           where i.status <> 'resolved' and (p_project is null or i.project_id = p_project)
             and i.last_seen_at >= p_from and i.last_seen_at < p_to
           group by i.severity) s;

  return jsonb_build_object(
    'events', v_events, 'errors', v_errors, 'prev_events', v_pev, 'prev_errors', v_per,
    'endpoints', v_endpoints, 'prev_endpoints', v_pendpoints,
    'unresolved', v_unres, 'prev_unresolved', v_punres,
    'series', v_series, 'severity', v_severity);
end;
$$;

-- Mutations -------------------------------------------------------------------------------------

-- Optimistic-concurrency status change: only applies if the incident is still in `p_expected`.
-- Returns {result: ok|conflict|not_found, status, resolved_at}. Invalid transitions raise 23514.
create or replace function public.change_incident_status(p_id uuid, p_to text, p_expected text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status public.incident_status;
  v_resolved timestamptz;
begin
  update public.incidents
     set status = p_to::public.incident_status
   where id = p_id and status = p_expected::public.incident_status
  returning status, resolved_at into v_status, v_resolved;

  if found then
    return jsonb_build_object('result', 'ok', 'status', v_status, 'resolved_at', v_resolved);
  end if;

  select i.status into v_status from public.incidents i where i.id = p_id;
  if found then
    return jsonb_build_object('result', 'conflict', 'status', v_status);
  end if;
  return jsonb_build_object('result', 'not_found');
end;
$$;

-- AI analyses ------------------------------------------------------------------------------------

create or replace function public.start_analysis(p_incident uuid, p_model text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.incidents i where i.id = p_incident) then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- An analysis stuck "pending" (function killed mid-run) must not block new ones forever.
  update public.analyses
     set status = 'failed', error_message = 'The analysis did not finish in time.', completed_at = now()
   where incident_id = p_incident and status = 'pending' and created_at < now() - interval '2 minutes';

  begin
    insert into public.analyses (incident_id, status, model) values (p_incident, 'pending', p_model)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('result', 'in_progress');
  end;

  return jsonb_build_object('result', 'started', 'id', v_id);
end;
$$;

create or replace function public.finish_analysis(
  p_id uuid, p_status text, p_summary text, p_hypotheses jsonb, p_evidence uuid[], p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.analyses
     set status = p_status::public.analysis_status,
         summary = p_summary,
         hypotheses = coalesce(p_hypotheses, '[]'::jsonb),
         evidence_event_ids = coalesce(p_evidence, '{}'),
         error_message = p_error,
         completed_at = now()
   where id = p_id and status = 'pending';
  return found;
end;
$$;

create or replace function public.get_latest_analysis(p_incident uuid)
returns table (
  id uuid, status public.analysis_status, summary text, hypotheses jsonb, evidence_event_ids uuid[],
  model text, error_message text, created_at timestamptz, completed_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select a.id, a.status, a.summary, a.hypotheses, a.evidence_event_ids, a.model, a.error_message,
         a.created_at, a.completed_at
    from public.analyses a
   where a.incident_id = p_incident
   order by a.created_at desc
   limit 1;
$$;

-- Grants: signed-in users only -----------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'list_incidents(uuid,text,text,text,text,timestamptz,timestamptz,text,text,integer,integer)',
    'incident_counts(uuid,text)',
    'unresolved_by_project()',
    'get_incident(uuid)',
    'list_incident_activity(uuid,integer)',
    'incident_histogram(uuid,integer)',
    'list_events(uuid,text,text,text,text,timestamptz,timestamptz,uuid,boolean,integer,integer)',
    'get_event(uuid)',
    'event_filter_options(uuid)',
    'dashboard_overview(uuid,timestamptz,timestamptz,integer)',
    'change_incident_status(uuid,text,text)',
    'start_analysis(uuid,text)',
    'finish_analysis(uuid,text,text,jsonb,uuid[],text)',
    'get_latest_analysis(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

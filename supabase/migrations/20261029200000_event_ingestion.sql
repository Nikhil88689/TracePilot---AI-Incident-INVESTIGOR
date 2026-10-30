-- Event ingestion schema + atomic processing functions.
-- Requires the two earlier migrations. Adapts existing tables in place:
--   events:   + external_event_id, event_type, fingerprint, endpoint; context -> attributes;
--             incident link moves to the incident_events join table
--   incidents: event_count -> occurrence_count
--   analyses: result -> summary / hypotheses / evidence_event_ids
-- New: incident_events, rate_limits, and the SECURITY DEFINER functions ingest_events,
-- authenticate_ingest_key, consume_rate_limit (executable only by the service role).

-- events ------------------------------------------------------------------------------
alter table public.events drop column incident_id;
alter table public.events drop column environment;
alter table public.events drop column release;
alter table public.events rename column context to attributes;

alter table public.events
  add column external_event_id text not null
    check (char_length(external_event_id) between 1 and 128),
  add column event_type text not null default 'error'
    check (char_length(event_type) between 1 and 100),
  add column fingerprint text not null
    check (char_length(fingerprint) = 32),
  add column endpoint text
    check (char_length(endpoint) <= 300),
  add constraint events_message_len check (char_length(message) <= 4000),
  add constraint events_stack_len check (stack_trace is null or char_length(stack_trace) <= 20000),
  add constraint events_attributes_object check (jsonb_typeof(attributes) = 'object');

-- Idempotency: one row per (project, external id). Retries and duplicates collapse here.
create unique index events_project_external_id_uniq on public.events (project_id, external_event_id);
create index events_project_fingerprint_idx on public.events (project_id, fingerprint, occurred_at desc);

-- incidents ---------------------------------------------------------------------------
alter table public.incidents rename column event_count to occurrence_count;
create index incidents_project_status_idx on public.incidents (project_id, status);
-- (unique (project_id, fingerprint) already exists from the initial schema and drives grouping.)

-- incident_events ---------------------------------------------------------------------
create table public.incident_events (
  incident_id uuid not null references public.incidents (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (incident_id, event_id),
  unique (event_id) -- an event belongs to exactly one incident
);
create index incident_events_incident_idx on public.incident_events (incident_id, created_at desc);

-- analyses ----------------------------------------------------------------------------
alter table public.analyses drop column result;
alter table public.analyses
  add column summary text,
  add column hypotheses jsonb not null default '[]'::jsonb,
  add column evidence_event_ids uuid[] not null default '{}';

-- rate limiting (fixed window; state lives in the database because serverless has no shared memory)
create table public.rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, window_start)
);

-- Row Level Security ------------------------------------------------------------------
alter table public.incident_events enable row level security;
alter table public.rate_limits enable row level security;

-- Incidents: owners read them and may change status; rows are created only by ingestion.
drop policy "incidents: owner full access" on public.incidents;
create policy "incidents: owner read" on public.incidents
  for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));
create policy "incidents: owner update" on public.incidents
  for update to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));

create policy "incident_events: owner read" on public.incident_events
  for select to authenticated
  using (exists (
    select 1 from public.incidents i join public.projects p on p.id = i.project_id
    where i.id = incident_id and p.owner_id = (select auth.uid())));

-- Table privileges --------------------------------------------------------------------
-- Signed-in users can read their data; only the service role (ingestion) can write events.
revoke all on public.events, public.incident_events, public.incidents, public.rate_limits
  from anon, authenticated;
grant select on public.events, public.incident_events to authenticated;
grant select on public.incidents to authenticated;
grant update (status) on public.incidents to authenticated;
revoke all on public.analyses from anon;

-- API keys: the hash is never readable by browsers/sessions; keys cannot be edited, only revoked.
revoke all on public.api_keys from anon, authenticated;
grant select (id, project_id, name, key_prefix, created_at, last_used_at, revoked_at)
  on public.api_keys to authenticated;
grant insert (project_id, name, key_prefix, key_hash) on public.api_keys to authenticated;
grant update (revoked_at) on public.api_keys to authenticated;

-- Functions ---------------------------------------------------------------------------

-- Resolves an ingestion key (by SHA-256 hash) to its project. Revoked keys never match.
-- last_used_at is refreshed at most once a minute to avoid a write per request.
create or replace function public.authenticate_ingest_key(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_project uuid;
  v_last timestamptz;
begin
  select k.id, k.project_id, k.last_used_at
    into v_id, v_project, v_last
    from public.api_keys k
   where k.key_hash = p_key_hash and k.revoked_at is null;

  if not found then
    return null;
  end if;

  if v_last is null or v_last < now() - interval '1 minute' then
    update public.api_keys set last_used_at = now() where id = v_id;
  end if;

  return jsonb_build_object('key_id', v_id, 'project_id', v_project);
end;
$$;

-- Atomically consumes `p_cost` units from a fixed-window bucket.
create or replace function public.consume_rate_limit(
  p_bucket text, p_cost integer, p_limit integer, p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  v_window := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits as r (bucket, window_start, count)
  values (p_bucket, v_window, p_cost)
  on conflict (bucket, window_start) do update set count = r.count + p_cost
  returning r.count into v_count;

  -- Opportunistic cleanup keeps the table small without a scheduled job.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 hour';
  end if;

  return jsonb_build_object(
    'allowed', v_count <= p_limit,
    'count', v_count,
    'retry_after', greatest(1, ceil(extract(epoch from (
      v_window + make_interval(secs => p_window_seconds) - clock_timestamp()
    )))::integer)
  );
end;
$$;

-- Ingests a validated batch for one project in a single transaction: either every event is
-- stored and linked, or (on error) nothing is. Events are processed in fingerprint order so
-- concurrent batches always lock incident rows in the same order (no deadlocks).
--
-- p_events: array of {external_event_id, event_type, level, message, stack_trace, fingerprint,
--                     title, severity, endpoint, occurred_at, attributes}
-- Returns:   {results: [{external_event_id, status: accepted|duplicate, incident_id, occurrence_count}]}
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
      -- Duplicate external id: report the existing link, change nothing.
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
        project_id, fingerprint, title, severity, status, occurrence_count, first_seen_at, last_seen_at
      ) values (
        p_project_id,
        ev ->> 'fingerprint',
        ev ->> 'title',
        (ev ->> 'severity')::public.incident_severity,
        'open',
        1,
        (ev ->> 'occurred_at')::timestamptz,
        (ev ->> 'occurred_at')::timestamptz
      )
      on conflict (project_id, fingerprint) do update set
        occurrence_count = i.occurrence_count + 1,
        first_seen_at = least(i.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(i.last_seen_at, excluded.last_seen_at),
        severity = greatest(i.severity, excluded.severity),
        -- A resolved incident that recurs is reopened.
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

-- Only the server (service role) may call these. They bypass RLS, so they must never be
-- reachable from anon/authenticated sessions.
revoke all on function public.authenticate_ingest_key(text) from public, anon, authenticated;
revoke all on function public.consume_rate_limit(text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.ingest_events(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.authenticate_ingest_key(text) to service_role;
grant execute on function public.consume_rate_limit(text, integer, integer, integer) to service_role;
grant execute on function public.ingest_events(uuid, jsonb) to service_role;

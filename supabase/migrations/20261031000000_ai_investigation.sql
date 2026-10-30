-- AI investigation: richer persisted analysis, evidence selection, step checklist, cost guard.
-- Everything is SECURITY INVOKER (Row Level Security applies to the caller) and executable by
-- `authenticated` only.

alter table public.analyses
  add column recommended_steps jsonb not null default '[]'::jsonb,
  add column missing_information jsonb not null default '[]'::jsonb,
  add column limitations jsonb not null default '[]'::jsonb,
  -- indexes (0-based) into recommended_steps that the developer has ticked off
  add column completed_steps integer[] not null default '{}',
  add column input_event_count integer check (input_event_count is null or input_event_count >= 0),
  add column usage jsonb,
  add column error_code text,
  add column retryable boolean not null default false;

-- Evidence selection ---------------------------------------------------------------------------
-- Picks a small, representative set of an incident's events (full detail included):
--   recent          the newest `p_recent` events
--   first_seen      the earliest event
--   representative  one event per distinct message/stack shape (numbers normalised), most common first
-- An event is returned once, labelled with the highest-priority reason it was chosen for.
create or replace function public.select_evidence_events(
  p_incident uuid, p_recent integer default 6, p_representative integer default 4
)
returns table (
  id uuid, external_event_id text, event_type text, level text, message text, endpoint text,
  occurred_at timestamptz, stack_trace text, attributes jsonb, reason text
)
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select e.*
      from public.events e
      join public.incident_events ie on ie.event_id = e.id
     where ie.incident_id = p_incident
  ),
  recent as (
    select b.id, 'recent'::text as reason from base b
     order by b.occurred_at desc, b.id
     limit least(greatest(coalesce(p_recent, 6), 0), 20)
  ),
  first_seen as (
    select b.id, 'first_seen'::text as reason from base b
     order by b.occurred_at asc, b.id
     limit 1
  ),
  shapes as (
    select b.id, b.occurred_at,
           md5(regexp_replace(b.message, '[0-9]+', '<n>', 'g') || coalesce(left(regexp_replace(b.stack_trace, '[0-9]+', '<n>', 'g'), 300), '')) as shape
      from base b
  ),
  variants as (
    select distinct on (s.shape) s.id, count(*) over (partition by s.shape) as n
      from shapes s
     order by s.shape, s.occurred_at desc
  ),
  representative as (
    select v.id, 'representative'::text as reason from variants v
     order by v.n desc, v.id
     limit least(greatest(coalesce(p_representative, 4), 0), 20)
  ),
  picked as (
    select distinct on (u.id) u.id, u.reason
      from (select * from recent union all select * from first_seen union all select * from representative) u
     order by u.id, case u.reason when 'recent' then 1 when 'first_seen' then 2 else 3 end
  )
  select e.id, e.external_event_id, e.event_type, e.level, e.message, e.endpoint, e.occurred_at,
         e.stack_trace, e.attributes, p.reason
    from picked p
    join public.events e on e.id = p.id
   order by e.occurred_at desc, e.id;
$$;

-- Analysis lifecycle ---------------------------------------------------------------------------

-- Adds a per-user cost guard: at most 20 analyses started per hour (RLS scopes the count to the caller).
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
     set status = 'failed', error_message = 'The analysis did not finish in time.',
         error_code = 'timeout', retryable = true, completed_at = now()
   where incident_id = p_incident and status = 'pending' and created_at < now() - interval '2 minutes';

  if (select count(*) from public.analyses a where a.created_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('result', 'rate_limited');
  end if;

  begin
    insert into public.analyses (incident_id, status, model) values (p_incident, 'pending', p_model)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('result', 'in_progress');
  end;

  return jsonb_build_object('result', 'started', 'id', v_id);
end;
$$;

drop function public.finish_analysis(uuid, text, text, jsonb, uuid[], text);

-- Completes a pending analysis exactly once. Returns false if it was already finished or is not visible.
create function public.finish_analysis(
  p_id uuid, p_status text, p_summary text, p_hypotheses jsonb, p_evidence uuid[],
  p_steps jsonb, p_missing jsonb, p_limitations jsonb, p_input_events integer, p_usage jsonb,
  p_model text, p_error text, p_error_code text, p_retryable boolean
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
         recommended_steps = coalesce(p_steps, '[]'::jsonb),
         missing_information = coalesce(p_missing, '[]'::jsonb),
         limitations = coalesce(p_limitations, '[]'::jsonb),
         input_event_count = p_input_events,
         usage = p_usage,
         model = coalesce(p_model, model),
         error_message = p_error,
         error_code = p_error_code,
         retryable = coalesce(p_retryable, false),
         completed_at = now()
   where id = p_id and status = 'pending';
  return found;
end;
$$;

drop function public.get_latest_analysis(uuid);

-- The newest analysis. A pending one older than 2 minutes is reported as failed/retryable, so a
-- killed request can never look "in progress" forever even if nobody has cleaned the row up yet.
create function public.get_latest_analysis(p_incident uuid)
returns table (
  id uuid, status public.analysis_status, summary text, hypotheses jsonb, recommended_steps jsonb,
  missing_information jsonb, limitations jsonb, completed_steps integer[], input_event_count integer,
  usage jsonb, model text, error_message text, error_code text, retryable boolean,
  created_at timestamptz, completed_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select a.id,
         case when s.stale then 'failed'::public.analysis_status else a.status end,
         a.summary, a.hypotheses, a.recommended_steps, a.missing_information, a.limitations,
         a.completed_steps, a.input_event_count, a.usage, a.model,
         case when s.stale then 'The analysis did not finish in time.' else a.error_message end,
         case when s.stale then 'timeout' else a.error_code end,
         case when s.stale then true else a.retryable end,
         a.created_at, a.completed_at
    from public.analyses a
    cross join lateral (select a.status = 'pending' and a.created_at < now() - interval '2 minutes' as stale) s
   where a.incident_id = p_incident
   order by a.created_at desc
   limit 1;
$$;

-- Marks one recommended step done or not done. Only completed analyses have steps to tick.
create function public.set_analysis_step(p_analysis uuid, p_index integer, p_done boolean)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_len integer;
  v_steps integer[];
begin
  select jsonb_array_length(a.recommended_steps) into v_len
    from public.analyses a where a.id = p_analysis and a.status = 'complete';
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_index < 0 or p_index >= v_len then
    return jsonb_build_object('result', 'invalid_index');
  end if;

  update public.analyses
     set completed_steps = case
       when p_done then (select coalesce(array_agg(distinct x order by x), '{}') from unnest(array_append(completed_steps, p_index)) as x)
       else array_remove(completed_steps, p_index)
     end
   where id = p_analysis
  returning completed_steps into v_steps;

  return jsonb_build_object('result', 'ok', 'completed_steps', to_jsonb(v_steps));
end;
$$;

-- Grants -------------------------------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'select_evidence_events(uuid,integer,integer)',
    'start_analysis(uuid,text)',
    'finish_analysis(uuid,text,text,jsonb,uuid[],jsonb,jsonb,jsonb,integer,jsonb,text,text,text,boolean)',
    'get_latest_analysis(uuid)',
    'set_analysis_step(uuid,integer,boolean)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

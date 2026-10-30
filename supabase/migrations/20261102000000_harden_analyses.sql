-- Hardening found in the production-readiness review.
--
-- PROBLEM: `authenticated` held full INSERT/UPDATE/DELETE on public.analyses (owner-scoped by RLS), so a
-- signed-in user could call PostgREST directly and
--   * DELETE their own analysis rows or UPDATE created_at, which defeats the "20 analyses per hour" cost guard
--     that counts those rows (the guard protects the operator's Anthropic bill), and
--   * INSERT / UPDATE rows that look like completed, verified investigations.
--
-- FIX: users may only READ analyses. All writes go through the three lifecycle functions below, which are now
-- SECURITY DEFINER with an explicit ownership check (auth.uid() owns the incident's project), so the cost
-- guard counts rows the user can no longer delete or edit.
--
-- RESIDUAL (documented in PROJECT_STATUS.md): the functions still accept the analysis content from the caller,
-- because verification of AI output happens in the app server. A user can therefore still write fabricated
-- content into their OWN pending analysis by calling finish_analysis directly. That affects only their own data.

revoke insert, update, delete on public.analyses from authenticated;
grant select on public.analyses to authenticated;

drop policy if exists "analyses: owner full access" on public.analyses;
create policy "analyses: owner read" on public.analyses
  for select to authenticated
  using (exists (
    select 1 from public.incidents i join public.projects p on p.id = i.project_id
    where i.id = incident_id and p.owner_id = (select auth.uid())));

-- start_analysis ---------------------------------------------------------------------------------------
create or replace function public.start_analysis(p_incident uuid, p_model text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null or not exists (
    select 1 from public.incidents i join public.projects p on p.id = i.project_id
     where i.id = p_incident and p.owner_id = v_uid
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- An analysis stuck "pending" (function killed mid-run) must not block new ones forever.
  update public.analyses
     set status = 'failed', error_message = 'The analysis did not finish in time.',
         error_code = 'timeout', retryable = true, completed_at = now()
   where incident_id = p_incident and status = 'pending' and created_at < now() - interval '2 minutes';

  -- Cost guard: scoped to this user's own analyses (the function bypasses RLS, so scope it explicitly).
  if (select count(*)
        from public.analyses a
        join public.incidents i on i.id = a.incident_id
        join public.projects p on p.id = i.project_id
       where p.owner_id = v_uid and a.created_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('result', 'rate_limited');
  end if;

  begin
    insert into public.analyses (incident_id, status, model) values (p_incident, 'pending', left(p_model, 100))
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('result', 'in_progress');
  end;

  return jsonb_build_object('result', 'started', 'id', v_id);
end;
$$;

-- finish_analysis --------------------------------------------------------------------------------------
create or replace function public.finish_analysis(
  p_id uuid, p_status text, p_summary text, p_hypotheses jsonb, p_evidence uuid[],
  p_steps jsonb, p_missing jsonb, p_limitations jsonb, p_input_events integer, p_usage jsonb,
  p_model text, p_error text, p_error_code text, p_retryable boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.analyses a
     set status = p_status::public.analysis_status,
         summary = p_summary,
         hypotheses = coalesce(p_hypotheses, '[]'::jsonb),
         evidence_event_ids = coalesce(p_evidence, '{}'),
         recommended_steps = coalesce(p_steps, '[]'::jsonb),
         missing_information = coalesce(p_missing, '[]'::jsonb),
         limitations = coalesce(p_limitations, '[]'::jsonb),
         input_event_count = p_input_events,
         usage = p_usage,
         model = coalesce(p_model, a.model),
         error_message = p_error,
         error_code = p_error_code,
         retryable = coalesce(p_retryable, false),
         completed_at = now()
   where a.id = p_id and a.status = 'pending'
     and exists (
       select 1 from public.incidents i join public.projects p on p.id = i.project_id
        where i.id = a.incident_id and p.owner_id = auth.uid());
  return found;
end;
$$;

-- set_analysis_step ------------------------------------------------------------------------------------
create or replace function public.set_analysis_step(p_analysis uuid, p_index integer, p_done boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_len integer;
  v_steps integer[];
begin
  select jsonb_array_length(a.recommended_steps) into v_len
    from public.analyses a
   where a.id = p_analysis and a.status = 'complete'
     and exists (
       select 1 from public.incidents i join public.projects p on p.id = i.project_id
        where i.id = a.incident_id and p.owner_id = auth.uid());
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

-- Definer functions: callable by signed-in users only (never anon / PUBLIC).
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'start_analysis(uuid,text)',
    'finish_analysis(uuid,text,text,jsonb,uuid[],jsonb,jsonb,jsonb,integer,jsonb,text,text,text,boolean)',
    'set_analysis_step(uuid,integer,boolean)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

-- Trigger functions are never meant to be called directly; remove the default PUBLIC execute grant so the
-- API (PostgREST) does not expose them at all. Triggers still fire: EXECUTE is only checked at CREATE TRIGGER.
revoke all on function public.incidents_status_guard() from public, anon, authenticated;

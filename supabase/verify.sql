-- Read-only post-migration check. Paste into the Supabase SQL editor after applying every file in
-- supabase/migrations/. Every row must show ok = true; a false row names what is missing.
-- (It changes nothing and is also run against a freshly migrated database in the integration tests.)
with expected_tables(name) as (
  values ('projects'), ('api_keys'), ('incidents'), ('events'), ('analyses'), ('incident_events'),
         ('rate_limits'), ('incident_activity'), ('deployments')
), expected_functions(name) as (
  values ('authenticate_ingest_key'), ('consume_rate_limit'), ('ingest_events'),
         ('list_incidents'), ('get_incident'), ('list_events'), ('incident_counts'), ('dashboard_overview'),
         ('list_deployments'), ('select_evidence_events'), ('start_analysis'), ('finish_analysis'),
         ('get_latest_analysis'), ('set_analysis_step'), ('seed_demo_project'), ('remove_demo_project')
)
select 'table exists with row level security: ' || t.name as check,
       coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = t.name and c.relkind = 'r'), false) as ok
  from expected_tables t
union all
select 'function exists: ' || f.name,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = f.name)
  from expected_functions f
union all
-- migration 7: users must not be able to write analyses directly (AI cost guard)
select 'hardening applied: signed-in users cannot write analyses',
       not (has_table_privilege('authenticated', 'public.analyses', 'insert')
         or has_table_privilege('authenticated', 'public.analyses', 'update')
         or has_table_privilege('authenticated', 'public.analyses', 'delete'))
union all
select 'hardening applied: anon cannot read projects', not has_table_privilege('anon', 'public.projects', 'select')
union all
select 'ingestion functions are service-role only',
       not has_function_privilege('authenticated', 'public.ingest_events(uuid, jsonb)', 'execute')
       and has_function_privilege('service_role', 'public.ingest_events(uuid, jsonb)', 'execute')
order by 2, 1;

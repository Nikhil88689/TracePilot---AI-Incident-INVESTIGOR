-- Onboarding support for projects.
-- Requires 20261029000000_initial_schema.sql (projects + RLS policies) to be applied first.

alter table public.projects
  add column environment text not null default 'production'
    check (environment in ('production', 'staging', 'development')),
  -- Client-generated UUID for one "create project" intent. A retried request carries the
  -- same key, so it can never produce a second row.
  add column idempotency_key uuid;

create unique index projects_owner_idempotency_key_uniq
  on public.projects (owner_id, idempotency_key)
  where idempotency_key is not null;

-- One project name per owner (case-insensitive).
create unique index projects_owner_name_uniq
  on public.projects (owner_id, lower(name));

-- Ownership is enforced by the existing policy
--   "projects: owner full access" (owner_id = auth.uid(), USING and WITH CHECK).
-- The grants below make the intent explicit: signed-out (anon) requests have no table access.
revoke all on public.projects from anon;
grant select, insert, update, delete on public.projects to authenticated;

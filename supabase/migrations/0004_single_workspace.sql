-- ============================================================
-- QA Reviser — remove per-user accounts, single shared workspace
--
-- The app no longer has a login. Every audit, dealership and QA rule
-- belongs to one workspace row so the schema, foreign keys and history
-- all survive intact — re-introducing accounts later means restoring the
-- auth trigger and swapping the constant, not a data migration.
--
-- Row Level Security stays ENABLED on every table. With no session there
-- is no `auth.uid()`, so the existing policies now deny the anon key
-- outright. That is deliberate: the browser never talks to Postgres
-- directly any more, all access goes through server routes holding the
-- service-role key, and a leaked anon key grants nothing.
-- ============================================================

-- profiles.id pointed at auth.users. Without accounts there is no auth
-- user to point at, so the workspace row cannot exist until this goes.
alter table public.profiles
  drop constraint if exists profiles_id_fkey;

-- Nothing creates auth users any more.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

insert into public.profiles (id, email, full_name)
values ('00000000-0000-4000-8000-000000000001', null, 'Shared workspace')
on conflict (id) do nothing;

-- Re-home anything created under a previous account so no audit is orphaned.
do $$
declare workspace uuid := '00000000-0000-4000-8000-000000000001';
begin
  update public.audit_jobs  set user_id = workspace where user_id <> workspace;
  update public.dealerships set user_id = workspace where user_id <> workspace;
  update public.qa_rules    set user_id = workspace where user_id is not null and user_id <> workspace;
  update public.qa_feedback set user_id = workspace where user_id <> workspace;

  delete from public.profiles where id <> workspace;
end $$;

-- ============================================================
-- QA Reviser — Row Level Security
-- Every table is owner-scoped. The service-role key used by the
-- pipeline bypasses RLS; the browser only ever holds the anon key.
-- ============================================================

alter table public.profiles           enable row level security;
alter table public.dealerships        enable row level security;
alter table public.dealership_domains enable row level security;
alter table public.qa_rules           enable row level security;
alter table public.audit_jobs         enable row level security;
alter table public.articles           enable row level security;
alter table public.crawled_pages      enable row level security;
alter table public.link_checks        enable row level security;
alter table public.fact_checks        enable row level security;
alter table public.issues             enable row level security;
alter table public.auto_fixes         enable row level security;
alter table public.audit_results      enable row level security;
alter table public.qa_feedback        enable row level security;

-- ---------- profiles -----------------------------------------
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- ---------- dealerships --------------------------------------
drop policy if exists dealerships_owner on public.dealerships;
create policy dealerships_owner on public.dealerships
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists dealership_domains_owner on public.dealership_domains;
create policy dealership_domains_owner on public.dealership_domains
  for all using (
    exists (
      select 1 from public.dealerships d
      where d.id = dealership_domains.dealership_id and d.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.dealerships d
      where d.id = dealership_domains.dealership_id and d.user_id = auth.uid()
    )
  );

-- ---------- qa_rules -----------------------------------------
-- Built-in rules (user_id is null) are readable by everyone,
-- writable by no one through the anon/authenticated role.
drop policy if exists qa_rules_read on public.qa_rules;
create policy qa_rules_read on public.qa_rules
  for select using (user_id is null or user_id = auth.uid());

drop policy if exists qa_rules_write on public.qa_rules;
create policy qa_rules_write on public.qa_rules
  for insert with check (user_id = auth.uid());

drop policy if exists qa_rules_update on public.qa_rules;
create policy qa_rules_update on public.qa_rules
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists qa_rules_delete on public.qa_rules;
create policy qa_rules_delete on public.qa_rules
  for delete using (user_id = auth.uid());

-- ---------- audit_jobs ---------------------------------------
drop policy if exists audit_jobs_owner on public.audit_jobs;
create policy audit_jobs_owner on public.audit_jobs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- job-scoped child tables --------------------------
-- One policy shape reused for every table that hangs off a job.
do $$
declare t text;
begin
  foreach t in array array[
    'articles', 'crawled_pages', 'link_checks',
    'fact_checks', 'issues', 'auto_fixes', 'audit_results'
  ] loop
    execute format('drop policy if exists %1$s_via_job on public.%1$s', t);
    execute format($f$
      create policy %1$s_via_job on public.%1$s
        for all using (
          exists (
            select 1 from public.audit_jobs j
            where j.id = %1$s.job_id and j.user_id = auth.uid()
          )
        ) with check (
          exists (
            select 1 from public.audit_jobs j
            where j.id = %1$s.job_id and j.user_id = auth.uid()
          )
        )
    $f$, t);
  end loop;
end $$;

-- ---------- qa_feedback --------------------------------------
drop policy if exists qa_feedback_owner on public.qa_feedback;
create policy qa_feedback_owner on public.qa_feedback
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
-- QA Reviser — initial schema
-- Run in Supabase → SQL Editor, or `supabase db push`.
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- enums -------------------------------------------
do $$ begin
  create type job_status as enum ('queued', 'running', 'complete', 'failed', 'canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_step as enum (
    'fetch_article',
    'extract_content',
    'crawl_dealership',
    'analyze_links',
    'analyze_qa_rules',
    'verify_facts',
    'apply_fixes',
    'final_audit',
    'save_report',
    'complete'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type issue_severity as enum ('info', 'low', 'medium', 'high', 'critical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type fix_mode as enum ('none', 'safe', 'suggest');
exception when duplicate_object then null; end $$;

do $$ begin
  create type rule_kind as enum ('regex', 'ai', 'link', 'structural');
exception when duplicate_object then null; end $$;

do $$ begin
  create type fact_verdict as enum ('supported', 'contradicted', 'unverified');
exception when duplicate_object then null; end $$;

do $$ begin
  create type feedback_verdict as enum ('accept', 'reject', 'modify');
exception when duplicate_object then null; end $$;

-- ---------- users -------------------------------------------
-- Mirrors auth.users so app tables can carry a FK and RLS can
-- read a profile without touching the auth schema.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- dealerships --------------------------------------
create table if not exists public.dealerships (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  name           text not null,
  primary_domain text not null,
  city           text,
  state          text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists dealerships_user_idx on public.dealerships (user_id);

-- Domains the crawler is ALLOWED to visit for a dealership.
-- Nothing outside this allow-list is ever crawled.
create table if not exists public.dealership_domains (
  id            uuid primary key default gen_random_uuid(),
  dealership_id uuid not null references public.dealerships (id) on delete cascade,
  domain        text not null,
  label         text,
  is_approved   boolean not null default true,
  max_pages     integer not null default 25,
  created_at    timestamptz not null default now(),
  unique (dealership_id, domain)
);
create index if not exists dealership_domains_dealership_idx
  on public.dealership_domains (dealership_id);

-- ---------- QA rules -----------------------------------------
create table if not exists public.qa_rules (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles (id) on delete cascade,
  dealership_id uuid references public.dealerships (id) on delete cascade,
  code          text not null,
  title         text not null,
  description   text not null,
  category      text not null default 'style',
  kind          rule_kind not null default 'ai',
  severity      issue_severity not null default 'medium',
  pattern       text,
  replacement   text,
  guidance      text,
  fix_mode      fix_mode not null default 'suggest',
  is_active     boolean not null default true,
  is_builtin    boolean not null default false,
  sort_order    integer not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists qa_rules_user_idx on public.qa_rules (user_id);
create index if not exists qa_rules_active_idx on public.qa_rules (is_active);
-- Built-in rules are global (user_id is null); user rules are unique per user.
create unique index if not exists qa_rules_builtin_code_idx
  on public.qa_rules (code) where user_id is null;
create unique index if not exists qa_rules_user_code_idx
  on public.qa_rules (user_id, code) where user_id is not null;

-- ---------- audit jobs ---------------------------------------
create table if not exists public.audit_jobs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  dealership_id  uuid references public.dealerships (id) on delete set null,
  source_url     text not null,
  status         job_status not null default 'queued',
  step           job_step not null default 'fetch_article',
  progress       integer not null default 0,
  status_message text not null default 'Audit started',
  error          text,
  attempts       integer not null default 0,
  -- Optimistic lease: a worker owns the job until lease_expires_at.
  lease_expires_at timestamptz,
  -- Per-step scratch state (crawl frontier, link queue, cursors).
  state          jsonb not null default '{}'::jsonb,
  options        jsonb not null default '{}'::jsonb,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists audit_jobs_user_idx on public.audit_jobs (user_id, created_at desc);
create index if not exists audit_jobs_status_idx on public.audit_jobs (status, lease_expires_at);

-- ---------- articles (original + revised) --------------------
create table if not exists public.articles (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.audit_jobs (id) on delete cascade,
  kind        text not null check (kind in ('original', 'revised')),
  url         text,
  title       text,
  byline      text,
  html        text,
  markdown    text,
  text        text,
  word_count  integer not null default 0,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (job_id, kind)
);

-- ---------- crawled dealership pages -------------------------
create table if not exists public.crawled_pages (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.audit_jobs (id) on delete cascade,
  dealership_id uuid references public.dealerships (id) on delete set null,
  url           text not null,
  title         text,
  summary       text,
  text          text,
  status_code   integer,
  render_mode   text not null default 'fetch',
  links         jsonb not null default '[]'::jsonb,
  fetched_at    timestamptz not null default now(),
  unique (job_id, url)
);
create index if not exists crawled_pages_job_idx on public.crawled_pages (job_id);

-- ---------- link analysis ------------------------------------
create table if not exists public.link_checks (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.audit_jobs (id) on delete cascade,
  url            text not null,
  resolved_url   text,
  anchor_text    text,
  link_type      text not null check (link_type in ('internal', 'external')),
  is_dealership  boolean not null default false,
  status_code    integer,
  ok             boolean not null default false,
  redirected     boolean not null default false,
  error          text,
  checked_at     timestamptz not null default now(),
  unique (job_id, url)
);
create index if not exists link_checks_job_idx on public.link_checks (job_id);

-- ---------- fact verification --------------------------------
create table if not exists public.fact_checks (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.audit_jobs (id) on delete cascade,
  claim       text not null,
  verdict     fact_verdict not null default 'unverified',
  confidence  numeric(3, 2) not null default 0.0,
  source_url  text,
  evidence    text,
  notes       text,
  created_at  timestamptz not null default now()
);
create index if not exists fact_checks_job_idx on public.fact_checks (job_id);

-- ---------- detected issues ----------------------------------
create table if not exists public.issues (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.audit_jobs (id) on delete cascade,
  rule_id      uuid references public.qa_rules (id) on delete set null,
  rule_code    text,
  category     text not null default 'style',
  severity     issue_severity not null default 'medium',
  title        text not null,
  detail       text,
  evidence     text,
  suggestion   text,
  location     jsonb not null default '{}'::jsonb,
  auto_fixable boolean not null default false,
  -- 'open' after detection, 'fixed' once an auto-fix applied,
  -- 'resolved' if it disappeared in the final re-audit.
  status       text not null default 'open',
  phase        text not null default 'initial' check (phase in ('initial', 'final')),
  created_at   timestamptz not null default now()
);
create index if not exists issues_job_idx on public.issues (job_id, phase);

-- ---------- auto-fixes ---------------------------------------
create table if not exists public.auto_fixes (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.audit_jobs (id) on delete cascade,
  issue_id    uuid references public.issues (id) on delete set null,
  rule_code   text,
  kind        text not null default 'text_replace',
  before_text text not null,
  after_text  text not null,
  reason      text,
  applied     boolean not null default false,
  skipped_reason text,
  created_at  timestamptz not null default now()
);
create index if not exists auto_fixes_job_idx on public.auto_fixes (job_id);

-- ---------- audit results / report ---------------------------
create table if not exists public.audit_results (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.audit_jobs (id) on delete cascade,
  score       integer not null default 0,
  final_score integer not null default 0,
  summary     text,
  totals      jsonb not null default '{}'::jsonb,
  report      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (job_id)
);

-- ---------- QA feedback (human review of findings) -----------
create table if not exists public.qa_feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  issue_id   uuid references public.issues (id) on delete cascade,
  rule_id    uuid references public.qa_rules (id) on delete set null,
  job_id     uuid references public.audit_jobs (id) on delete cascade,
  verdict    feedback_verdict not null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists qa_feedback_rule_idx on public.qa_feedback (rule_id);
create index if not exists qa_feedback_user_idx on public.qa_feedback (user_id);

-- ---------- updated_at triggers ------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['dealerships', 'qa_rules', 'audit_jobs'] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format(
      'create trigger touch_%1$s before update on public.%1$s
       for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

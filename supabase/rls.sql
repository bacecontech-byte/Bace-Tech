-- Pillier — Row-Level Security (multi-tenant isolation). Run once in the
-- Supabase SQL editor. Free feature; no paid tier required.
--
-- Model: each user belongs to a "workspace" identified by companies.name, which
-- equals their signup company (teammates share) or, if none, their own email
-- (solo, isolated). A company_members table maps auth users → companies, and every
-- data table is locked so a user can only touch rows for a company they belong to.
--
-- SAFE ORDER: deploy the app first (it self-registers membership on login), THEN
-- run this. Existing sessions pick it up on reload.

-- The workspace name this user is allowed into (company name, else email).
create or replace function auth_workspace() returns text
language sql stable as $$
  select coalesce(
    nullif(btrim(coalesce(auth.jwt() -> 'user_metadata' ->> 'company','')), ''),
    lower(auth.jwt() ->> 'email')
  );
$$;

-- Membership: which companies an auth user belongs to.
create table if not exists company_members (
  user_id    uuid references auth.users(id) on delete cascade,
  company_id uuid references companies(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, company_id)
);

-- Fast membership check, SECURITY DEFINER so policies can read the mapping
-- regardless of the caller's own RLS.
create or replace function is_member(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from company_members where user_id = auth.uid() and company_id = cid
  );
$$;

-- ── companies: a user sees/creates only their own workspace row ──────────────
alter table companies enable row level security;
drop policy if exists companies_own_select on companies;
drop policy if exists companies_own_insert on companies;
create policy companies_own_select on companies for select to authenticated
  using (lower(name) = auth_workspace() or name = auth_workspace());
create policy companies_own_insert on companies for insert to authenticated
  with check (name = auth_workspace());

-- ── company_members: a user manages only their own membership, and only for a
--    company matching their JWT workspace (can't join someone else's company) ──
alter table company_members enable row level security;
drop policy if exists cm_select on company_members;
drop policy if exists cm_insert on company_members;
create policy cm_select on company_members for select to authenticated
  using (user_id = auth.uid());
create policy cm_insert on company_members for insert to authenticated
  with check (
    user_id = auth.uid()
    and company_id in (select id from companies where name = auth_workspace())
  );

-- ── Data tables: full access limited to rows of a company the user belongs to ──
do $$
declare t text;
begin
  foreach t in array array[
    'captures','projects','project_documents',
    'community_posts','community_replies','user_usage'
  ]
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists %I on %I;', t||'_member_all', t);
    execute format(
      'create policy %I on %I for all to authenticated using (is_member(company_id)) with check (is_member(company_id));',
      t||'_member_all', t
    );
  end loop;
end $$;

-- ── Server-only tables: writes/reads happen with the service-role key, which
--    bypasses RLS. Enable RLS with NO policies so nothing else can read them. ──
alter table if exists cloud_connections enable row level security;
-- doc_chunks already has RLS enabled by supabase/pgvector.sql (server-only).

-- SACCI Portal — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Project → SQL Editor → New query).
-- Safe to re-run individual sections if something fails partway; DROP lines are commented out on purpose.

-- ─── PROFILES ───────────────────────────────────────────────
-- One row per person who can log in. id matches auth.users.id.
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  name text not null,
  role text not null check (role in ('staff','advisor')),
  created_at timestamptz default now()
);

-- ─── PATIENTS ───────────────────────────────────────────────
create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  age int,
  gender text,
  phone text,
  village text,
  block text,
  district text default 'Muzaffarpur',
  aadhar text,
  bank text,
  account text,
  ifsc text,
  diagnosis text,
  status text default 'Screening',
  admitted text default 'No',
  visit_num int default 1,
  treatment text,
  medication text,
  next_visit date,
  next_test text,
  test_date date,
  med_date date,
  notes text,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text
);

-- ─── PATIENT FILES (metadata only — bytes live in Storage) ──
create table if not exists patient_files (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete cascade,
  name text not null,
  category text default 'Other',
  storage_path text not null,
  uploaded_at timestamptz default now(),
  uploaded_by text
);

-- ─── HELPER FUNCTIONS ───────────────────────────────────────
create or replace function is_staff() returns boolean
language sql security definer stable as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'staff');
$$;

create or replace function has_profile() returns boolean
language sql security definer stable as $$
  select exists(select 1 from profiles where id = auth.uid());
$$;

-- ─── ROW LEVEL SECURITY ─────────────────────────────────────
alter table profiles enable row level security;
alter table patients enable row level security;
alter table patient_files enable row level security;

drop policy if exists "read own profile" on profiles;
create policy "read own profile" on profiles for select
  using (auth.uid() = id);

drop policy if exists "staff and advisors read patients" on patients;
create policy "staff and advisors read patients" on patients for select
  using (has_profile());

drop policy if exists "staff insert patients" on patients;
create policy "staff insert patients" on patients for insert
  with check (is_staff());

drop policy if exists "staff update patients" on patients;
create policy "staff update patients" on patients for update
  using (is_staff());

drop policy if exists "staff delete patients" on patients;
create policy "staff delete patients" on patients for delete
  using (is_staff());

drop policy if exists "staff and advisors read files" on patient_files;
create policy "staff and advisors read files" on patient_files for select
  using (has_profile());

drop policy if exists "staff insert files" on patient_files;
create policy "staff insert files" on patient_files for insert
  with check (is_staff());

drop policy if exists "staff delete files" on patient_files;
create policy "staff delete files" on patient_files for delete
  using (is_staff());

-- ─── PUBLIC (NO LOGIN) VIEW ─────────────────────────────────
-- Anonymised — no name, phone, aadhar, bank, account, ifsc, notes.
-- security_invoker = false: this view runs with the privileges of its owner,
-- not the querying (anon) role, so it can read patients despite that role
-- having no direct RLS access to the base table.
drop view if exists patients_public;
create view patients_public
with (security_invoker = false) as
  select id, age, gender, block, diagnosis, status, visit_num, created_at
  from patients;

grant select on patients_public to anon;
grant usage on schema public to anon;

-- ─── STORAGE POLICIES ───────────────────────────────────────
-- Run AFTER creating the `patient-files` bucket (Storage → New bucket,
-- name it exactly `patient-files`, set Private).
drop policy if exists "staff manage patient files" on storage.objects;
create policy "staff manage patient files" on storage.objects for all
  using (bucket_id = 'patient-files' and is_staff())
  with check (bucket_id = 'patient-files' and is_staff());

drop policy if exists "advisors read patient files" on storage.objects;
create policy "advisors read patient files" on storage.objects for select
  using (bucket_id = 'patient-files' and has_profile());

-- ─── REALTIME ───────────────────────────────────────────────
-- Lets the portal subscribe to live inserts/updates/deletes.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'patients'
  ) then
    alter publication supabase_realtime add table patients;
  end if;
end $$;

-- ─── AFTER INVITING USERS (Authentication → Users → Invite) ─
-- Run this once per person, after they've been invited, filling in their
-- real email and correct role. Find their auth id via:
--   select id, email from auth.users;
--
-- insert into profiles (id, name, role) values
--   ('<their-auth-uuid>', '<Their Name>', 'staff');   -- or 'advisor'

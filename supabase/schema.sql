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

-- ─── PATIENT CODE (short, human-readable ID) ─────────────────
-- Purely numeric, e.g. 202601 = 1st patient registered in 2026, 202602 = 2nd.
-- Resets each year. Auto-assigned on insert; never generated client-side so
-- two simultaneous inserts can't collide.
alter table patients add column if not exists patient_code text unique;

create or replace function assign_patient_code() returns trigger
language plpgsql as $$
declare
  yr text := to_char(now(), 'YYYY');
  seq int;
begin
  if new.patient_code is null then
    select count(*) + 1 into seq from patients where patient_code like yr || '%';
    new.patient_code := yr || lpad(seq::text, 2, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_patient_code on patients;
create trigger trg_assign_patient_code before insert on patients
for each row execute function assign_patient_code();

-- One-time backfill for existing patients that predate this column —
-- assigns codes in registration order, safe to re-run (skips rows that
-- already have a code).
do $$
declare
  r record;
  yr text;
  seq int := 0;
  last_yr text := '';
begin
  for r in select id, created_at from patients where patient_code is null order by created_at loop
    yr := to_char(r.created_at, 'YYYY');
    if yr <> last_yr then seq := 0; last_yr := yr; end if;
    seq := seq + 1;
    update patients set patient_code = yr || lpad(seq::text, 2, '0') where id = r.id;
  end loop;
end $$;

-- ─── TRANSACTIONS (money given to/for patients) ──────────────
-- Staff-only in both directions — advisors and the public never see this,
-- unlike patients/patient_files which advisors can read.
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  purpose text not null check (purpose in ('Travel','Screening','Treatment','Medicine','Hospital Stay','Other')),
  notes text,
  txn_date date not null default current_date,
  recorded_by text,
  created_at timestamptz default now()
);

alter table transactions enable row level security;

drop policy if exists "staff only read transactions" on transactions;
create policy "staff only read transactions" on transactions for select
  using (is_staff());

drop policy if exists "staff insert transactions" on transactions;
create policy "staff insert transactions" on transactions for insert
  with check (is_staff());

drop policy if exists "staff update transactions" on transactions;
create policy "staff update transactions" on transactions for update
  using (is_staff());

drop policy if exists "staff delete transactions" on transactions;
create policy "staff delete transactions" on transactions for delete
  using (is_staff());

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
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'transactions'
  ) then
    alter publication supabase_realtime add table transactions;
  end if;
end $$;

-- ─── AFTER INVITING USERS (Authentication → Users → Invite) ─
-- Run this once per person, after they've been invited, filling in their
-- real email and correct role. Find their auth id via:
--   select id, email from auth.users;
--
-- insert into profiles (id, name, role) values
--   ('<their-auth-uuid>', '<Their Name>', 'staff');   -- or 'advisor'

-- ─── AI ANALYSIS + CASE SUMMARY ───────────────────────────────
-- Written server-side by the analyze-report / summarize-patient Edge
-- Functions (service-role key, bypasses RLS by design — the functions
-- themselves check the caller's role before doing anything). No new
-- policies needed: these are just columns on tables already covered by
-- the has_profile()/is_staff() select/update policies above.
alter table patient_files add column if not exists ai_analysis jsonb;
alter table patient_files add column if not exists ai_analyzed_at timestamptz;
alter table patients add column if not exists ai_summary text;
alter table patients add column if not exists ai_summary_generated_at timestamptz;

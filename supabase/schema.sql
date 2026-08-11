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

-- ─── FINANCE: COMMITTED AMOUNT ──────────────────────────────
-- What SACCI has committed to for this patient's care — set manually or via
-- a parsed update. Advance Given/Pending Payment on the Finances page are
-- computed client-side from this plus the existing transactions table, no
-- new columns needed for those.
alter table patients add column if not exists committed_amount numeric(10,2);

-- ─── ACTIVITIES (org-level, not tied to one patient) ─────────
-- Meetings, health camps, trainings — logged manually or via the Quick
-- Update page's parse-bulk-update classification. Not linked to any
-- specific patient row on purpose; this is organizational/story material,
-- not clinical data.
create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  activity_date date not null default current_date,
  activity_type text not null default 'Other' check (activity_type in ('Meeting','Health Camp','Training','Other')),
  title text,
  description text,
  participants text,
  created_by text,
  created_at timestamptz default now()
);

alter table activities enable row level security;

-- Same visibility split as patients: staff and advisors can read (Dr.
-- Vidyasagar is often a participant himself), only staff can write.
drop policy if exists "staff and advisors read activities" on activities;
create policy "staff and advisors read activities" on activities for select
  using (has_profile());

drop policy if exists "staff insert activities" on activities;
create policy "staff insert activities" on activities for insert
  with check (is_staff());

drop policy if exists "staff update activities" on activities;
create policy "staff update activities" on activities for update
  using (is_staff());

drop policy if exists "staff delete activities" on activities;
create policy "staff delete activities" on activities for delete
  using (is_staff());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'activities'
  ) then
    alter publication supabase_realtime add table activities;
  end if;
end $$;

-- ─── CASE CLOSURE ────────────────────────────────────────────
-- A deliberate, reason-tracked close-out — distinct from status='Completed'
-- (successful treatment completion). Covers death, discontinuing treatment,
-- or transferring to another hospital. Reuses the existing `status` column
-- (no check constraint on it, so 'Case Closed' just works) rather than a
-- separate boolean, so it shows up in the same badges/filters everywhere
-- status already does.
alter table patients add column if not exists closure_reason text;
alter table patients add column if not exists closure_notes text;
alter table patients add column if not exists closed_at timestamptz;

-- ═══════════════════════════════════════════════════════════════
-- UNIVERSAL LOG (2026-08-11 restructure)
-- The input model generalizes from "a thing about a patient" to "any log":
-- camps, saathi joinings, volunteer drafting, meetings, patient visits —
-- one stream. Categories live in log_types (data, not code) so new kinds
-- of entries need no schema or code change. The WhatsApp group is the main
-- input source via pasted chat exports, deduped in whatsapp_messages.
-- ═══════════════════════════════════════════════════════════════

-- ─── LOG TYPES (dynamic categories) ──────────────────────────
-- Staff add/retire categories from the portal as the work evolves; the
-- portal and public dashboard render whatever is here. Retire a type by
-- setting active=false — deleting is blocked while any log still uses it.
create table if not exists log_types (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  emoji text default '📌',
  -- Pre-ticks the "public" checkbox for new entries of this type. A human
  -- still confirms at review time — nothing goes public without that.
  public_default boolean not null default false,
  -- Whether this type gets a count tile on the public dashboard.
  show_public_tile boolean not null default false,
  tile_label text,                -- public tile wording, e.g. 'Camps Held'
  sort_order int not null default 100,
  active boolean not null default true,
  created_at timestamptz default now()
);

-- Volunteers and cancer saathis are the same people in SACCI's model, so
-- there is deliberately no separate Volunteer category.
insert into log_types (name, emoji, public_default, show_public_tile, tile_label, sort_order) values
  ('Patient Update',       '🩺', false, false, null,             10),
  ('Health Camp',          '⛺', true,  true,  'Camps Held',     20),
  ('Cancer Saathi Joined', '🤝', true,  true,  'Cancer Saathis', 30),
  ('Meeting',              '👥', false, false, null,             50),
  ('Training',             '🎓', false, false, null,             60),
  ('Milestone',            '🏆', true,  false, null,             70),
  ('Other',                '📌', false, false, null,             90)
on conflict (name) do nothing;

-- ─── LOGS (the universal stream) ─────────────────────────────
-- One row per loggable thing. Patient care hangs off the stream via the
-- nullable patient_id rather than the stream hanging off patients.
-- is_public is the single gate to the public dashboard and is only ever
-- set by a human at entry/review time.
create table if not exists logs (
  id uuid primary key default gen_random_uuid(),
  occurred_on date not null default current_date,
  log_type_id uuid not null references log_types(id) on delete restrict,
  title text,
  description text,
  participants text,
  patient_id uuid references patients(id) on delete set null,
  is_public boolean not null default false,
  source text not null default 'manual'
    check (source in ('manual','quick-update','whatsapp','system')),
  source_text text,               -- verbatim origin, e.g. the WhatsApp lines this came from
  legacy_activity_id uuid unique, -- set only on rows migrated from `activities`
  created_by text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  updated_by text
);

-- ─── LOG FILES (photos/documents attached to a log entry) ────
-- Bytes live in the `log-files` Storage bucket (created PUBLIC — this is
-- storytelling material like camp photos, and paths are unguessable uuids).
-- Anything clinically sensitive belongs in patient_files / the private
-- patient-files bucket instead, never here; the import review step routes
-- medical report photos there.
create table if not exists log_files (
  id uuid primary key default gen_random_uuid(),
  log_id uuid not null references logs(id) on delete cascade,
  name text not null,
  storage_path text not null,
  is_public boolean not null default false, -- may appear on the public timeline
  uploaded_at timestamptz default now(),
  uploaded_by text
);

-- ─── WHATSAPP MESSAGES (import ledger + archive) ─────────────
-- Every message the WhatsApp import has ever seen, hashed for dedup, so
-- overlapping chat exports can be pasted repeatedly without double-logging.
-- Doubles as a permanent archive of the group's history. Staff-only in
-- both directions, like transactions — raw messages name patients freely.
create table if not exists whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  msg_hash text unique not null,  -- sha-256 of sender|sent_at|body
  sender text,
  sent_at timestamptz,
  body text,
  imported_at timestamptz default now(),
  imported_by text
);

-- ─── RLS FOR THE LOG TABLES ──────────────────────────────────
alter table log_types enable row level security;
alter table logs enable row level security;
alter table log_files enable row level security;
alter table whatsapp_messages enable row level security;

-- log_types / logs / log_files: same split as patients — staff and
-- advisors read, staff write.
drop policy if exists "staff and advisors read log_types" on log_types;
create policy "staff and advisors read log_types" on log_types for select
  using (has_profile());

drop policy if exists "staff write log_types" on log_types;
create policy "staff write log_types" on log_types for all
  using (is_staff()) with check (is_staff());

drop policy if exists "staff and advisors read logs" on logs;
create policy "staff and advisors read logs" on logs for select
  using (has_profile());

drop policy if exists "staff write logs" on logs;
create policy "staff write logs" on logs for all
  using (is_staff()) with check (is_staff());

drop policy if exists "staff and advisors read log_files" on log_files;
create policy "staff and advisors read log_files" on log_files for select
  using (has_profile());

drop policy if exists "staff write log_files" on log_files;
create policy "staff write log_files" on log_files for all
  using (is_staff()) with check (is_staff());

drop policy if exists "staff only whatsapp_messages" on whatsapp_messages;
create policy "staff only whatsapp_messages" on whatsapp_messages for all
  using (is_staff()) with check (is_staff());

-- ─── PUBLIC (NO LOGIN) LOG VIEWS ─────────────────────────────
-- Same pattern as patients_public: owner-privilege views, so anon sees
-- only what a human explicitly flagged public. patient_id, source_text
-- and created_by never cross this boundary.
drop view if exists logs_public;
create view logs_public
with (security_invoker = false) as
  select l.id, l.occurred_on, t.name as log_type, t.emoji,
         l.title, l.description, l.participants, l.created_at
  from logs l
  join log_types t on t.id = l.log_type_id
  where l.is_public;

drop view if exists log_tiles_public;
create view log_tiles_public
with (security_invoker = false) as
  select t.name, t.emoji, coalesce(t.tile_label, t.name) as tile_label,
         t.sort_order, count(l.id) filter (where l.is_public) as n_public
  from log_types t
  left join logs l on l.log_type_id = t.id
  where t.show_public_tile and t.active
  group by t.id;

drop view if exists log_files_public;
create view log_files_public
with (security_invoker = false) as
  select f.log_id, f.name, f.storage_path
  from log_files f
  join logs l on l.id = f.log_id
  where f.is_public and l.is_public;

grant select on logs_public to anon;
grant select on log_tiles_public to anon;
grant select on log_files_public to anon;

-- Logged-in staff/advisors preview the same public page inside the portal,
-- so the views need to answer for them too (they could read the base tables
-- anyway — this leaks nothing new).
grant select on logs_public to authenticated;
grant select on log_tiles_public to authenticated;
grant select on log_files_public to authenticated;

-- ─── MIGRATE ACTIVITIES → LOGS ───────────────────────────────
-- Copies every activities row into logs exactly once (legacy_activity_id
-- makes this idempotent — safe to re-run). The activities table and its
-- portal page keep working during the transition; once the portal reads
-- logs everywhere, activities freezes as legacy and can later be dropped.
insert into logs (occurred_on, log_type_id, title, description, participants,
                  source, legacy_activity_id, created_by, created_at)
select a.activity_date,
       (select id from log_types where name = a.activity_type),
       a.title, a.description, a.participants,
       'manual', a.id, a.created_by, a.created_at
from activities a
where not exists (select 1 from logs l where l.legacy_activity_id = a.id);

-- ─── REALTIME FOR LOGS ───────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'logs'
  ) then
    alter publication supabase_realtime add table logs;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'log_types'
  ) then
    alter publication supabase_realtime add table log_types;
  end if;
end $$;

-- ─── STORAGE POLICIES: LOG FILES ─────────────────────────────
-- Run AFTER creating the `log-files` bucket (Storage → New bucket, name it
-- exactly `log-files`, set PUBLIC — see the log_files comment for why).
drop policy if exists "staff manage log files" on storage.objects;
create policy "staff manage log files" on storage.objects for all
  using (bucket_id = 'log-files' and is_staff())
  with check (bucket_id = 'log-files' and is_staff());

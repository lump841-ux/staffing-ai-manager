-- Staffing AI Manager — schema
-- Idempotent: every CREATE uses IF NOT EXISTS so this file can be re-run
-- safely on every boot (see services/db.js applySchema()).

CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  address TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  branch_id INTEGER REFERENCES branches(id),
  -- 'worker' here means a recruiter/staffing-coordinator on the agency's own
  -- payroll (tracks calls made, placements, etc. via daily_reports).
  -- 'temp' is a completely separate person: someone the agency
  -- places at a client company's job site (the Assignment Communication
  -- Network's "Today's Assignment" screen). Never conflate the two.
  role TEXT NOT NULL CHECK (role IN ('owner','manager','worker','temp')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  avatar_url TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Manager-defined, fully customizable reporting categories.
CREATE TABLE IF NOT EXISTS activity_categories (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, key)
);

-- Per-worker, per-category daily target. Manager-set only.
CREATE TABLE IF NOT EXISTS worker_goals (
  id SERIAL PRIMARY KEY,
  worker_id INTEGER NOT NULL REFERENCES users(id),
  category_id INTEGER NOT NULL REFERENCES activity_categories(id),
  daily_target INTEGER NOT NULL DEFAULT 0,
  set_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(worker_id, category_id)
);

-- The core daily submission (one per worker per day).
CREATE TABLE IF NOT EXISTS daily_reports (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  report_date DATE NOT NULL,
  notes TEXT,
  obstacles TEXT,
  submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(worker_id, report_date)
);

CREATE TABLE IF NOT EXISTS daily_report_values (
  id SERIAL PRIMARY KEY,
  daily_report_id INTEGER NOT NULL REFERENCES daily_reports(id),
  category_id INTEGER NOT NULL REFERENCES activity_categories(id),
  value INTEGER NOT NULL DEFAULT 0,
  UNIQUE(daily_report_id, category_id)
);

-- Manager-only. Workers have no route, no UI, and no query path to this table.
CREATE TABLE IF NOT EXISTS worker_time_entries (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  entry_date DATE NOT NULL,
  hours_worked NUMERIC(5,2),
  entry_type TEXT NOT NULL DEFAULT 'regular' CHECK (entry_type IN ('regular','pto','sick','unpaid','other')),
  notes TEXT,
  entered_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- System-flagged, never an accusation — manager reviews and sets status.
CREATE TABLE IF NOT EXISTS discrepancies (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  daily_report_id INTEGER NOT NULL REFERENCES daily_reports(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  rule_key TEXT NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','correct','needs_correction','follow_up','resolved')),
  reviewed_by_user_id INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS manager_tasks (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  manager_id INTEGER NOT NULL REFERENCES users(id),
  related_worker_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  notes TEXT,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai_created')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS manager_debriefs (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  manager_id INTEGER NOT NULL REFERENCES users(id),
  debrief_date DATE NOT NULL,
  went_well TEXT,
  problems TEXT,
  other_notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(manager_id, debrief_date)
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  message TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  metadata TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════════
-- SaaS Signup, Billing & Photo Verification — added on top of the
-- existing single-tenant-per-org model above. organizations already
-- doubles as "staffing agency account" and every existing table is
-- already organization_id-scoped, so tenant isolation for the new
-- billing/photo data follows the same established pattern.
-- ════════════════════════════════════════════════════════════════════

-- Agency subscription/billing state, layered onto the existing
-- organizations table so nothing about the existing org model changes.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'legacy'
  CHECK (plan IN ('legacy','founding','growth','professional','enterprise'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'active'
  CHECK (billing_status IN ('trialing','active','past_due','canceled','suspended'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_founding_partner BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS setup_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS setup_fee_waived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS setup_fee_paid BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS next_billing_date DATE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS payment_method_label TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_contact_name TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_email TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS signup_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (signup_source IN ('manual','self_signup'));

-- Only A Job's own platform operators — entirely separate login space
-- from staffing-agency users. An agency owner/manager/worker can never
-- authenticate here, and this table is never joined against org-scoped
-- queries used by agency routes.
CREATE TABLE IF NOT EXISTS platform_admins (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Every billable event for an agency: the one-time setup fee, each
-- monthly subscription charge, plan changes, waivers, refunds. This is
-- the ledger the Agency Billing Dashboard and the Super Admin both read.
CREATE TABLE IF NOT EXISTS billing_events (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  type TEXT NOT NULL CHECK (type IN ('setup_fee','subscription_charge','plan_change','waiver','refund')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','waived','failed','pending')),
  created_by_admin_id INTEGER REFERENCES platform_admins(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- "Contact Sales" submissions from the Enterprise pricing tier — reviewed
-- by the Super Admin, not auto-provisioned.
CREATE TABLE IF NOT EXISTS enterprise_leads (
  id SERIAL PRIMARY KEY,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  office_count TEXT,
  employee_count TEXT,
  requirements TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','closed')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Photo proof of a completed activity. Additive to the existing
-- daily_reports/daily_report_values numeric tracking — this is separate,
-- per-completion evidence a worker attaches, reviewed by a manager.
-- Verification can only ever be set by a manager/owner route — the
-- worker-facing routes in routes/worker.js never accept or write status.
CREATE TABLE IF NOT EXISTS activity_proofs (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  category_id INTEGER REFERENCES activity_categories(id),
  title TEXT NOT NULL,
  note TEXT,
  photo_data_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification','verified','needs_review')),
  submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_by_user_id INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMP,
  review_comment TEXT
);

-- Holds everything collected in the signup wizard (company, contact, owner
-- login, chosen plan) while the person is over on Stripe Checkout paying.
-- Nothing here becomes a real organizations/users row until Stripe confirms
-- payment_status = 'paid' (see routes/signup.js GET /confirm) — this table
-- is just a waiting room, never a source of account access on its own.
CREATE TABLE IF NOT EXISTS pending_signups (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL,
  office_name TEXT,
  office_address TEXT,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  organization_id INTEGER REFERENCES organizations(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMP
);

-- ════════════════════════════════════════════════════════════════════
-- Worker personal work history + optional self clock-in.
-- The work history itself (daily_reports/activity_proofs, both already
-- worker_id-scoped) needed no new storage — it's exposed permanently on
-- the worker's own account via a new read-only endpoint. Self clock-in is
-- a genuinely new, OFF-by-default feature: an org-level switch the owner
-- controls, plus its own table so it never touches worker_time_entries
-- (which stays manager-only, per the existing invariant in routes/worker.js).
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS self_clockin_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Temp Chat is a paid upgrade: two-way messaging between a temp, their
-- recruiter/lead, and the client company on an assignment. Off by default
-- for brand-new agencies (see routes/signup.js) — existing/demo agencies
-- default to TRUE here so nothing already built breaks. Only a platform
-- Super Admin can flip this — see POST /platform-admin/agencies/:id/temp-chat.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS temp_chat_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Worker-initiated clock in/out. Entirely separate from worker_time_entries
-- (manager-only, payroll-facing) — this is the worker's own self-reported
-- record, visible to the worker on their own history and readable by
-- managers for reference, but never a source managers write into.
CREATE TABLE IF NOT EXISTS worker_clock_entries (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  clock_in_at TIMESTAMP NOT NULL DEFAULT NOW(),
  clock_out_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Breaks within a single clock-in. A worker can take more than one break
-- per shift, so this is its own table rather than columns on the clock
-- entry. Always tied to one open (or since-closed) worker_clock_entries row.
CREATE TABLE IF NOT EXISTS worker_break_entries (
  id SERIAL PRIMARY KEY,
  clock_entry_id INTEGER NOT NULL REFERENCES worker_clock_entries(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  break_start_at TIMESTAMP NOT NULL DEFAULT NOW(),
  break_end_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════════
-- ASSIGNMENT COMMUNICATION NETWORK
-- Everything below is additive — no existing table is altered in a
-- breaking way. The core idea: an "assignment" is the thing that knows
-- who a worker is placed with (client company/location/department/
-- shift/supervisor) and that knowledge is what drives who gets
-- contacted for any given event. Client-side people (supervisors, HR)
-- get their own login space — client_contacts — mirroring the
-- platform_admins pattern already established above: a completely
-- separate table and session key from the agency `users` table, so a
-- client login can never satisfy an agency-role check or vice versa.
-- ════════════════════════════════════════════════════════════════════

-- Per-agency, configurable — never hard-coded (spec §9, §18).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS no_show_grace_minutes INTEGER NOT NULL DEFAULT 20;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS escalation_minutes INTEGER NOT NULL DEFAULT 10;

CREATE TABLE IF NOT EXISTS client_companies (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Financial fields — what the agency bills THIS client. Owner-only data:
-- never returned by any query a manager-role session can reach (see
-- routes/manager.js — these columns are stripped before the response
-- unless req.session.user.role === 'owner'). Kept on the same row rather
-- than a separate table so there's exactly one place ownership is
-- enforced, not two.
ALTER TABLE client_companies ADD COLUMN IF NOT EXISTS bill_rate_hourly NUMERIC(10,2);
ALTER TABLE client_companies ADD COLUMN IF NOT EXISTS pay_rate_hourly NUMERIC(10,2);
ALTER TABLE client_companies ADD COLUMN IF NOT EXISTS contract_value NUMERIC(12,2);
ALTER TABLE client_companies ADD COLUMN IF NOT EXISTS billing_notes TEXT;

CREATE TABLE IF NOT EXISTS client_locations (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  client_company_id INTEGER NOT NULL REFERENCES client_companies(id),
  name TEXT NOT NULL,
  address TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Separate login space for client-side people (supervisors / HR). Never
-- joined against agency-role queries in routes/worker.js or
-- routes/manager.js, and never able to authenticate as req.session.user.
CREATE TABLE IF NOT EXISTS client_contacts (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  client_company_id INTEGER NOT NULL REFERENCES client_companies(id),
  role TEXT NOT NULL DEFAULT 'client_supervisor' CHECK (role IN ('client_supervisor','client_hr')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Per-agency configurable "who is the staffing contact right now" rules
-- (spec §16 — after-hours communication). A worker never has to know who
-- is on call — pressing "Contact my staffing agency" resolves through this
-- table. Time-of-day only for MVP (no day-of-week granularity yet) —
-- rows are matched by start_time <= now < end_time, in sort_order.
CREATE TABLE IF NOT EXISTS agency_contact_rules (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  label TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  contact_user_id INTEGER NOT NULL REFERENCES users(id),
  is_emergency_contact BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- The core entity. Knows worker + client company/location/department +
-- shift + who the supervisor and agency contact are. This is what
-- determines "who should receive the communication" for every event
-- below — nobody ever has to look someone up.
CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  client_company_id INTEGER NOT NULL REFERENCES client_companies(id),
  client_location_id INTEGER REFERENCES client_locations(id),
  department TEXT,
  supervisor_contact_id INTEGER REFERENCES client_contacts(id),
  agency_contact_user_id INTEGER REFERENCES users(id),
  shift_date DATE NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN (
    'scheduled','confirmed','on_my_way','running_late','arrived','in_progress',
    'leaving_early_requested','leaving_early_approved','absent',
    'possible_no_show','no_show','shift_complete','cancelled'
  )),
  status_updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMP
);

-- A structured workforce event — NOT a chat message. Every button on the
-- worker's Today's Assignment screen (on my way / running late / can't
-- make it / time issue / workplace issue / emergency / leave early /
-- shift complete) as well as a supervisor's "are you coming?" check-on
-- and any free-text message all create one of these, so the full
-- Communication Record (spec §20) is one query away.
CREATE TABLE IF NOT EXISTS assignment_events (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'on_my_way','running_late','absence','check_in_request','arrived',
    'leaving_early_request','leaving_early_response','time_issue',
    'workplace_issue','emergency','shift_complete','message',
    'no_show_flag','status_update','need_help'
  )),
  severity TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal','urgent','emergency')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new','delivered','viewed','acknowledged','in_progress','resolved','escalated'
  )),
  visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('worker_agency','worker_client','shared','agency_client')),
  summary TEXT NOT NULL,
  details TEXT,
  metadata TEXT,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('worker','client_contact','agency_user','system')),
  created_by_id INTEGER,
  created_by_name TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  escalation_tier INTEGER NOT NULL DEFAULT 0,
  escalated_at TIMESTAMP,
  resolved_at TIMESTAMP
);

-- Who an event was sent to, and when. Lets the worker see "your staffing
-- agency and job supervisor have been notified" as a fact, not a promise.
CREATE TABLE IF NOT EXISTS event_recipients (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES assignment_events(id),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('worker','client_contact','agency_user')),
  recipient_id INTEGER NOT NULL,
  recipient_name TEXT,
  notified_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Delivered -> Viewed -> Acknowledged -> Resolved, per person, per event
-- (spec §17). Multiple rows per event are expected (supervisor views,
-- then agency acknowledges, etc).
CREATE TABLE IF NOT EXISTS event_acknowledgments (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES assignment_events(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('worker','client_contact','agency_user')),
  actor_id INTEGER NOT NULL,
  actor_name TEXT,
  action TEXT NOT NULL CHECK (action IN ('viewed','acknowledged','in_progress','resolved')),
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- In-app notification inbox, shared shape for all three audiences
-- (worker / client_contact / agency_user), differentiated by
-- recipient_type the same way event_recipients is.
-- ════════════════════════════════════════════════════════════════════
-- CROSS-AGENCY CONNECTIONS
-- Lets a client company that's already on Twanova invite a staffing
-- agency that isn't yet, and end up able to see that agency's temps too
-- — without ever duplicating the client contact's login. The
-- client_contacts row stays exactly where it started ("home" agency) —
-- a link row just grants that same login visibility into a client
-- company record living under a DIFFERENT organization. Billing default
-- (per product decision): the agency being invited pays its own
-- subscription like any self-signup — the inviting client is never
-- billed for a connection it didn't originate the paid account for.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS client_contact_org_links (
  id SERIAL PRIMARY KEY,
  client_contact_id INTEGER NOT NULL REFERENCES client_contacts(id),
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  client_company_id INTEGER NOT NULL REFERENCES client_companies(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(client_contact_id, organization_id, client_company_id)
);

-- A client-initiated invite for a staffing agency that isn't on Twanova
-- yet. Created from the client portal, consumed during that agency's
-- self-signup (routes/signup.js GET /confirm). Tokens are single-use —
-- claiming flips status to 'claimed' so the link can't be replayed.
CREATE TABLE IF NOT EXISTS agency_invites (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  inviting_organization_id INTEGER NOT NULL REFERENCES organizations(id),
  inviting_client_company_id INTEGER NOT NULL REFERENCES client_companies(id),
  inviting_client_contact_id INTEGER NOT NULL REFERENCES client_contacts(id),
  agency_name_hint TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','expired')),
  claimed_by_organization_id INTEGER REFERENCES organizations(id),
  claimed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS connected_via_invite_id INTEGER REFERENCES agency_invites(id);
ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS invite_token TEXT;

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('worker','client_contact','agency_user')),
  recipient_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  event_id INTEGER REFERENCES assignment_events(id),
  assignment_id INTEGER REFERENCES assignments(id),
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

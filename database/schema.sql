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
  role TEXT NOT NULL CHECK (role IN ('owner','manager','worker')),
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

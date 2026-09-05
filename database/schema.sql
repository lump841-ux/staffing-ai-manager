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

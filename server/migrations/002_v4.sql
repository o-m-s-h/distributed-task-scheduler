CREATE TABLE IF NOT EXISTS task_schedules (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    priority VARCHAR(20) NOT NULL CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
    interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 60 AND 31536000),
    next_run_at TIMESTAMPTZ NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS task_schedules_due_idx ON task_schedules(next_run_at) WHERE active;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES task_schedules(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS request_hash TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_idx ON tasks(user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_occurrence_idx ON tasks(schedule_id, scheduled_at)
    WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_running_user_idx ON tasks(user_id) WHERE status = 'RUNNING';

-- Shared limits, read while holding this row's lock during every claim.
-- Change values here through SQL; all worker processes observe the same limits.
CREATE TABLE IF NOT EXISTS scheduler_limits (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    global_limit INTEGER NOT NULL CHECK (global_limit > 0),
    per_user_limit INTEGER NOT NULL CHECK (per_user_limit > 0)
);
INSERT INTO scheduler_limits(id, global_limit, per_user_limit)
    VALUES (1, 10, 3) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS api_rate_limits (
    bucket_key TEXT PRIMARY KEY,
    hits INTEGER NOT NULL,
    reset_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS api_rate_limits_expiry_idx ON api_rate_limits(reset_at);

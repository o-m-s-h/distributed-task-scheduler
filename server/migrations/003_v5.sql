CREATE TABLE IF NOT EXISTS workers (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    concurrency INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    queue_connected BOOLEAN NOT NULL DEFAULT FALSE
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worker_id UUID REFERENCES workers(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_ms DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS task_events (
    id BIGSERIAL PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    worker_id UUID,
    duration_ms DOUBLE PRECISION,
    message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id,id DESC);
CREATE INDEX IF NOT EXISTS tasks_user_updated_idx ON tasks(user_id,updated_at DESC);

CREATE OR REPLACE FUNCTION record_task_transition() RETURNS TRIGGER AS $$
DECLARE changed BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        changed := TRUE;
    ELSE
        changed := NEW.status IS DISTINCT FROM OLD.status;
    END IF;
    IF changed THEN
        IF NEW.status = 'RUNNING' THEN
            NEW.started_at := clock_timestamp();
            NEW.finished_at := NULL;
            NEW.execution_ms := NULL;
        ELSIF TG_OP = 'UPDATE' AND OLD.status = 'RUNNING' THEN
            NEW.finished_at := clock_timestamp();
            NEW.execution_ms := CASE WHEN OLD.started_at IS NULL THEN NULL ELSE
                GREATEST(0,EXTRACT(EPOCH FROM (NEW.finished_at-OLD.started_at))*1000) END;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION append_task_event() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO task_events(task_id,status,attempt,message)
        VALUES(NEW.id,NEW.status,NEW.attempts,'Task created');
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO task_events(task_id,status,attempt,worker_id,duration_ms,message)
        VALUES(NEW.id,NEW.status,NEW.attempts,NEW.worker_id,
            CASE WHEN OLD.status='RUNNING' THEN NEW.execution_ms ELSE NULL END,
            CASE WHEN NEW.status IN ('RETRYING','DEAD') THEN COALESCE(NEW.last_error,NEW.status)
                ELSE 'Status changed: ' || OLD.status || ' → ' || NEW.status END);
    ELSIF OLD.cancel_requested_at IS NULL AND NEW.cancel_requested_at IS NOT NULL THEN
        INSERT INTO task_events(task_id,status,attempt,worker_id,message)
        VALUES(NEW.id,NEW.status,NEW.attempts,NEW.worker_id,'Cancellation requested');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS task_transition_timing ON tasks;
CREATE TRIGGER task_transition_timing BEFORE INSERT OR UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION record_task_transition();
DROP TRIGGER IF EXISTS task_transition_history ON tasks;
CREATE TRIGGER task_transition_history AFTER INSERT OR UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION append_task_event();

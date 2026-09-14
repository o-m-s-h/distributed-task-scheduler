import { randomUUID } from "node:crypto";
import { withTransaction } from "./transaction.js";

export const MAX_ATTEMPTS = 3;
export const LEASE_SECONDS = 15;
export const REDISPATCH_SECONDS = 30;

export const createTaskStore = (db, workerId = null) => ({
    async materializeRecurring() {
        return withTransaction(db, async (client) => {
            // Serialize each series with cancellation and other scheduler instances.
            // Coalesce downtime to the latest due occurrence, preserving the anchor.
            const { rows } = await client.query(`SELECT *,
                next_run_at + FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-next_run_at))
                    / interval_seconds) * interval_seconds * INTERVAL '1 second' AS occurrence_at
                FROM task_schedules WHERE active AND next_run_at <= CURRENT_TIMESTAMP
                ORDER BY next_run_at LIMIT 100 FOR UPDATE SKIP LOCKED`);
            for (const schedule of rows) {
                await client.query(`INSERT INTO tasks
                    (id,user_id,name,type,payload,priority,status,scheduled_at,schedule_id)
                    VALUES ($1,$2,$3,$4,$5,$6,'SCHEDULED',$7,$8)
                    ON CONFLICT (schedule_id,scheduled_at) WHERE schedule_id IS NOT NULL DO NOTHING`,
                [randomUUID(), schedule.user_id, schedule.name, schedule.type, schedule.payload,
                    schedule.priority, schedule.occurrence_at, schedule.id]);
                await client.query(`UPDATE task_schedules SET next_run_at=
                    $2::timestamptz + interval_seconds * INTERVAL '1 second' WHERE id=$1`,
                [schedule.id, schedule.occurrence_at]);
            }
            return rows.length;
        });
    },

    async prepareDispatch() {
        const { rows } = await db.query(`
            WITH due AS (
                SELECT id FROM tasks
                WHERE (status = 'SCHEDULED' AND scheduled_at <= CURRENT_TIMESTAMP)
                   OR (status = 'RETRYING' AND next_retry_at <= CURRENT_TIMESTAMP)
                   OR (status = 'QUEUED' AND updated_at <= CURRENT_TIMESTAMP
                       - ($1 * INTERVAL '1 second'))
                ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
                    updated_at ASC
                LIMIT 100 FOR UPDATE SKIP LOCKED
            )
            UPDATE tasks t SET status = 'QUEUED',
                queue_token = CASE WHEN t.status = 'QUEUED'
                    THEN COALESCE(t.queue_token, $2::uuid) ELSE $2::uuid END,
                updated_at = CURRENT_TIMESTAMP
            FROM due WHERE t.id = due.id
            RETURNING t.id, t.queue_token, t.priority`, [REDISPATCH_SECONDS, randomUUID()]);
        return rows;
    },

    async claim(message) {
        return withTransaction(db, async (client) => {
            // A shared lock makes count-and-claim atomic across all processes.
            const limits = (await client.query("SELECT * FROM scheduler_limits WHERE id=1 FOR UPDATE")).rows[0];
            if (!limits) throw new Error("Concurrency limits missing; run migrations");
            const candidate = (await client.query(`SELECT * FROM tasks
                WHERE id=$1 AND queue_token=$2 AND status='QUEUED'
                    AND attempts < $3 AND cancel_requested_at IS NULL FOR UPDATE`,
            [message.id, message.queueToken, MAX_ATTEMPTS])).rows[0];
            if (!candidate) return undefined;
            const count = (await client.query(`SELECT COUNT(*)::integer AS total,
                COUNT(*) FILTER (WHERE user_id=$1)::integer AS owned
                FROM tasks WHERE status='RUNNING'`, [candidate.user_id])).rows[0];
            if (count.total >= limits.global_limit || count.owned >= limits.per_user_limit) {
                // The durable QUEUED row is redispatched when its timeout elapses.
                return undefined;
            }
            const { rows } = await client.query(`UPDATE tasks SET status='RUNNING',
                attempts=attempts+1, lease_token=$2, worker_id=$4,
                lease_until=CURRENT_TIMESTAMP + $3 * INTERVAL '1 second',
                next_retry_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`,
            [candidate.id, randomUUID(), LEASE_SECONDS, workerId]);
            return rows[0];
        });
    },

    async heartbeat(task) {
        const result = await db.query(`
            UPDATE tasks SET lease_until = CURRENT_TIMESTAMP
                + ($3 * INTERVAL '1 second'), updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'
                AND cancel_requested_at IS NULL
                AND lease_until > CURRENT_TIMESTAMP`, [task.id, task.lease_token, LEASE_SECONDS]);
        return result.rowCount > 0;
    },

    async complete(task, output) {
        const result = await db.query(`
            UPDATE tasks SET status = 'COMPLETED', result = $3::jsonb,
                lease_token = NULL, lease_until = NULL, last_error = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'
                AND cancel_requested_at IS NULL
                AND lease_until > CURRENT_TIMESTAMP`, [task.id, task.lease_token, JSON.stringify(output)]);
        return result.rowCount > 0;
    },

    async fail(task, error) {
        const result = await db.query(`
            UPDATE tasks SET
                status = CASE WHEN attempts >= $3 THEN 'DEAD' ELSE 'RETRYING' END,
                next_retry_at = CASE WHEN attempts >= $3 THEN NULL ELSE
                    CURRENT_TIMESTAMP + (5 * POWER(2, LEAST(attempts, $3))) * INTERVAL '1 second' END,
                lease_token = NULL, lease_until = NULL, last_error = $4,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'
                AND cancel_requested_at IS NULL
                AND lease_until > CURRENT_TIMESTAMP`,
        [task.id, task.lease_token, MAX_ATTEMPTS, error.message]);
        return result.rowCount > 0;
    },

    async acknowledgeCancellation(task) {
        const result = await db.query(`UPDATE tasks SET status='CANCELLED',
            lease_token=NULL, lease_until=NULL, next_retry_at=NULL, updated_at=CURRENT_TIMESTAMP
            WHERE id=$1 AND lease_token=$2 AND status='RUNNING' AND cancel_requested_at IS NOT NULL`,
        [task.id, task.lease_token]);
        return result.rowCount > 0;
    },

    async recoverExpired() {
        const { rows } = await db.query(`
            UPDATE tasks SET
                status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'CANCELLED'
                    WHEN attempts >= $1 THEN 'DEAD' ELSE 'RETRYING' END,
                next_retry_at = CASE WHEN cancel_requested_at IS NOT NULL OR attempts >= $1 THEN NULL ELSE
                    CURRENT_TIMESTAMP + (5 * POWER(2, LEAST(attempts, $1))) * INTERVAL '1 second' END,
                lease_token = NULL, lease_until = NULL,
                last_error = CASE WHEN status = 'RUNNING' THEN 'Worker lease expired'
                    ELSE 'Maximum attempts exhausted' END,
                updated_at = CURRENT_TIMESTAMP
            WHERE (status = 'RUNNING'
                AND (lease_until <= CURRENT_TIMESTAMP OR lease_until IS NULL))
                OR (status IN ('QUEUED', 'RETRYING') AND attempts >= $1)
            RETURNING id, status`, [MAX_ATTEMPTS]);
        return rows;
    }
});

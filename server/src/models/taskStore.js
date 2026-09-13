import { randomUUID } from "node:crypto";

export const MAX_ATTEMPTS = 3;
export const LEASE_SECONDS = 15;
export const REDISPATCH_SECONDS = 30;

export const createTaskStore = (db) => ({
    async prepareDispatch() {
        const { rows } = await db.query(`
            WITH due AS (
                SELECT id FROM tasks
                WHERE (status = 'SCHEDULED' AND scheduled_at <= CURRENT_TIMESTAMP)
                   OR (status = 'RETRYING' AND next_retry_at <= CURRENT_TIMESTAMP)
                   OR (status = 'QUEUED' AND updated_at <= CURRENT_TIMESTAMP
                       - ($1 * INTERVAL '1 second'))
                ORDER BY updated_at ASC
                LIMIT 100 FOR UPDATE SKIP LOCKED
            )
            UPDATE tasks t SET status = 'QUEUED',
                queue_token = CASE WHEN t.status = 'QUEUED'
                    THEN COALESCE(t.queue_token, $2::uuid) ELSE $2::uuid END,
                updated_at = CURRENT_TIMESTAMP
            FROM due WHERE t.id = due.id
            RETURNING t.id, t.queue_token`, [REDISPATCH_SECONDS, randomUUID()]);
        return rows;
    },

    async claim(message) {
        const { rows } = await db.query(`
            UPDATE tasks SET status = 'RUNNING', attempts = attempts + 1,
                lease_token = $3, lease_until = CURRENT_TIMESTAMP
                    + ($4 * INTERVAL '1 second'),
                next_retry_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND queue_token = $2 AND status = 'QUEUED'
                AND attempts < $5
            RETURNING *`, [message.id, message.queueToken, randomUUID(), LEASE_SECONDS, MAX_ATTEMPTS]);
        return rows[0];
    },

    async heartbeat(task) {
        const result = await db.query(`
            UPDATE tasks SET lease_until = CURRENT_TIMESTAMP
                + ($3 * INTERVAL '1 second'), updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'
                AND lease_until > CURRENT_TIMESTAMP`, [task.id, task.lease_token, LEASE_SECONDS]);
        return result.rowCount > 0;
    },

    async complete(task, output) {
        const result = await db.query(`
            UPDATE tasks SET status = 'COMPLETED', result = $3::jsonb,
                lease_token = NULL, lease_until = NULL, last_error = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'
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
                AND lease_until > CURRENT_TIMESTAMP`,
        [task.id, task.lease_token, MAX_ATTEMPTS, error.message]);
        return result.rowCount > 0;
    },

    async recoverExpired() {
        const { rows } = await db.query(`
            UPDATE tasks SET
                status = CASE WHEN attempts >= $1 THEN 'DEAD' ELSE 'RETRYING' END,
                next_retry_at = CASE WHEN attempts >= $1 THEN NULL ELSE
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

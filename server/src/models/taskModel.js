import pool from "../config/db.js";
import { withTransaction } from "./transaction.js";

export const createTask = (task, database = pool) => withTransaction(database, async (db) => {
    if (task.idempotencyKey) {
        // Serialize requests for the same user's key, including series creation.
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`task-create:${task.userId}:${task.idempotencyKey}`]);
        const existing = await db.query("SELECT * FROM tasks WHERE user_id=$1 AND idempotency_key=$2",
            [task.userId, task.idempotencyKey]);
        if (existing.rows[0]) {
            if (existing.rows[0].request_hash !== task.requestHash) {
                const error = new Error("Idempotency-Key was already used with a different request");
                error.status = 409;
                throw error;
            }
            return { task: existing.rows[0], replayed: true };
        }
    }
    const scheduleId = task.recurrence ? task.id : null;
    if (scheduleId) {
        await db.query(`INSERT INTO task_schedules
            (id,user_id,name,type,payload,priority,interval_seconds,next_run_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7::integer,$8::timestamptz + $7::integer * INTERVAL '1 second')`,
        [scheduleId, task.userId, task.name, task.type, task.payload, task.priority,
            task.recurrence.intervalSeconds, task.scheduledAt]);
    }
    const { rows } = await db.query(`INSERT INTO tasks
        (id,user_id,name,type,payload,priority,status,scheduled_at,schedule_id,idempotency_key,request_hash)
        VALUES ($1,$2,$3,$4,$5,$6,'SCHEDULED',$7,$8,$9,$10) RETURNING *`,
    [task.id, task.userId, task.name, task.type, task.payload, task.priority,
        task.scheduledAt, scheduleId, task.idempotencyKey, task.requestHash]);
    return { task: rows[0], replayed: false };
});

export const cancelTask = (id, userId, scope, database = pool) => withTransaction(database, async (db) => {
    // Lock the series before occurrences, matching the materializer's lock order.
    const found = await db.query("SELECT * FROM tasks WHERE id=$1 AND user_id=$2", [id, userId]);
    if (!found.rows[0]) return null;
    const scheduleId = found.rows[0].schedule_id;
    if (scope === "SERIES") {
        if (!scheduleId) {
            const error = new Error("This task does not belong to a recurring series");
            error.status = 400;
            throw error;
        }
        await db.query("UPDATE task_schedules SET active=FALSE WHERE id=$1 AND user_id=$2", [scheduleId, userId]);
    }
    await db.query(`UPDATE tasks SET cancel_requested_at=COALESCE(cancel_requested_at,CURRENT_TIMESTAMP),
        status=CASE WHEN status='RUNNING' THEN 'RUNNING' ELSE 'CANCELLED' END,
        next_retry_at=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE user_id=$2 AND ${scope === "SERIES" ? "schedule_id=$1" : "id=$1"}
            AND status IN ('SCHEDULED','QUEUED','RETRYING','RUNNING')`,
    [scope === "SERIES" ? scheduleId : id, userId]);
    const { rows } = await db.query("SELECT * FROM tasks WHERE id=$1 AND user_id=$2", [id, userId]);
    return { task: rows[0], seriesCancelled: scope === "SERIES" };
});


export const getTasksByUser = async (userId) => {
    const result = await pool.query(
        `SELECT t.*, CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object(
             'intervalSeconds',s.interval_seconds,'active',s.active,'nextRunAt',s.next_run_at)
             END AS recurrence
         FROM tasks t LEFT JOIN task_schedules s ON s.id=t.schedule_id
         WHERE t.user_id = $1
         ORDER BY t.scheduled_at ASC`,
        [userId]
    );

    return result.rows;
};


export const getTaskById = async (taskId, userId) => {
    const result = await pool.query(
        `SELECT t.*, CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object(
             'intervalSeconds',s.interval_seconds,'active',s.active,'nextRunAt',s.next_run_at)
             END AS recurrence
         FROM tasks t LEFT JOIN task_schedules s ON s.id=t.schedule_id
         WHERE t.id = $1 AND t.user_id = $2`,
        [taskId, userId]
    );

    return result.rows[0];
};

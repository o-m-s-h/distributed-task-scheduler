import pool from "../config/db.js";
import redis from "../config/redis.js";

const checkForTasks = async () => {
    try {
        const result = await pool.query(
            `SELECT *
             FROM tasks
             WHERE status = 'SCHEDULED'
             AND scheduled_at <= CURRENT_TIMESTAMP
             ORDER BY scheduled_at ASC
             LIMIT 1`
        );

        if (result.rows.length === 0) {
            return;
        }

        const task = result.rows[0];

        // Claim the task
        const updateResult = await pool.query(
            `UPDATE tasks
             SET status = 'QUEUED',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             AND status = 'SCHEDULED'
             RETURNING *`,
            [task.id]
        );

        // Another process may have already claimed it
        if (updateResult.rows.length === 0) {
            return;
        }

        const queuedTask = updateResult.rows[0];

        await redis.rpush(
            "task_queue",
            JSON.stringify(queuedTask)
        );

        console.log(`Task queued: ${queuedTask.name}`);

    } catch (error) {
        console.error("Scheduler error:", error);
    }
};

export const startScheduler = () => {
    console.log("Scheduler started");

    checkForTasks();

    setInterval(checkForTasks, 5000);
};
import pool from "../config/db.js";
import { processTask } from "../worker/worker.js";

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

        console.log(`Task found: ${task.name}`);

        await processTask(task);

    } catch (error) {
        console.error("Scheduler error:", error);
    }
};


export const startScheduler = () => {
    console.log("Scheduler started");

    checkForTasks();

    setInterval(checkForTasks, 5000);
};
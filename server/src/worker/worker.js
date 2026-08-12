import pool from "../config/db.js";
import redis from "../config/redis.js";

const executeTask = async (task) => {
    console.log(`Executing task: ${task.name}`);

    // Simulate work
    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log(`Finished work for: ${task.name}`);
};


const processTask = async (task) => {
    try {
        await pool.query(
            `UPDATE tasks
             SET status = 'RUNNING',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             AND status = 'QUEUED'`,
            [task.id]
        );

        console.log(
            `Task ${task.id} is now RUNNING`
        );

        await executeTask(task);

        await pool.query(
            `UPDATE tasks
             SET status = 'COMPLETED',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [task.id]
        );

        console.log(
            `Task ${task.id} is COMPLETED`
        );

    } catch (error) {
        console.error(
            `Task ${task.id} failed:`,
            error
        );

        await pool.query(
            `UPDATE tasks
             SET status = 'FAILED',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [task.id]
        );
    }
};


const startWorker = async () => {
    console.log("Worker started");

    while (true) {
        try {
            const result = await redis.blpop(
                "task_queue",
                0
            );

            const task = JSON.parse(result[1]);

            console.log(
                `Worker received task: ${task.name}`
            );

            await processTask(task);

        } catch (error) {
            console.error("Worker error:", error);
        }
    }
};

startWorker();
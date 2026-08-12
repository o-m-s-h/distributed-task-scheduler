import pool from "../config/db.js";

const executeTask = async (task) => {
    console.log(`Executing task: ${task.name}`);

    // Simulate some work
    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log(`Task completed: ${task.name}`);
};


export const processTask = async (task) => {
    try {
        // Mark task as RUNNING
        await pool.query(
            `UPDATE tasks
             SET status = 'RUNNING',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [task.id]
        );

        console.log(`Task ${task.id} is now RUNNING`);

        // Execute the actual task
        await executeTask(task);

        // Mark task as COMPLETED
        await pool.query(
            `UPDATE tasks
             SET status = 'COMPLETED',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [task.id]
        );

        console.log(`Task ${task.id} is COMPLETED`);

    } catch (error) {
        console.error(`Task ${task.id} failed:`, error);

        await pool.query(
            `UPDATE tasks
             SET status = 'FAILED',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [task.id]
        );
    }
};
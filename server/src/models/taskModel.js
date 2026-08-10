import pool from "../config/db.js";

export const createTask = async (task) => {
    const {
        id,
        userId,
        name,
        type,
        payload,
        priority,
        scheduledAt
    } = task;

    const result = await pool.query(
        `INSERT INTO tasks
        (id, user_id, name, type, payload, priority, status, scheduled_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'SCHEDULED', $7)
        RETURNING *`,
        [
            id,
            userId,
            name,
            type,
            payload,
            priority,
            scheduledAt
        ]
    );

    return result.rows[0];
};


export const getTasksByUser = async (userId) => {
    const result = await pool.query(
        `SELECT *
         FROM tasks
         WHERE user_id = $1
         ORDER BY scheduled_at ASC`,
        [userId]
    );

    return result.rows;
};


export const getTaskById = async (taskId, userId) => {
    const result = await pool.query(
        `SELECT *
         FROM tasks
         WHERE id = $1 AND user_id = $2`,
        [taskId, userId]
    );

    return result.rows[0];
};
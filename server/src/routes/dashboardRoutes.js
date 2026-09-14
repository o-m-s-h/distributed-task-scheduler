import express from "express";
import pool from "../config/db.js";
import redis from "../config/redis.js";
import { QUEUE_KEYS } from "../config/queue.js";
import { protect } from "../middleware/authMiddleware.js";
import { taskRateLimit } from "../middleware/rateLimit.js";

const router = express.Router();
router.use(protect, taskRateLimit);
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

router.get("/", async (req, res) => {
    const page = Number(req.query.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 100000) {
        return res.status(400).json({ message: "Invalid page" });
    }
    try {
        const [counts, timings, tasks, events, workers, queues] = await Promise.all([
            pool.query(`SELECT
                COUNT(*)::integer AS total,
                COUNT(*) FILTER(WHERE status IN ('SCHEDULED','QUEUED'))::integer AS pending,
                COUNT(*) FILTER(WHERE status='QUEUED')::integer AS queued,
                COUNT(*) FILTER(WHERE status='RUNNING')::integer AS running,
                COUNT(*) FILTER(WHERE status='COMPLETED')::integer AS completed,
                COUNT(*) FILTER(WHERE status='DEAD')::integer AS failed,
                COUNT(*) FILTER(WHERE status='RETRYING')::integer AS retrying,
                COUNT(*) FILTER(WHERE status='CANCELLED')::integer AS cancelled,
                COALESCE(SUM(GREATEST(attempts-1,0)),0)::integer AS retries
                FROM tasks WHERE user_id=$1`, [req.userId]),
            pool.query(`SELECT AVG(e.duration_ms) AS average_ms,
                COUNT(*)::integer AS measured_attempts FROM task_events e
                JOIN tasks t ON t.id=e.task_id WHERE t.user_id=$1 AND e.duration_ms IS NOT NULL`, [req.userId]),
            pool.query(`SELECT id,name,type,priority,status,scheduled_at,attempts,
                schedule_id,cancel_requested_at,execution_ms,updated_at
                FROM tasks WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $2`,
            [req.userId, (page - 1) * 25]),
            pool.query(`SELECT e.id,e.task_id,t.name,e.occurred_at,e.status,e.attempt,e.message,e.duration_ms
                FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.user_id=$1
                ORDER BY e.id DESC LIMIT 50`, [req.userId]),
            // Shared infrastructure metadata only; no other users' task identifiers.
            pool.query(`SELECT w.id,w.name,w.concurrency,w.started_at,w.last_seen_at,
                CASE WHEN w.last_seen_at < CURRENT_TIMESTAMP-INTERVAL '20 seconds' THEN 'OFFLINE'
                    WHEN NOT w.queue_connected THEN 'DEGRADED' ELSE 'ONLINE' END AS health,
                (SELECT COUNT(*)::integer FROM tasks t WHERE t.worker_id=w.id
                    AND t.user_id=$1 AND t.status='RUNNING') AS your_running
                FROM workers w ORDER BY w.last_seen_at DESC LIMIT 100`, [req.userId]),
            Promise.all(QUEUE_KEYS.map(async (key) => ({ key, depth: await redis.llen(key) })))
                .then((lists) => ({ available: true, lists, total: lists.reduce((sum, list) => sum+list.depth, 0) }))
                .catch(() => ({ available: false, lists: [], total: null }))
        ]);
        const metrics = counts.rows[0];
        const terminal = metrics.completed + metrics.failed;
        res.json({ updatedAt: new Date().toISOString(), metrics: { ...metrics,
            successRate: terminal ? 100 * metrics.completed / terminal : null,
            failureRate: terminal ? 100 * metrics.failed / terminal : null,
            averageDurationMs: timings.rows[0].average_ms,
            measuredAttempts: timings.rows[0].measured_attempts },
        tasks: tasks.rows, page, pageSize: 25, events: events.rows,
        workers: workers.rows, queue: queues });
    } catch (error) {
        console.error("Dashboard error:", error.message);
        res.status(503).json({ message: "Dashboard temporarily unavailable" });
    }
});

router.get("/tasks/:id", async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
        return res.status(400).json({ message: "Invalid task ID" });
    }
    try {
        const task = await pool.query(`SELECT id,name,type,payload,priority,status,attempts,
            result,last_error,scheduled_at,started_at,finished_at,execution_ms,schedule_id,
            cancel_requested_at FROM tasks WHERE id=$1 AND user_id=$2`, [req.params.id, req.userId]);
        if (!task.rows[0]) return res.status(404).json({ message: "Task not found" });
        const history = await pool.query(`SELECT id,occurred_at,status,attempt,duration_ms,message,worker_id
            FROM task_events WHERE task_id=$1 ORDER BY id DESC LIMIT 100`, [req.params.id]);
        res.json({ task: task.rows[0], history: history.rows });
    } catch (error) {
        console.error("Task history error:", error.message);
        res.status(503).json({ message: "Task history temporarily unavailable" });
    }
});

export default router;

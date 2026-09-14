import pool from "../config/db.js";
import { positiveInteger } from "../config/settings.js";

const windowSeconds = positiveInteger("RATE_LIMIT_WINDOW_SECONDS", 60, 86400);

const limit = (namespace, maximum, identify) => async (req, res, next) => {
    try {
        // PostgreSQL makes this limit shared by all API instances. No in-memory
        // counters and no reliance on Redis being online to accept a task.
        const { rows } = await pool.query(`INSERT INTO api_rate_limits(bucket_key,hits,reset_at)
            VALUES ($1,1,CURRENT_TIMESTAMP + $2 * INTERVAL '1 second')
            ON CONFLICT (bucket_key) DO UPDATE SET
                hits=CASE WHEN api_rate_limits.reset_at <= CURRENT_TIMESTAMP
                    THEN 1 ELSE api_rate_limits.hits+1 END,
                reset_at=CASE WHEN api_rate_limits.reset_at <= CURRENT_TIMESTAMP
                    THEN CURRENT_TIMESTAMP + $2 * INTERVAL '1 second' ELSE api_rate_limits.reset_at END
            WHERE api_rate_limits.reset_at <= CURRENT_TIMESTAMP OR api_rate_limits.hits < $3
            RETURNING hits, reset_at`, [`${namespace}:${identify(req)}`, windowSeconds, maximum]);
        res.set("X-RateLimit-Limit", String(maximum));
        if (!rows[0]) {
            res.set("X-RateLimit-Remaining", "0");
            res.set("Retry-After", String(windowSeconds));
            return res.status(429).json({ message: "Too many requests; retry later" });
        }
        res.set("X-RateLimit-Remaining", String(maximum - rows[0].hits));
        res.set("X-RateLimit-Reset", String(Math.ceil(new Date(rows[0].reset_at).getTime() / 1000)));
        next();
    } catch (error) {
        console.error("Rate limiter error:", error.message);
        return res.status(503).json({ message: "Request limiting is temporarily unavailable" });
    }
};

export const authRateLimit = limit("auth", positiveInteger("AUTH_RATE_LIMIT", 20), (req) => req.ip);
export const taskRateLimit = limit("tasks", positiveInteger("TASK_RATE_LIMIT", 120), (req) => req.userId);

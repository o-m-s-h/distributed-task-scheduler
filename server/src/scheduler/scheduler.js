import pool from "../config/db.js";
import redis from "../config/redis.js";
import { createTaskStore } from "../models/taskStore.js";
import { dispatchTasks } from "./dispatch.js";

const store = createTaskStore(pool);

export const startScheduler = () => {
    console.log("Scheduler started");
    // Wait for completion before scheduling again to prevent overlapping ticks.
    const tick = async () => {
        try {
            await store.recoverExpired();
            await store.materializeRecurring();
            await dispatchTasks(store, redis);
            await pool.query("DELETE FROM api_rate_limits WHERE reset_at < CURRENT_TIMESTAMP");
        } catch (error) {
            console.error("Scheduler error:", error.message);
        } finally {
            setTimeout(tick, 5000);
        }
    };
    void tick();
};

import { setTimeout as sleep } from "node:timers/promises";
import pool from "../config/db.js";
import redis from "../config/redis.js";
import { createTaskStore } from "../models/taskStore.js";
import { processTask } from "./processTask.js";
import { QUEUE_KEYS } from "../config/queue.js";
import { positiveInteger } from "../config/settings.js";
import { randomUUID } from "node:crypto";

const workerId = randomUUID();
const store = createTaskStore(pool, workerId);
const concurrency = positiveInteger("WORKER_CONCURRENCY", 1, 100);
const workerName = (process.env.WORKER_NAME || `Worker ${workerId.slice(0, 8)}`).slice(0, 100);
const connections = [];
const reportHealth = async () => {
    await pool.query(`INSERT INTO workers(id,name,concurrency,queue_connected)
        VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE
        SET last_seen_at=CURRENT_TIMESTAMP,queue_connected=EXCLUDED.queue_connected`,
    [workerId, workerName, concurrency,
        connections.length === concurrency && connections.every((connection) => connection.status === "ready")]);
};
// Register before claiming so task ownership always references a known worker.
await reportHealth();
const healthLoop = async () => {
    try { await reportHealth(); }
    catch (error) { console.error("Worker health error:", error.message); }
    finally { setTimeout(healthLoop, 5000); }
};
setTimeout(healthLoop, 5000);
console.log(`Worker started (PID ${process.pid}, concurrency ${concurrency})`);

const runSlot = async () => {
    // Each blocking pop needs a separate connection; sharing one serializes slots.
    const queue = redis.duplicate();
    connections.push(queue);
    queue.on("error", (error) => console.error("Worker queue error:", error.message));
    while (true) {
        try {
            const item = await queue.blpop(...QUEUE_KEYS, 5);
            if (!item) continue;
            const message = JSON.parse(item[1]);
            // Legacy messages are harmless; queued rows get fresh scheduler messages.
            if (!message.id || !message.queueToken) continue;
            await processTask(store, message);
        } catch (error) {
            console.error("Worker error:", error.message);
            await sleep(1000);
        }
    }
};

await Promise.all(Array.from({ length: concurrency }, runSlot));

import { setTimeout as sleep } from "node:timers/promises";
import pool from "../config/db.js";
import redis from "../config/redis.js";
import { createTaskStore } from "../models/taskStore.js";
import { processTask } from "./processTask.js";

const store = createTaskStore(pool);
console.log(`Worker started (PID ${process.pid})`);

while (true) {
    try {
        const item = await redis.blpop("task_queue", 5);
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

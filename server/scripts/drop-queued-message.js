import Redis from "ioredis";
import "dotenv/config";
import { QUEUE_KEYS } from "../src/config/queue.js";

// Manual failure injection: remove only the explicitly selected task's messages.
// Stop workers first. PostgreSQL remains QUEUED, as after a dequeue/claim crash.
const taskId = process.argv[2];
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId || "")) {
    console.error("Usage: node scripts/drop-queued-message.js <task UUID>");
    process.exitCode = 1;
} else {
    const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
        lazyConnect: true, retryStrategy: () => null, connectTimeout: 3000, commandTimeout: 5000
    });
    redis.on("error", () => {});
    try {
        await redis.connect();
        let removed = 0;
        for (const queue of QUEUE_KEYS) {
            for (const body of await redis.lrange(queue, 0, -1)) {
                let message;
                try { message = JSON.parse(body); } catch { continue; }
                if (message.id === taskId) removed += await redis.lrem(queue, 0, body);
            }
        }
        console.log(`Removed ${removed} queue message(s) for ${taskId}. Restart workers; redispatch takes up to about 35 seconds.`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    } finally {
        redis.disconnect();
    }
}

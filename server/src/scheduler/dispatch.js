import { PRIORITIES, queueKey } from "../config/queue.js";

export const dispatchTasks = async (store, redis) => {
    const tasks = await store.prepareDispatch();
    tasks.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
    for (const task of tasks) {
        // PostgreSQL retains QUEUED rows until claimed. Failed pushes, lost Redis
        // data, and crashes after BLPOP are repaired by periodic redispatch.
        await redis.rpush(queueKey(task.priority), JSON.stringify({
            id: task.id,
            queueToken: task.queue_token
        }));
        console.log(`Task queued: ${task.id}`);
    }
};

export const dispatchTasks = async (store, redis) => {
    const tasks = await store.prepareDispatch();
    for (const task of tasks) {
        // PostgreSQL retains QUEUED rows until claimed. Failed pushes, lost Redis
        // data, and crashes after BLPOP are repaired by periodic redispatch.
        await redis.rpush("task_queue", JSON.stringify({
            id: task.id,
            queueToken: task.queue_token
        }));
        console.log(`Task queued: ${task.id}`);
    }
};

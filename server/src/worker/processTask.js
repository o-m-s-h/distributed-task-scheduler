import { executeTask } from "./taskHandlers.js";

export const processTask = async (store, message, execute = executeTask, heartbeatMs = 5000) => {
    const task = await store.claim(message);
    if (!task) return;
    console.log(`Worker ${process.pid} claimed ${task.id}, attempt ${task.attempts}`);
    const controller = new AbortController();
    let stopped = false;
    let timer;
    let pendingHeartbeat = Promise.resolve();

    const scheduleHeartbeat = () => {
        timer = setTimeout(() => {
            pendingHeartbeat = (async () => {
                try {
                    if (!await store.heartbeat(task)) {
                        controller.abort(new Error("Task lease lost"));
                    }
                } catch (error) {
                    // Stop work conservatively; the scheduler recovers its lease.
                    controller.abort(error);
                }
                if (!stopped && !controller.signal.aborted) scheduleHeartbeat();
            })();
        }, heartbeatMs);
    };

    scheduleHeartbeat();
    try {
        const output = await execute(task, controller.signal);
        if (!controller.signal.aborted && await store.complete(task, output)) {
            console.log(`Task ${task.id} COMPLETED`);
        }
    } catch (error) {
        if (!controller.signal.aborted) {
            if (await store.fail(task, error)) {
                console.error(`Task ${task.id} failed: ${error.message}`);
            }
        }
    } finally {
        stopped = true;
        clearTimeout(timer);
        await pendingHeartbeat;
    }
};

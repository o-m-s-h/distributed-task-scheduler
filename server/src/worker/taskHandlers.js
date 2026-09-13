import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export const validateTask = (type, payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("payload must be an object");
    }
    if (payload.delayMs !== undefined && (!Number.isInteger(payload.delayMs)
        || payload.delayMs < 0 || payload.delayMs > 60000)) {
        throw new Error("delayMs must be an integer between 0 and 60000");
    }
    switch (type) {
        case "SUM":
            if (!Array.isArray(payload.numbers) || !payload.numbers.length
                || !payload.numbers.every(Number.isFinite)) {
                throw new Error("SUM requires a nonempty array of finite numbers");
            }
            break;
        case "SHA256":
            if (typeof payload.text !== "string") throw new Error("SHA256 requires text");
            break;
        default:
            throw new Error("Unsupported task type. Use SUM or SHA256");
    }
};

export const executeTask = async (task, signal) => {
    validateTask(task.type, task.payload);
    signal?.throwIfAborted();
    if (task.payload.delayMs) await sleep(task.payload.delayMs, undefined, { signal });
    signal?.throwIfAborted();
    if (task.type === "SUM") {
        const sum = task.payload.numbers.reduce((total, value) => total + value, 0);
        if (!Number.isFinite(sum)) throw new Error("SUM result exceeds numeric range");
        return { sum };
    }
    return { sha256: createHash("sha256").update(task.payload.text).digest("hex") };
};

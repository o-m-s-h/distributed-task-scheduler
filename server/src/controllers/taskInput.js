import { createHash } from "node:crypto";
import { validateTask } from "../worker/taskHandlers.js";
import { PRIORITIES } from "../config/queue.js";

const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
};

export const parseTaskInput = (body = {}, key) => {
    const { name, type, payload = {}, priority = "MEDIUM", scheduledAt, recurrence = null } = body;
    if (typeof name !== "string" || !name.trim() || name.length > 255) {
        throw new Error("name must contain 1–255 characters");
    }
    validateTask(type, payload);
    if (!PRIORITIES.includes(priority)) throw new Error("priority must be HIGH, MEDIUM, or LOW");
    if (typeof scheduledAt !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(scheduledAt)
        || !Number.isFinite(Date.parse(scheduledAt))) {
        throw new Error("scheduledAt must be an ISO date-time with Z or a timezone offset");
    }
    if (recurrence !== null && (typeof recurrence !== "object" || Array.isArray(recurrence)
        || !Number.isInteger(recurrence.intervalSeconds) || recurrence.intervalSeconds < 60
        || recurrence.intervalSeconds > 31536000
        || Object.keys(recurrence).some((field) => field !== "intervalSeconds"))) {
        throw new Error("recurrence must contain intervalSeconds between 60 and 31536000");
    }
    if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 200)) {
        throw new Error("Idempotency-Key must contain 1–200 characters");
    }
    const normalized = { name: name.trim(), type, payload, priority,
        scheduledAt: new Date(scheduledAt).toISOString(), recurrence };
    return { ...normalized, idempotencyKey: key ?? null,
        requestHash: createHash("sha256").update(canonical(normalized)).digest("hex") };
};

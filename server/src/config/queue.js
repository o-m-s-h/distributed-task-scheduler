export const PRIORITIES = ["HIGH", "MEDIUM", "LOW"];
export const queueKey = (priority) => `task_queue:${PRIORITIES.includes(priority) ? priority : "MEDIUM"}`;
// The legacy list is drained last while pre-V4 messages transition to new lists.
export const QUEUE_KEYS = [...PRIORITIES.map(queueKey), "task_queue"];

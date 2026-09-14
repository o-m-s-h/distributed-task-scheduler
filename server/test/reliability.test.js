import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import "dotenv/config";
import { createTaskStore } from "../src/models/taskStore.js";
import { dispatchTasks } from "../src/scheduler/dispatch.js";
import { executeTask } from "../src/worker/taskHandlers.js";
import { createTask, cancelTask } from "../src/models/taskModel.js";
import { parseTaskInput } from "../src/controllers/taskInput.js";

let db, store, cleanup;
const userId = randomUUID();
before(async () => {
    const schemaSql = (await Promise.all(["001_v3.sql", "002_v4.sql", "003_v5.sql"].map((name) =>
        readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")))).join("\n");
    if (process.env.TEST_POSTGRES === "1") {
        const config = { user: process.env.DB_USER, host: process.env.DB_HOST,
            database: process.env.DB_NAME, password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT, connectionTimeoutMillis: 3000 };
        const admin = new pg.Pool(config);
        const schema = `v3_test_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE SCHEMA ${schema}`);
        db = new pg.Pool({ ...config, options: `-c search_path=${schema}` });
        cleanup = async () => {
            await db.end();
            // Only the isolated schema created above is removed.
            await admin.query(`DROP SCHEMA ${schema} CASCADE`);
            await admin.end();
        };
        await db.query(schemaSql);
        await db.query(schemaSql); // The migration is safe to rerun.
    } else {
        const engine = new PGlite();
        const adapter = (connection) => ({ query: async (sql, params) => {
            const result = await connection.query(sql, params);
            return { ...result, rowCount: result.affectedRows };
        } });
        db = { ...adapter(engine), transaction: (work) =>
            engine.transaction((transaction) => work(adapter(transaction))) };
        cleanup = () => engine.close();
        await engine.exec(schemaSql);
        await engine.exec(schemaSql);
    }
    store = createTaskStore(db);
    await db.query("INSERT INTO users(id,name,email,password) VALUES ($1,'Test','v3@example.test','unused')", [userId]);
});
after(async () => { await cleanup?.(); });
beforeEach(async () => {
    await db.query("DELETE FROM tasks");
    await db.query("DELETE FROM task_schedules");
    await db.query("UPDATE scheduler_limits SET global_limit=10,per_user_limit=3 WHERE id=1");
});

const insertTask = async () => {
    const id = randomUUID();
    await db.query(`INSERT INTO tasks(id,user_id,name,type,payload,scheduled_at)
        VALUES ($1,$2,'Sum','SUM','{"numbers":[1,2,3]}',CURRENT_TIMESTAMP)`, [id, userId]);
    return id;
};
const readTask = async (id) => (await db.query("SELECT * FROM tasks WHERE id=$1", [id])).rows[0];
const dispatch = async () => {
    const messages = [];
    await dispatchTasks(store, { rpush: async (_key, body) => messages.push(JSON.parse(body)) });
    return messages;
};
const expireLease = (id) => db.query("UPDATE tasks SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1", [id]);
const makeRetryDue = (id) => db.query("UPDATE tasks SET next_retry_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1", [id]);
const makeRedispatchDue = (id) => db.query("UPDATE tasks SET updated_at=CURRENT_TIMESTAMP-INTERVAL '31 seconds' WHERE id=$1", [id]);

test("a failed Redis push is repaired without spending an execution attempt", async () => {
    const id = await insertTask();
    await assert.rejects(dispatchTasks(store, { rpush: async () => { throw new Error("Redis offline"); } }));
    assert.equal((await readTask(id)).status, "QUEUED");
    await makeRedispatchDue(id);
    const [message] = await dispatch();
    const task = await store.claim(message);
    assert.equal(task.attempts, 1);
    assert.equal(await store.complete(task, await executeTask(task)), true);
    assert.deepEqual((await readTask(id)).result, { sum: 6 });
});

test("a message removed before claim is redispatched; duplicate claims have one winner", async () => {
    const id = await insertTask();
    const [lost] = await dispatch();
    await makeRedispatchDue(id);
    const [resent] = await dispatch();
    assert.deepEqual(resent, lost);
    const results = await Promise.all([store.claim(lost), store.claim(resent)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await readTask(id)).attempts, 1);
});

test("expired and superseded workers cannot renew, complete, or fail another attempt", async () => {
    const id = await insertTask();
    const [oldMessage] = await dispatch();
    const oldTask = await store.claim(oldMessage);
    await expireLease(id);
    assert.equal(await store.heartbeat(oldTask), false);
    assert.equal(await store.complete(oldTask, {}), false);
    assert.equal(await store.fail(oldTask, new Error("old")), false);
    await store.recoverExpired();
    assert.equal((await dispatch()).length, 0); // Backoff has not elapsed.
    await makeRetryDue(id);
    const [newMessage] = await dispatch();
    assert.notEqual(newMessage.queueToken, oldMessage.queueToken);
    assert.equal(await store.claim(oldMessage), undefined);
    const newTask = await store.claim(newMessage);
    assert.equal(await store.heartbeat(oldTask), false);
    assert.equal(await store.complete(oldTask, {}), false);
    assert.equal(await store.fail(oldTask, new Error("late")), false);
    assert.equal(await store.heartbeat(newTask), true);
    assert.equal(await store.complete(newTask, { sum: 6 }), true);
    assert.equal(await store.fail(oldTask, new Error("late")), false);
    assert.equal((await readTask(id)).status, "COMPLETED");
});

for (const mode of ["failure", "crash"]) {
    test(`${mode} retries back off 10s, 20s, then stop at three total attempts`, async () => {
        const id = await insertTask();
        for (let attempt = 1; attempt <= 3; attempt++) {
            const [message] = await dispatch();
            const task = await store.claim(message);
            assert.equal(task.attempts, attempt);
            if (mode === "crash") {
                await expireLease(id);
                await store.recoverExpired();
            } else {
                assert.equal(await store.fail(task, new Error("execution failed")), true);
            }
            const row = await readTask(id);
            if (attempt < 3) {
                assert.equal(row.status, "RETRYING");
                assert.equal(new Date(row.next_retry_at) - new Date(row.updated_at), 5000 * 2 ** attempt);
                assert.equal((await dispatch()).length, 0);
                await makeRetryDue(id);
            } else {
                assert.equal(row.status, "DEAD");
                assert.equal(row.next_retry_at, null);
                assert.equal(row.lease_token, null);
                assert.equal((await dispatch()).length, 0);
            }
        }
    });
}

test("future tasks remain scheduled", async () => {
    const id = await insertTask();
    await db.query("UPDATE tasks SET scheduled_at=CURRENT_TIMESTAMP+INTERVAL '1 hour' WHERE id=$1", [id]);
    assert.equal((await dispatch()).length, 0);
    assert.equal((await readTask(id)).status, "SCHEDULED");
});

test("legacy queued tasks that exhausted attempts terminate instead of staying stuck", async () => {
    const id = await insertTask();
    await db.query("UPDATE tasks SET status='QUEUED', attempts=3 WHERE id=$1", [id]);
    await store.recoverExpired();
    assert.equal((await readTask(id)).status, "DEAD");
    assert.equal((await dispatch()).length, 0);
});

test("priority dispatch uses HIGH, MEDIUM, LOW lists in that order", async () => {
    for (const priority of ["LOW", "HIGH", "MEDIUM"]) {
        const id = await insertTask();
        await db.query("UPDATE tasks SET priority=$2 WHERE id=$1", [id, priority]);
    }
    const queues = [];
    await dispatchTasks(store, { rpush: async (key) => queues.push(key) });
    assert.deepEqual(queues, ["task_queue:HIGH", "task_queue:MEDIUM", "task_queue:LOW"]);
});

test("concurrent claims respect global and per-user capacity without spending attempts", async () => {
    await db.query("UPDATE scheduler_limits SET global_limit=1,per_user_limit=1 WHERE id=1");
    await insertTask();
    await insertTask();
    const messages = await dispatch();
    const claims = await Promise.all(messages.map((message) => store.claim(message)));
    assert.equal(claims.filter(Boolean).length, 1);
    const waiting = messages.find((message) => message.id !== claims.find(Boolean).id);
    assert.equal((await readTask(waiting.id)).attempts, 0);
    await store.complete(claims.find(Boolean), { sum: 6 });
    assert.ok(await store.claim(waiting));
});

test("running cancellation blocks completion and retains capacity until acknowledged", async () => {
    const id = await insertTask();
    const [message] = await dispatch();
    const task = await store.claim(message);
    await cancelTask(id, userId, "TASK", db);
    assert.equal((await readTask(id)).status, "RUNNING");
    assert.equal(await store.heartbeat(task), false);
    assert.equal(await store.complete(task, {}), false);
    assert.equal(await store.fail(task, new Error("late")), false);
    assert.equal(await store.acknowledgeCancellation(task), true);
    assert.equal((await readTask(id)).status, "CANCELLED");
});

test("idempotent recurring creation and series cancellation are atomic", async () => {
    const input = parseTaskInput({ name: "Recurring", type: "SUM", payload: { numbers: [1, 2] },
        scheduledAt: "2020-01-01T00:00:00Z", recurrence: { intervalSeconds: 60 } }, "same-key");
    const make = () => createTask({ ...input, id: randomUUID(), userId }, db);
    const results = await Promise.all([make(), make()]);
    assert.equal(results[0].task.id, results[1].task.id);
    assert.equal(results.filter((result) => result.replayed).length, 1);
    await assert.rejects(createTask({ ...input, requestHash: "different", id: randomUUID(), userId }, db),
        (error) => error.status === 409);
    assert.equal(await store.materializeRecurring(), 1);
    assert.equal(await store.materializeRecurring(), 0);
    assert.equal((await db.query("SELECT COUNT(*)::integer AS n FROM tasks")).rows[0].n, 2);
    await cancelTask(results[0].task.id, userId, "SERIES", db);
    assert.equal((await db.query("SELECT active FROM task_schedules")).rows[0].active, false);
    assert.ok((await db.query("SELECT status FROM tasks")).rows.every((row) => row.status === "CANCELLED"));
    assert.equal(await store.materializeRecurring(), 0);
});

test("V5 records transitions and measured duration without recording lease heartbeats", async () => {
    const id = await insertTask();
    const [message] = await dispatch();
    const task = await store.claim(message);
    await store.heartbeat(task);
    await store.heartbeat(task);
    assert.equal(await store.complete(task, { sum: 6 }), true);
    const events = (await db.query("SELECT * FROM task_events WHERE task_id=$1 ORDER BY id", [id])).rows;
    assert.deepEqual(events.map((event) => event.status), ["SCHEDULED", "QUEUED", "RUNNING", "COMPLETED"]);
    assert.ok(events.at(-1).duration_ms >= 0);
    const recorded = await readTask(id);
    assert.ok(recorded.started_at);
    assert.ok(recorded.finished_at);
    assert.ok(recorded.execution_ms >= 0);
});

test("V5 cancellation requests and acknowledgement both appear in history", async () => {
    const id = await insertTask();
    const [message] = await dispatch();
    const task = await store.claim(message);
    await cancelTask(id, userId, "TASK", db);
    await store.acknowledgeCancellation(task);
    const events = (await db.query("SELECT * FROM task_events WHERE task_id=$1 ORDER BY id", [id])).rows;
    assert.equal(events.at(-2).message, "Cancellation requested");
    assert.equal(events.at(-1).status, "CANCELLED");
});

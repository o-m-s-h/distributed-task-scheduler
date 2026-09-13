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

let db, store, cleanup;
const userId = randomUUID();
before(async () => {
    const schemaSql = await readFile(new URL("../migrations/001_v3.sql", import.meta.url), "utf8");
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
        db = { query: async (sql, params) => {
            const result = await engine.query(sql, params);
            return { ...result, rowCount: result.affectedRows };
        } };
        cleanup = () => engine.close();
        await engine.exec(schemaSql);
        await engine.exec(schemaSql);
    }
    store = createTaskStore(db);
    await db.query("INSERT INTO users(id,name,email,password) VALUES ($1,'Test','v3@example.test','unused')", [userId]);
});
after(async () => { await cleanup?.(); });
beforeEach(async () => { await db.query("DELETE FROM tasks"); });

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

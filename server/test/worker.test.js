import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { executeTask, validateTask } from "../src/worker/taskHandlers.js";
import { processTask } from "../src/worker/processTask.js";

test("handlers produce actual results and reject invalid tasks", async () => {
    assert.deepEqual(await executeTask({ type: "SUM", payload: { numbers: [10, 20, 30] } }), { sum: 60 });
    assert.deepEqual(await executeTask({ type: "SHA256", payload: { text: "abc" } }), {
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    });
    assert.throws(() => validateTask("EMAIL", {}), /Unsupported/);
    assert.throws(() => validateTask("SUM", { numbers: ["1"] }), /finite numbers/);
    assert.throws(() => validateTask("SUM", { numbers: [1], delayMs: -1 }), /delayMs/);
    await assert.rejects(executeTask({ type: "SUM", payload: { numbers: [1e308, 1e308] } }), /numeric range/);
});

for (const mode of ["lost", "error"]) {
    test(`heartbeat ${mode} aborts work without committing success or failure`, async () => {
        let aborted = false;
        const store = {
            claim: async () => ({ id: "test", attempts: 1 }),
            heartbeat: async () => { if (mode === "error") throw new Error("DB unavailable"); return false; },
            complete: async () => assert.fail("must not complete"),
            fail: async () => assert.fail("must not overwrite recovered task")
        };
        await processTask(store, {}, async (_task, signal) => {
            try { await sleep(1000, undefined, { signal }); }
            catch (error) { aborted = signal.aborted; throw error; }
        }, 5);
        assert.equal(aborted, true);
    });
}

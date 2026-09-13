import { readFile } from "node:fs/promises";
import pool from "../src/config/db.js";

let client;
try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(await readFile(new URL("../migrations/001_v3.sql", import.meta.url), "utf8"));
    await client.query("COMMIT");
    console.log("V3 schema ready");
} catch (error) {
    if (client) await client.query("ROLLBACK");
    console.error("Migration failed:", error.message);
    process.exitCode = 1;
} finally {
    client?.release();
    await pool.end();
}

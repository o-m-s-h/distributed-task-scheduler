import { readFile, readdir } from "node:fs/promises";
import pool from "../src/config/db.js";

let client;
try {
    client = await pool.connect();
    await client.query("BEGIN");
    const directory = new URL("../migrations/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    for (const file of files) {
        await client.query(await readFile(new URL(file, directory), "utf8"));
    }
    await client.query("COMMIT");
    console.log("V5 schema ready");
} catch (error) {
    if (client) await client.query("ROLLBACK");
    console.error("Migration failed:", error.message);
    process.exitCode = 1;
} finally {
    client?.release();
    await pool.end();
}

export const withTransaction = async (db, work) => {
    // Embedded database adapters may supply their own transaction implementation.
    if (typeof db.transaction === "function") return db.transaction(work);
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

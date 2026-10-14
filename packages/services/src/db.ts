import type pg from "pg";

/** A pool or a checked-out client; services accept either so callers can wrap them in a transaction. */
export type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

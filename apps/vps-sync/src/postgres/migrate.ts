import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import type { Pool, PoolClient } from "pg";

const MIGRATION_LOCK_KEY = 7_262_935_169n;

type Migration = { checksum: string; name: string; sql: string };

async function migrations(): Promise<Migration[]> {
  const directory = new URL("./migrations/", import.meta.url);
  const entries = await readdir(directory, { withFileTypes: true });

  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const sql = await readFile(new URL(entry.name, directory), "utf8");
        return { checksum: createHash("sha256").update(sql).digest("hex"), name: entry.name, sql };
      }),
  );
}

export async function withSessionLock<T>(
  client: PoolClient,
  key: bigint,
  work: () => Promise<T>,
): Promise<{ acquired: boolean; value?: T }> {
  const { rows } = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    [key.toString()],
  );

  if (!rows[0]?.acquired) return { acquired: false };

  try {
    return { acquired: true, value: await work() };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
  }
}

export async function applyMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();

  try {
    const lock = await withSessionLock(client, MIGRATION_LOCK_KEY, async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const available = await migrations();
      const { rows: appliedRows } = await client.query<{ checksum: string; name: string }>(
        "SELECT name, checksum FROM schema_migrations ORDER BY name",
      );
      const applied = new Map(appliedRows.map((migration) => [migration.name, migration.checksum]));

      for (const name of applied.keys()) {
        if (!available.some((migration) => migration.name === name)) {
          throw new Error(`MIGRATION_SCHEMA_AHEAD: ${name}`);
        }
      }

      let foundPending = false;
      for (const migration of available) {
        const checksum = applied.get(migration.name);
        if (checksum === undefined) {
          foundPending = true;
          continue;
        }
        if (foundPending) throw new Error(`MIGRATION_SCHEMA_BEHIND: ${migration.name}`);
        if (checksum !== migration.checksum) {
          throw new Error(`MIGRATION_CHECKSUM_MISMATCH: ${migration.name}`);
        }
      }

      for (const migration of available) {
        if (applied.has(migration.name)) continue;

        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
            migration.name,
            migration.checksum,
          ]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    });

    if (!lock.acquired) throw new Error("MIGRATION_LOCK_UNAVAILABLE");
  } finally {
    client.release();
  }
}

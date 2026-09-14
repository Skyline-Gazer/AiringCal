import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { applyMigrations, withSessionLock } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
const canRunIntegrationTests = Boolean(databaseUrl && process.env.VPS_SYNC_TEST_DATABASE === "1");

test("applies ordered migrations once and rejects changed checksums", { skip: !canRunIntegrationTests }, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `vps_sync_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await applyMigrations(pool);
    assert.deepEqual(
      (await pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows,
      [{ name: "0001_initial.sql" }],
    );

    await applyMigrations(pool);
    await pool.query("UPDATE schema_migrations SET checksum = 'changed'");
    await assert.rejects(() => applyMigrations(pool), /MIGRATION_CHECKSUM_MISMATCH/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("only one session acquires the same advisory lock", { skip: !canRunIntegrationTests }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const [a, b] = await Promise.all([pool.connect(), pool.connect()]);

  try {
    const claim = (client: typeof a) => withSessionLock(client, 1n, async () => "claimed");
    const claims = await Promise.all([claim(a), claim(b)]);

    assert.deepEqual(claims.map(({ acquired }) => acquired).sort(), [false, true]);
  } finally {
    a.release();
    b.release();
    await pool.end();
  }
});

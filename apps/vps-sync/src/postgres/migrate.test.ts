import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { applyMigrations, compareMigrationNames, withSessionLock } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
const canRunIntegrationTests = Boolean(databaseUrl && process.env.VPS_SYNC_TEST_DATABASE === "1");
const migrationsDirectory = new URL("./migrations/", import.meta.url);

function testMigration(name: string): URL {
  return new URL(name, migrationsDirectory);
}

async function writeTestMigration(name: string, sql: string): Promise<() => Promise<void>> {
  await writeFile(testMigration(name), sql);
  return () => unlink(testMigration(name));
}

test("sorts migration names by fixed UTF-16 order", () => {
  assert.deepEqual(
    ["z_001.sql", "é-001.sql", "a_001.sql", "A-001.sql"].sort(compareMigrationNames),
    ["A-001.sql", "a_001.sql", "z_001.sql", "é-001.sql"],
  );
});

test("rejects migrations when its advisory lock is unavailable", async () => {
  const client = {
    query: async () => ({ rows: [{ acquired: false }] }),
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;

  await assert.rejects(() => applyMigrations(pool), /MIGRATION_LOCK_UNAVAILABLE/);
});

test("applies migrations in lexical order once and rejects changed checksums", { skip: !canRunIntegrationTests }, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `vps_sync_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const suffix = randomUUID().replaceAll("-", "");
  const table = `migration_order_${suffix}`;
  const createName = `0100_test_${suffix}_create.sql`;
  const insertName = `0200_test_${suffix}_insert.sql`;
  const removeInsert = await writeTestMigration(insertName, `INSERT INTO ${table} (value) VALUES (1);`);
  const removeCreate = await writeTestMigration(createName, `CREATE TABLE ${table} (value integer NOT NULL);`);

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await applyMigrations(pool);
    assert.deepEqual(
      (await pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows,
      [{ name: "0001_initial.sql" }, { name: "0002_media_component_state.sql" }, { name: "0003_notification_failed.sql" }, { name: createName }, { name: insertName }],
    );
    assert.deepEqual((await pool.query(`SELECT value FROM ${table}`)).rows, [{ value: 1 }]);

    await applyMigrations(pool);
    await pool.query("UPDATE schema_migrations SET checksum = 'changed'");
    await assert.rejects(() => applyMigrations(pool), /MIGRATION_CHECKSUM_MISMATCH/);
  } finally {
    await removeCreate();
    await removeInsert();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("rejects a schema history that is ahead of available migrations", { skip: !canRunIntegrationTests }, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `vps_sync_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    await pool.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", ["9999_missing.sql", "unknown"]);

    await assert.rejects(() => applyMigrations(pool), /MIGRATION_SCHEMA_AHEAD/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("rejects a schema history with a migration gap", { skip: !canRunIntegrationTests }, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `vps_sync_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const name = `0100_test_${randomUUID().replaceAll("-", "")}_gap.sql`;
  const removeMigration = await writeTestMigration(name, "SELECT 1;");

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    await pool.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, "known"]);

    await assert.rejects(() => applyMigrations(pool), /MIGRATION_SCHEMA_BEHIND/);
  } finally {
    await removeMigration();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("rolls back a failed migration file", { skip: !canRunIntegrationTests }, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `vps_sync_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const suffix = randomUUID().replaceAll("-", "");
  const table = `migration_rollback_${suffix}`;
  const name = `0100_test_${suffix}_rollback.sql`;
  const removeMigration = await writeTestMigration(name, `CREATE TABLE ${table} (id integer); SELECT 1 / 0;`);

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await assert.rejects(() => applyMigrations(pool), /division by zero/);
    assert.deepEqual((await pool.query("SELECT to_regclass($1) AS relation", [table])).rows, [{ relation: null }]);
    assert.deepEqual((await pool.query("SELECT name FROM schema_migrations WHERE name = $1", [name])).rows, []);
  } finally {
    await removeMigration();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("only one session acquires the same advisory lock while the winner holds it", { skip: !canRunIntegrationTests }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const [a, b] = await Promise.all([pool.connect(), pool.connect()]);
  let releaseWinner: () => void = () => undefined;
  const winnerReleased = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  let signalWinnerAcquired: () => void = () => undefined;
  const winnerAcquired = new Promise<void>((resolve) => {
    signalWinnerAcquired = resolve;
  });

  try {
    const winner = withSessionLock(a, 1n, async () => {
      signalWinnerAcquired();
      await winnerReleased;
      return "claimed";
    });
    await winnerAcquired;
    const loser = await withSessionLock(b, 1n, async () => "claimed");

    assert.equal(loser.acquired, false);
    releaseWinner();
    assert.deepEqual(await winner, { acquired: true, value: "claimed" });
  } finally {
    releaseWinner();
    a.release();
    b.release();
    await pool.end();
  }
});

test("releases an advisory lock when work throws", { skip: !canRunIntegrationTests }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const [a, b] = await Promise.all([pool.connect(), pool.connect()]);

  try {
    await assert.rejects(
      () => withSessionLock(a, 1n, async () => Promise.reject(new Error("work failed"))),
      /work failed/,
    );
    assert.deepEqual(await withSessionLock(b, 1n, async () => "claimed"), { acquired: true, value: "claimed" });
  } finally {
    a.release();
    b.release();
    await pool.end();
  }
});

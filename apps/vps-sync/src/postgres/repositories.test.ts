import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";

import { PostgresAuthority, type CompleteState, type Publication, type Subject } from "./repositories.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl && process.env.VPS_SYNC_TEST_DATABASE === "1");
const hash = "a".repeat(64);
const secrets = ["test-access-secret", "test-refresh-secret", "postgres://test:secret@db/db", "https://open.feishu.cn/test-webhook-secret", "test-r2-secret"];
const subject: Subject = { subject_id: 1, type: 2, name: "test", name_cn: "测试", summary: "summary", date: "2026-01-01", eps: 12, total_episodes: 12, nsfw: false };

test("repository exports its PostgreSQL authority", () => {
  assert.equal(typeof PostgresAuthority, "function");
});

test("normalized PostgreSQL authority", { skip: !enabled }, async (t) => {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `vps_repositories_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const authority = new PostgresAuthority(pool, secrets);
  const start = async (run_id: string, observed_at: number) => {
    await authority.beginRun({ run_id, observed_at, source: "manual", mode: "shadow", git_sha: "b".repeat(40) });
  };
  const state = (run_id: string, observed_at: number, present = true): CompleteState => ({
    run_id, observed_at, complete: true, configured_user_ids: ["u"],
    users: [{ user_id: "u", upstream_username: "test-user", complete: true, items: present ? [{ subject_id: 1, collection_type: 3, rate: 8, tags: ["anime"], comment: "hello", ep_status: 1, vol_status: 0, private: false, upstream_updated_at: "2026-09-14T00:00:00Z" }] : [] }],
    subjects: [subject], calendar: [{ weekday: 1, subject_id: 1 }],
  });
  const publication = (run_id: string, observed_at: number, generation = 1, content_hash = hash): Publication => ({
    run_id, observed_at, generation, content_hash, object_key: `snapshots/v1/${generation}-${content_hash}.json`, published_at: observed_at, item_count: 1, git_sha: "b".repeat(40),
  });

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(await readFile(new URL("./migrations/0001_initial.sql", import.meta.url), "utf8"));

    await t.test("complete input commits normalized state; incomplete or duplicate input changes nothing", async () => {
      await start("r1", 100);
      await authority.commitCompleteState(state("r1", 100));
      assert.equal(await authority.collectionExists("u", 1), true);
      assert.deepEqual((await pool.query("SELECT weekday, subject_id FROM calendar_entries")).rows, [{ weekday: 1, subject_id: 1 }]);
      await start("r2", 200);
      for (const incomplete of [
        { ...state("r2", 200, false), complete: false },
        { ...state("r2", 200, false), users: [] },
        { ...state("r2", 200, false), users: [{ ...state("r2", 200).users[0], complete: false }] },
        { ...state("r2", 200), subjects: [subject, subject] },
        { ...state("r2", 200), calendar: [{ weekday: 8, subject_id: 1 }] },
      ]) await assert.rejects(() => authority.commitCompleteState(incomplete), /INVALID_COMPLETE_STATE/);
      assert.equal((await pool.query("SELECT missing_since FROM collection_items")).rows[0].missing_since, null);
      assert.equal((await pool.query("SELECT stage FROM sync_runs WHERE run_id = $1", ["r2"])).rows[0].stage, "started");
    });

    await t.test("database failure rolls back users, subjects, collections, calendar and run checkpoint", async () => {
      await pool.query("ALTER TABLE calendar_entries ADD CONSTRAINT test_rollback CHECK (weekday <> 2)");
      const broken = state("r2", 200, false);
      broken.subjects = [{ ...subject, name: "changed" }, { ...subject, subject_id: 2 }];
      broken.users[0].upstream_username = "changed";
      broken.calendar = [{ weekday: 2, subject_id: 2 }];
      await assert.rejects(() => authority.commitCompleteState(broken));
      await pool.query("ALTER TABLE calendar_entries DROP CONSTRAINT test_rollback");
      assert.deepEqual((await pool.query("SELECT name FROM subjects ORDER BY subject_id")).rows, [{ name: "test" }]);
      assert.equal((await pool.query("SELECT upstream_username FROM users")).rows[0].upstream_username, "test-user");
      assert.equal((await pool.query("SELECT missing_since FROM collection_items")).rows[0].missing_since, null);
      assert.deepEqual((await pool.query("SELECT weekday FROM calendar_entries")).rows, [{ weekday: 1 }]);
      assert.equal((await pool.query("SELECT stage FROM sync_runs WHERE run_id = $1", ["r2"])).rows[0].stage, "started");
    });

    await t.test("two distinct complete missing observations delete, replay cannot delete, restoration clears both markers", async () => {
      await authority.commitCompleteState(state("r2", 200, false));
      await authority.commitCompleteState(state("r2", 200, false));
      assert.equal(await authority.collectionExists("u", 1), true);
      assert.equal(Number((await pool.query("SELECT missing_since FROM collection_items")).rows[0].missing_since), 200);
      await start("r3", 300);
      await authority.commitCompleteState(state("r3", 300, false));
      assert.equal(await authority.collectionExists("u", 1), false);
      await start("r4", 400);
      await authority.commitCompleteState(state("r4", 400));
      assert.deepEqual((await pool.query("SELECT missing_since, deleted_at FROM collection_items")).rows, [{ missing_since: null, deleted_at: null }]);
      await assert.rejects(() => authority.commitCompleteState(state("r1", 100, false)), /STALE_OBSERVATION/);
      assert.equal(await authority.collectionExists("u", 1), true);
    });

    await t.test("due media candidates fence old timestamps and old run IDs; failures preserve last good components", async () => {
      const [candidate] = await authority.listDueMedia({ run_id: "r4", observed_at: 400, limit: 10 });
      assert.deepEqual({ subject_id: candidate.subject_id, run_id: candidate.run_id, observed_at: candidate.observed_at }, { subject_id: 1, run_id: "r4", observed_at: 400 });
      const image = `shadow/images/${hash}/original`;
      assert.equal(await authority.applyMediaResult({ ...candidate, status: "ok", detail: subject, detail_hash: hash, common_key: image, common_hash: hash, next_refresh_at: 1000 }), true);
      await start("r5", 500);
      assert.equal(await authority.applyMediaResult({ subject_id: 1, run_id: "r5", observed_at: 500, status: "failed", error_code: "UPSTREAM_TIMEOUT", next_retry_at: 600 }), true);
      assert.equal(await authority.applyMediaResult({ ...candidate, status: "ok", common_key: null, common_hash: null, next_refresh_at: 1000 }), false);
      await start("r6", 500);
      assert.equal(await authority.applyMediaResult({ subject_id: 1, run_id: "r6", observed_at: 500, status: "not_found", tombstone_until: 700 }), true);
      assert.equal(await authority.applyMediaResult({ subject_id: 1, run_id: "r5", observed_at: 500, status: "ok", common_key: null, common_hash: null }), false);
      const media = (await pool.query("SELECT common_key, detail, run_id FROM subject_media")).rows[0];
      assert.equal(media.common_key, image);
      assert.equal(media.detail.name, "test");
      assert.equal(media.run_id, "r6");
      assert.deepEqual(await authority.listDueMedia({ run_id: "r6", observed_at: 500, limit: 10 }), []);
    });

    await t.test("singleton publication supports pending replay, claims, generation conflicts and verified replay", async () => {
      assert.deepEqual(await authority.getPublicationState(), { verified: null, pending: null, claimed: false });
      const first = publication("r4", 400);
      assert.equal((await authority.savePendingPublication(first)).outcome, "pending");
      assert.equal((await authority.savePendingPublication(first)).outcome, "replay");
      await assert.rejects(() => authority.savePendingPublication(publication("r5", 500, 2)), /GENERATION_CONFLICT/);
      await authority.savePendingPublication(first, "claim");
      const replacement = publication("r5", 500, 1, "c".repeat(64));
      await assert.rejects(() => authority.savePendingPublication(replacement), /PUBLICATION_CLAIMED/);
      await assert.rejects(() => authority.verifyPublication(replacement), /PUBLICATION_CONFLICT/);
      await authority.savePendingPublication(first, "release");
      assert.equal((await authority.savePendingPublication(replacement)).outcome, "pending");
      await authority.savePendingPublication(replacement, "claim");
      assert.equal(await authority.verifyPublication(replacement), "verified");
      assert.equal(await authority.verifyPublication(replacement), "replay");
      assert.deepEqual(await authority.getPublicationState(), { verified: replacement, pending: null, claimed: false });
      assert.equal((await authority.savePendingPublication(replacement)).outcome, "no_change");
      await assert.rejects(() => authority.savePendingPublication(first), /GENERATION_CONFLICT|STALE_OBSERVATION/);
      const next = publication("r6", 500, 2);
      await authority.savePendingPublication(next);
      await authority.savePendingPublication(replacement);
      assert.deepEqual((await authority.getPublicationState()).pending, next);
      await start("r7", 700);
      await authority.savePendingPublication(publication("r7", 700, 1, replacement.content_hash));
      assert.equal((await authority.getPublicationState()).pending, null);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM publications")).rows[0].count, 1);
    });

    await t.test("only normalized business fields and stable run outcomes survive a scan of every text/json column", async () => {
      await start("secret-check", 800);
      const injected = state("secret-check", 800);
      Object.assign(injected.subjects[0] = { ...subject }, { access_token: secrets[0], raw_response: secrets.join(" ") });
      Object.assign(injected.users[0], { refresh_token: secrets[1] });
      Object.assign(injected.users[0].items[0], { authorization: secrets[2] });
      await authority.commitCompleteState(injected);
      for (const secret of secrets) {
        const unsafe = state("secret-check", 800);
        unsafe.subjects = [{ ...subject, summary: secret }];
        await assert.rejects(() => authority.commitCompleteState(unsafe), /SECRET_PERSISTENCE_FORBIDDEN/);
      }
      await authority.finishRun("secret-check", { status: "partial", error_code: secrets[3], publication: "verified", backup: "failed", notification: "failed", completed_at: 900 });
      const run = (await pool.query("SELECT status, error_code, notification FROM sync_runs WHERE run_id = $1", ["secret-check"])).rows[0];
      assert.deepEqual(run, { status: "partial", error_code: "UNKNOWN", notification: "failed" });
      const columns = (await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND data_type IN ('text', 'json', 'jsonb', 'character varying')", [schema])).rows;
      for (const { table_name, column_name } of columns) {
        assert.match(table_name, /^[a-z_]+$/);
        assert.match(column_name, /^[a-z_]+$/);
        const values = (await pool.query(`SELECT "${column_name}"::text AS value FROM "${table_name}"`)).rows;
        for (const { value } of values) for (const secret of secrets) assert.equal(value?.includes(secret) ?? false, false, `${table_name}.${column_name}`);
      }
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

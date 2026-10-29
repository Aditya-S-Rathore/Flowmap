import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationRisks } from "../src/migrations.ts";

const rules = (sql: string, file = "m.ts") => migrationRisks(file, sql).map((r) => `${r.rule}:${r.table}`);

test("an index built without CONCURRENTLY on a table that already exists", () => {
  assert.deepEqual(rules(`await q.query('CREATE INDEX idx_a ON jobs (user_id)');`), ["index-locks:jobs"]);
  assert.deepEqual(rules(`CREATE INDEX CONCURRENTLY idx_a ON jobs (user_id);`, "m.sql"), ["concurrent-in-tx:null"], "CONCURRENTLY itself is fine; it needs transaction = false");
  assert.deepEqual(rules(`public transaction = false;\nCREATE INDEX CONCURRENTLY idx_a ON jobs (user_id);`), []);
});

test("a table the migration creates is empty: nothing to lock", () => {
  assert.deepEqual(rules(`CREATE TABLE jobs (id int);\nCREATE INDEX idx_a ON jobs (id);\nALTER TABLE jobs ADD COLUMN x int NOT NULL;`), []);
});

test("NOT NULL needs a default; a foreign key needs NOT VALID; a type change rewrites", () => {
  assert.deepEqual(rules(`ALTER TABLE users ADD COLUMN nick text NOT NULL;`), ["not-null-no-default:users"]);
  assert.deepEqual(rules(`ALTER TABLE users ADD COLUMN nick text NOT NULL DEFAULT '';`), []);
  assert.deepEqual(rules(`ALTER TABLE users ADD CONSTRAINT fk FOREIGN KEY (org) REFERENCES orgs(id);`), ["fk-validates:users"]);
  assert.deepEqual(rules(`ALTER TABLE users ADD CONSTRAINT fk FOREIGN KEY (org) REFERENCES orgs(id) NOT VALID;`), []);
  assert.deepEqual(rules(`ALTER TABLE users ALTER COLUMN age TYPE bigint;`), ["type-rewrite:users"]);
});

test("rollback code is not a risk", () => {
  assert.deepEqual(rules(`public async up(q) { await q.query('SELECT 1'); }\npublic async down(q) { await q.query('CREATE INDEX i ON users (a)'); }`), []);
});

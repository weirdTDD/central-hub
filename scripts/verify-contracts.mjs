// Central Hub — contract check: the app's vocabularies vs the database constraints.
//
// The task statuses, priorities and attribution sources are defined in JavaScript
// (src/features/tasks/taskUtils.js, src/features/tracking/sessionUtils.js) AND in
// SQL CHECK constraints. If the two lists drift, the app accepts a value the
// database rejects. This script reads the migrations and compares them.
//
// Run:  node scripts/verify-contracts.mjs
//
// Exit code 0 = every contract holds, 1 = at least one failed.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "../src/features/tasks/taskUtils.js";
import { ATTRIBUTION_SOURCES } from "../src/features/tracking/sessionUtils.js";
import {
  APPROVAL_STATUSES,
  CHANNELS,
  NOTIFICATION_STATUSES,
  RUN_STATUSES,
} from "../src/features/notifications/workflowEngine.js";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");

const migrationSql = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => readFileSync(path.join(migrationsDir, name), "utf8"))
  .join("\n");

/**
 * Extracts the quoted values of a `check (... col in ('a', 'b'))` constraint.
 */
function allowedValues(sql, constraintName, column) {
  const pattern = new RegExp(
    `constraint\\s+${constraintName}\\s+check\\s*\\([^;]*?\\b${column}\\s+in\\s*\\(([^)]*)\\)`,
    "i"
  );
  const match = sql.match(pattern);
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

/**
 * The body of a `create table if not exists <name> (...)` statement.
 */
function tableBody(sql, table) {
  const match = sql.match(
    new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`)
  );
  return match ? match[1] : null;
}

console.log("Central Hub — schema/JS contract assertions\n");

console.log("Vocabulary drift");
check("task statuses match the tasks_status_valid constraint", () => {
  const sqlValues = allowedValues(migrationSql, "tasks_status_valid", "status");
  assert(sqlValues !== null, "tasks_status_valid constraint not found in the migrations");
  const jsValues = TASK_STATUSES.map((status) => status.value);
  assertEqual(
    JSON.stringify([...jsValues].sort()),
    JSON.stringify([...sqlValues].sort()),
    "task statuses differ between the app and the database"
  );
});

check("task priorities match the tasks_priority_valid constraint", () => {
  const sqlValues = allowedValues(migrationSql, "tasks_priority_valid", "priority");
  assert(sqlValues !== null, "tasks_priority_valid constraint not found in the migrations");
  const jsValues = TASK_PRIORITIES.map((priority) => priority.value);
  assertEqual(
    JSON.stringify([...jsValues].sort()),
    JSON.stringify([...sqlValues].sort()),
    "task priorities differ between the app and the database"
  );
});

check("attribution sources match the sessions_attribution_source_valid constraint", () => {
  const sqlValues = allowedValues(
    migrationSql,
    "sessions_attribution_source_valid",
    "attribution_source"
  );
  assert(
    sqlValues !== null,
    "sessions_attribution_source_valid constraint not found in the migrations"
  );
  assertEqual(
    JSON.stringify([...ATTRIBUTION_SOURCES].sort()),
    JSON.stringify([...sqlValues].sort()),
    "attribution sources differ between the app and the database"
  );
});

console.log("\nSchema contracts the app relies on");
check("sessions.duration_seconds is nullable (missing is never zero)", () => {
  const body = tableBody(migrationSql, "sessions");
  assert(body !== null, "the sessions table not found in the migrations");
  assert(
    /^\s*duration_seconds\s+integer,?\s*(--.*)?$/m.test(body),
    "sessions.duration_seconds must be nullable so an unmeasured session stores NULL"
  );
  assert(
    !/^\s*duration_seconds\s+integer\s+not\s+null/m.test(body),
    "sessions.duration_seconds must not be NOT NULL"
  );
});

check("session_corrections uses a client-generated key (idempotent insert)", () => {
  const body = tableBody(migrationSql, "session_corrections");
  assert(body !== null, "the session_corrections table not found");
  assert(
    /id\s+uuid\s+primary\s+key,/.test(body),
    "session_corrections.id must be a client-generated primary key without a server default"
  );
});

check("a correction's duration must match its own interval", () => {
  assert(
    /constraint\s+session_corrections_duration_matches_interval/.test(migrationSql),
    "the duration/interval consistency constraint is missing"
  );
});

check("observations are append-only (no UPDATE grant)", () => {
  assert(
    /grant select, insert, delete on public\.observations\s+to authenticated;/.test(
      migrationSql
    ),
    "observations must not grant UPDATE"
  );
});

check("a task's status and completed_at cannot disagree", () => {
  assert(
    /constraint\s+tasks_completed_at_matches_status/.test(migrationSql),
    "the tasks_completed_at_matches_status constraint is missing"
  );
});

check("every tracked table is in the realtime publication", () => {
  for (const table of ["work_logs", "tasks"]) {
    assert(
      migrationSql.includes(`tablename = '${table}'`),
      `${table} is never added to the supabase_realtime publication`
    );
  }
  // The Phase 4 tables are added through a loop over an array of table names.
  const loops = [
    ...migrationSql.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([^\]]*)\]/g),
  ].map((match) => match[1]);
  assert(loops.length > 0, "no publication loop found in the migrations");
  for (const table of ["observations", "sessions", "session_corrections"]) {
    assert(
      loops.some((names) => names.includes(`'${table}'`)),
      `${table} is never added to the supabase_realtime publication`
    );
  }
});

console.log("\nPhase 6 — notification and workflow contracts");
check("run statuses match the workflow_runs_status_valid constraint", () => {
  const sqlValues = allowedValues(
    migrationSql,
    "workflow_runs_status_valid",
    "status"
  );
  assert(
    sqlValues !== null,
    "workflow_runs_status_valid constraint not found in the migrations"
  );
  assertEqual(
    JSON.stringify([...RUN_STATUSES].sort()),
    JSON.stringify([...sqlValues].sort()),
    "workflow run statuses differ between the app and the database"
  );
});

check("notification statuses match the notifications_status_valid constraint", () => {
  const sqlValues = allowedValues(
    migrationSql,
    "notifications_status_valid",
    "status"
  );
  assert(
    sqlValues !== null,
    "notifications_status_valid constraint not found in the migrations"
  );
  assertEqual(
    JSON.stringify([...NOTIFICATION_STATUSES].sort()),
    JSON.stringify([...sqlValues].sort()),
    "notification statuses differ between the app and the database"
  );
});

check("approval statuses match the approvals_status_valid constraint", () => {
  const sqlValues = allowedValues(
    migrationSql,
    "approvals_status_valid",
    "status"
  );
  assert(
    sqlValues !== null,
    "approvals_status_valid constraint not found in the migrations"
  );
  assertEqual(
    JSON.stringify([...APPROVAL_STATUSES].sort()),
    JSON.stringify([...sqlValues].sort()),
    "approval statuses differ between the app and the database"
  );
});

check("only the implemented delivery channel is allowed", () => {
  const sqlValues = allowedValues(
    migrationSql,
    "notifications_channel_valid",
    "channel"
  );
  assert(
    sqlValues !== null,
    "notifications_channel_valid constraint not found in the migrations"
  );
  assertEqual(
    JSON.stringify([...CHANNELS].sort()),
    JSON.stringify([...sqlValues].sort()),
    "the delivery channels differ between the app and the database"
  );
});

check("a workflow run can be executed only once per occurrence", () => {
  assert(
    /constraint\s+workflow_runs_idempotency_unique\s+unique\s+\(user_id,\s*idempotency_key\)/.test(
      migrationSql
    ),
    "the (user_id, idempotency_key) unique constraint is missing"
  );
});

check("a delivered notification survives the deletion of its workflow", () => {
  const body = tableBody(migrationSql, "notifications");
  assert(body !== null, "the notifications table not found");
  assert(
    /workflow_id\s+uuid\s+references\s+public\.workflows\(id\)\s+on\s+delete\s+set\s+null/.test(
      body
    ),
    "notifications.workflow_id must be ON DELETE SET NULL"
  );
});

check("the workflow tables are in the realtime publication", () => {
  const loops = [
    ...migrationSql.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([^\]]*)\]/g),
  ].map((match) => match[1]);
  for (const table of ["workflows", "workflow_runs", "notifications", "approvals"]) {
    assert(
      loops.some((names) => names.includes(`'${table}'`)),
      `${table} is never added to the supabase_realtime publication`
    );
  }
});

check("no privilege is granted to anon on the workflow tables", () => {
  for (const table of [
    "workflows",
    "workflow_runs",
    "notifications",
    "notification_preferences",
    "approvals",
  ]) {
    assert(
      new RegExp(
        `revoke all on public\\.${table}\\s+from anon, authenticated;`
      ).test(migrationSql),
      `public.${table} must be revoked from anon and authenticated before the minimal grant`
    );
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);

if (failures.length > 0) {
  console.error("\nFailed contracts:");
  for (const failure of failures) {
    console.error(` - ${failure.name}: ${failure.message}`);
  }
  process.exit(1);
}

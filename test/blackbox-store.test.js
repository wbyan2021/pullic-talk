import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BlackboxStoreError,
  createBlackboxStore,
} from "../src/services/blackbox-store.js";

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "s04-blackbox-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeClock() {
  let value = 1_750_000_000_000;
  return {
    now: () => value,
    advance: (ms) => { value += ms; },
  };
}

async function rejectCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BlackboxStoreError);
    return error.code;
  }
  assert.fail("expected rejection");
}

test("begins and appends an ordered JSONL task record", async (t) => {
  const root = makeRoot(t);
  const clock = makeClock();
  const store = createBlackboxStore({ rootDir: root, now: clock.now });

  await store.beginTask({ projectId: "project_a", taskId: "task_001", data: { goal: "inspect files" } });
  clock.advance(1000);
  await store.appendEvent({ projectId: "project_a", taskId: "task_001", type: "state_changed", data: { state: "running" } });

  const record = await store.readTask({ projectId: "project_a", taskId: "task_001" });
  assert.deepEqual(record.events.map((event) => event.seq), [1, 2]);
  assert.deepEqual(record.events.map((event) => event.type), ["task_created", "state_changed"]);
  assert.equal(record.events[0].at, "2025-06-15T15:06:40.000Z");
  assert.equal(record.closed, false);
});

test("rejects duplicate tasks, path traversal and appends after close", async (t) => {
  const root = makeRoot(t);
  const store = createBlackboxStore({ rootDir: root });

  await store.beginTask({ projectId: "project_a", taskId: "task_001" });
  assert.equal(await rejectCode(store.beginTask({ projectId: "project_a", taskId: "task_001" })), "task_exists");
  assert.equal(await rejectCode(store.beginTask({ projectId: "../escape", taskId: "task_002" })), "invalid_id");

  await store.closeTask({ projectId: "project_a", taskId: "task_001", type: "exited", data: { exitCode: 0 } });
  assert.equal(await rejectCode(store.appendEvent({ projectId: "project_a", taskId: "task_001", type: "late" })), "task_closed");
});

test("redacts event payloads before writing them to disk", async (t) => {
  const root = makeRoot(t);
  const store = createBlackboxStore({ rootDir: root });
  await store.beginTask({ projectId: "project_a", taskId: "task_001" });
  await store.appendEvent({
    projectId: "project_a",
    taskId: "task_001",
    type: "output_chunk",
    data: { text: "API_KEY=sk-test-12345678901234567890" },
  });

  const file = join(root, "project_a", "task_001.jsonl");
  const raw = readFileSync(file, "utf8");
  assert.ok(raw.includes("withheld_sensitive"));
  assert.ok(!raw.includes("sk-test-12345678901234567890"));
});

test("recovery ignores a truncated final line and marks an open task interrupted", async (t) => {
  const root = makeRoot(t);
  const store = createBlackboxStore({ rootDir: root });
  await store.beginTask({ projectId: "project_a", taskId: "task_001" });
  const file = join(root, "project_a", "task_001.jsonl");
  writeFileSync(file, readFileSync(file, "utf8") + '{"seq":99');

  const recovered = createBlackboxStore({ rootDir: root });
  const result = await recovered.recoverIncomplete();
  assert.deepEqual(result, [{ projectId: "project_a", taskId: "task_001", state: "interrupted" }]);

  const record = await recovered.readTask({ projectId: "project_a", taskId: "task_001" });
  assert.deepEqual(record.events.map((event) => event.type), ["task_created", "interrupted"]);
  assert.equal(record.closed, true);
});

test("recovery leaves closed tasks untouched and missing tasks report stable errors", async (t) => {
  const root = makeRoot(t);
  const store = createBlackboxStore({ rootDir: root });
  await store.beginTask({ projectId: "project_a", taskId: "task_001" });
  await store.closeTask({ projectId: "project_a", taskId: "task_001", type: "exited" });

  const recovered = createBlackboxStore({ rootDir: root });
  assert.deepEqual(await recovered.recoverIncomplete(), []);
  assert.equal(await rejectCode(recovered.readTask({ projectId: "project_a", taskId: "missing" })), "task_not_found");
  assert.equal(existsSync(join(root, "project_a", "task_001.jsonl")), true);
});

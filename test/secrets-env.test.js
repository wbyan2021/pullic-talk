import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "secrets-env-"));
process.env.SECRETS_ENV_PATH = join(tmp, ".secrets.env");

const { SECRETS_ENV_PATH, getSecretsSnapshot, writeSecretsFile, readSecretsFile, shellQuote } =
  await import("../src/utils/secrets-env.js");

test("shellQuote produces shell-safe single-quoted values", () => {
  assert.equal(shellQuote("abc"), "'abc'");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("file starts missing and snapshot is empty", () => {
  const snap = readSecretsFile();
  assert.equal(snap.exists, false);
  assert.deepEqual(getSecretsSnapshot(), {});
});

test("writeSecretsFile rewrites values, deletes empties, adds new keys and preserves comments", () => {
  delete process.env.OLD_A;
  delete process.env.OLD_B;
  delete process.env.NEW_C;
  writeFileSync(
    SECRETS_ENV_PATH,
    "# header comment\nexport OLD_A=\"old-a\"\nexport OLD_B='old-b'\n",
    "utf-8",
  );
  writeSecretsFile({
    OLD_A: "new-a",
    OLD_B: "", // delete
    NEW_C: "new-c",
  });
  const content = readFileSync(SECRETS_ENV_PATH, "utf-8");
  assert.ok(content.startsWith("# header comment"), "comments must survive");
  assert.ok(content.includes("export OLD_A='new-a'"), "existing key rewritten with new value");
  assert.ok(!content.includes("OLD_B"), "empty value deletes the line");
  assert.ok(content.includes("export NEW_C='new-c'"), "new key appended");

  const snap = getSecretsSnapshot();
  assert.equal(snap.OLD_A, "new-a");
  assert.equal(snap.NEW_C, "new-c");
  assert.ok(!("OLD_B" in snap));
});

test("snapshot prefers runtime env value over the file value", () => {
  process.env.TEMP_SECRET_TEST = "runtime-value";
  writeSecretsFile({ TEMP_SECRET_TEST: "file-value", OTHER_KEY: "x" });
  const snap = getSecretsSnapshot();
  assert.equal(snap.TEMP_SECRET_TEST, "runtime-value", "runtime env wins");
  delete process.env.TEMP_SECRET_TEST;

  const snap2 = getSecretsSnapshot();
  assert.equal(snap2.TEMP_SECRET_TEST, "file-value", "without env, file value is used");
});

test("teardown", () => {
  rmSync(tmp, { recursive: true, force: true });
});
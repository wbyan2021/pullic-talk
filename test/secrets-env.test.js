import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "secrets-env-"));
process.env.SECRETS_ENV_PATH = join(tmp, ".secrets.env");

const {
  SECRETS_ENV_PATH,
  getSecretsSnapshot,
  getMaskedSnapshot,
  writeSecretsFile,
  readSecretsFile,
  shellQuote,
  maskValue,
  loadSecretsIntoProcess,
} = await import("../src/utils/secrets-env.js");

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

test("maskValue masks any non-empty value with the fixed mask", () => {
  assert.equal(maskValue("abc"), "••••••••");
  assert.equal(maskValue("a-much-longer-secret-value-1234567890"), "••••••••");
  assert.equal(maskValue(" "), "••••••••", "whitespace-only is still non-empty text");
  assert.equal(maskValue(""), "");
  assert.equal(maskValue(undefined), "");
  assert.equal(maskValue(null), "");
});

test("getMaskedSnapshot returns keys with masked values only", () => {
  delete process.env.MASK_A;
  delete process.env.MASK_B;
  writeFileSync(SECRETS_ENV_PATH, "export MASK_A='real-value-a'\nexport MASK_B='real-value-b'\n", "utf-8");
  const masked = getMaskedSnapshot();
  assert.deepEqual(Object.keys(masked).sort(), ["MASK_A", "MASK_B"]);
  assert.equal(masked.MASK_A, "••••••••");
  assert.equal(masked.MASK_B, "••••••••");
  assert.ok(!JSON.stringify(masked).includes("real-value"), "masked snapshot must not contain plaintext");
  delete process.env.MASK_A;
  delete process.env.MASK_B;
});

test("getMaskedSnapshot omits keys whose effective value is empty", () => {
  delete process.env.MASK_EMPTY;
  writeSecretsFile({ MASK_EMPTY: "" }); // 空值 = 删除，文件中不应存在
  writeFileSync(SECRETS_ENV_PATH, "export MASK_EMPTY=\n", "utf-8"); // 直接构造空值行
  const masked = getMaskedSnapshot();
  assert.ok(!("MASK_EMPTY" in masked), "empty values must not enter the masked snapshot");
});

test("loadSecretsIntoProcess fills missing keys, never overrides existing ones", () => {
  const file = join(tmp, "load.env");
  writeFileSync(
    file,
    [
      "# comment line is ignored",
      "export LOAD_A='value-a'",
      "export LOAD_B='value-b'",
      "export LOAD_C=",
      "export LOAD_D=${LOAD_X:-fallback}",
      "not an export line",
    ].join("\n") + "\n",
    "utf-8",
  );
  const env = { LOAD_B: "already-set" };
  const { loaded, skipped } = loadSecretsIntoProcess(file, env);
  assert.equal(env.LOAD_A, "value-a", "missing key must be loaded from the file");
  assert.equal(env.LOAD_B, "already-set", "explicitly set vars must not be overridden");
  assert.ok(!("LOAD_C" in env), "empty literal values must be skipped");
  assert.ok(!("LOAD_D" in env), "fallback expressions must be skipped");
  assert.equal(loaded, 1);
  assert.equal(skipped, 3);
});

test("loadSecretsIntoProcess tolerates a missing file", () => {
  const env = {};
  const { loaded } = loadSecretsIntoProcess(join(tmp, "does-not-exist.env"), env);
  assert.equal(loaded, 0);
  assert.deepEqual(env, {});
});

test("teardown", () => {
  rmSync(tmp, { recursive: true, force: true });
});
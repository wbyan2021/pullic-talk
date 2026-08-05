import { spawn } from "node:child_process";

const SECURITY_BIN = "/usr/bin/security";
const SERVICE = "com.ai-ops.cockpit.provider.deepseek";
const ACCOUNT = "default";
const LABEL = "AI·OPS COCKPIT · DeepSeek";
const MAX_OUTPUT_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const SAFE_MESSAGES = {
  credential_store_unavailable: "系统钥匙串暂时不可用，请检查 macOS 钥匙串状态后重试。",
  unsupported_platform: "当前凭据存储仅支持 macOS。",
  invalid_secret: "凭据内容无效。",
};

export class CredentialStoreError extends Error {
  constructor(code, message = SAFE_MESSAGES[code] || SAFE_MESSAGES.credential_store_unavailable, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CredentialStoreError";
    this.code = code;
    this.retryable = options.retryable ?? code === "credential_store_unavailable";
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

function appendBounded(current, chunk) {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
  const next = current + chunk.toString("utf8");
  return Buffer.byteLength(next) <= MAX_OUTPUT_BYTES
    ? next
    : Buffer.from(next).subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
}

export function createSecurityRunner({ spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return function runSecurity(args, { stdin } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(SECURITY_BIN, args, {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (cause) {
        reject(new CredentialStoreError("credential_store_unavailable", undefined, { cause }));
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let forceKillTimer;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        forceKillTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
        }, 250);
        forceKillTimer.unref?.();
        finish(() => reject(new CredentialStoreError("credential_store_unavailable")));
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
      child.on("error", (cause) => {
        finish(() => reject(new CredentialStoreError("credential_store_unavailable", undefined, { cause })));
      });
      child.on("close", (status, signal) => {
        clearTimeout(forceKillTimer);
        finish(() => {
          resolve({ status: Number.isInteger(status) ? status : 1, signal, stdout, stderr });
        });
      });

      child.stdin.on("error", () => {});
      child.stdin.end(stdin === undefined ? "" : `${stdin}\n`);
    });
  };
}

function isNotFound(result) {
  if (result?.status === 44) return true;
  return /could not be found|errSecItemNotFound|specified item.*not.*found/i.test(result?.stderr || "");
}

export function createCredentialStore({
  runSecurity = createSecurityRunner(),
  platform = process.platform,
} = {}) {
  function assertSupported() {
    if (platform !== "darwin") {
      throw new CredentialStoreError("unsupported_platform", undefined, { retryable: false });
    }
  }

  async function execute(args, options) {
    assertSupported();
    try {
      return await runSecurity(args, options);
    } catch (cause) {
      if (cause instanceof CredentialStoreError) throw cause;
      throw new CredentialStoreError("credential_store_unavailable", undefined, { cause });
    }
  }

  const findArgs = () => ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE];

  return {
    async has() {
      const result = await execute(findArgs());
      if (result.status === 0) return true;
      if (isNotFound(result)) return false;
      throw new CredentialStoreError("credential_store_unavailable");
    },

    async get() {
      const result = await execute([...findArgs(), "-w"]);
      if (result.status === 0) return result.stdout.replace(/\r?\n$/, "");
      if (isNotFound(result)) return null;
      throw new CredentialStoreError("credential_store_unavailable");
    },

    async set(secret) {
      if (typeof secret !== "string" || !secret) {
        throw new CredentialStoreError("invalid_secret", undefined, { retryable: false });
      }
      const args = [
        "add-generic-password",
        "-a", ACCOUNT,
        "-s", SERVICE,
        "-l", LABEL,
        "-U",
        "-w",
      ];
      const result = await execute(args, { stdin: secret });
      if (result.status !== 0) throw new CredentialStoreError("credential_store_unavailable");
      return true;
    },

    async delete() {
      const result = await execute(["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE]);
      if (result.status === 0) return true;
      if (isNotFound(result)) return false;
      throw new CredentialStoreError("credential_store_unavailable");
    },
  };
}

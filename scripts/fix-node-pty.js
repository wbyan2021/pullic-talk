// node-pty 的 prebuild spawn-helper 在某些环境安装后丢失执行位，
// 导致 posix_spawnp failed。这里统一补回执行权限。
import { chmodSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prebuildsDir = join(__dirname, "..", "node_modules", "node-pty", "prebuilds");

if (!existsSync(prebuildsDir)) {
  console.log("  · node-pty 未安装，跳过 spawn-helper 修复");
  process.exit(0);
}

let fixed = 0;
for (const platform of readdirSync(prebuildsDir)) {
  const helper = join(prebuildsDir, platform, "spawn-helper");
  if (existsSync(helper)) {
    try {
      chmodSync(helper, 0o755);
      fixed++;
    } catch (e) {
      console.warn(`  ⚠️ 无法修复 ${helper}: ${e.message}`);
    }
  }
}
console.log(`  ✓ node-pty spawn-helper 执行位已修复（${fixed} 个）`);

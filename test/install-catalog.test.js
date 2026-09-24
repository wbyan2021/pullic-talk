import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_CATALOG, STARTER_PATH, getInstallEntry, findInstallIdForAgent } from "../src/install-catalog.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GROUPS = new Set(["env", "cli", "editor", "chat", "runtime", "models"]);
const KINDS = new Set(["app", "cli", "link"]);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// 包名 / formula 名：只允许字母数字与 @ . / _ -，禁止空格和 shell 元字符
const TOKEN_RE = /^[A-Za-z0-9@/._-]+$/;
// 官方脚本白名单前缀：只允许已知 https 来源的安装脚本
const SCRIPT_PREFIXES = [
  "NONINTERACTIVE=1 /bin/bash",
  "curl -LsSf https://",
  "curl -fsSL https://",
];

test("安装目录：id 唯一且格式合法", () => {
  const ids = INSTALL_CATALOG.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const id of ids) assert.match(id, ID_RE);
});

test("安装目录：每个条目都有完整展示字段与合法分组", () => {
  for (const e of INSTALL_CATALOG) {
    assert.ok(e.name, `${e.id}: name required`);
    assert.ok(e.icon, `${e.id}: icon required`);
    assert.ok(e.color, `${e.id}: color required`);
    assert.ok(e.description, `${e.id}: description required`);
    assert.match(e.homepage || "", /^https:\/\//, `${e.id}: homepage must be https`);
    assert.ok(GROUPS.has(e.group), `${e.id}: unknown group ${e.group}`);
    assert.ok(KINDS.has(e.kind), `${e.id}: unknown kind ${e.kind}`);
  }
});

test("安装目录：可安装条目必须有探测方式和至少一种安装渠道", () => {
  for (const e of INSTALL_CATALOG) {
    if (e.linkOnly) continue;
    const hasDetect = (e.detect?.commands?.length || 0) + (e.detect?.apps?.length || 0) > 0;
    assert.ok(hasDetect, `${e.id}: detect required for installable entries`);
    const hasMethod = e.script || e.brewCask || e.brew || e.npm || e.dmg || e.manual;
    assert.ok(hasMethod, `${e.id}: at least one install method (or manual:true) required`);
  }
});

test("安装目录：brew / npm 包名不含 shell 元字符", () => {
  for (const e of INSTALL_CATALOG) {
    for (const key of ["brew", "brewCask", "npm"]) {
      if (e[key] !== undefined) {
        assert.match(e[key], TOKEN_RE, `${e.id}.${key} must be a plain token`);
        assert.equal(e[key], e[key].trim(), `${e.id}.${key} must not have whitespace`);
      }
    }
  }
});

test("安装目录：官方脚本只允许已知 https 来源", () => {
  for (const e of INSTALL_CATALOG) {
    if (e.script === undefined) continue;
    const ok = SCRIPT_PREFIXES.some((p) => e.script.startsWith(p));
    assert.ok(ok, `${e.id}: script prefix not in whitelist: ${e.script}`);
    assert.ok(e.script.includes("https://"), `${e.id}: script must reference an https source`);
    assert.ok(!e.script.includes("`") && !e.script.includes("\n"), `${e.id}: script must stay on one line without backticks`);
  }
});

test("安装目录：versionFlag 只能是命令行旗标形式", () => {
  for (const e of INSTALL_CATALOG) {
    if (e.versionFlag === undefined) continue;
    assert.match(e.versionFlag, /^-{1,2}[A-Za-z][A-Za-z-]*$/, `${e.id}: versionFlag must look like a CLI flag`);
  }
});

test("安装目录：dmg 条目必须是 https 官方镜像且文件名合法", () => {
  for (const e of INSTALL_CATALOG) {
    if (!e.dmg) continue;
    assert.match(e.dmg.url, /^https:\/\//, `${e.id}: dmg url must be https`);
    assert.match(e.dmg.file || e.id, /\.dmg$/, `${e.id}: dmg file must be a .dmg`);
  }
});

test("安装目录：官网导航条目（linkOnly）不携带安装方式", () => {
  const links = INSTALL_CATALOG.filter((e) => e.linkOnly);
  assert.ok(links.length >= 10, "模型官网导航应覆盖主流大模型厂商");
  for (const e of links) {
    assert.equal(e.kind, "link");
    assert.ok(!e.brew && !e.brewCask && !e.npm && !e.script && !e.dmg, `${e.id}: linkOnly must not install`);
    assert.match(e.homepage, /^https:\/\//);
  }
});

test("新手推荐路径：全部存在于目录且不含官网导航条目", () => {
  assert.ok(STARTER_PATH.length >= 5, "starter path should cover env + agents");
  for (const id of STARTER_PATH) {
    const e = getInstallEntry(id);
    assert.ok(e, `starter id ${id} must exist in catalog`);
    assert.ok(!e.linkOnly, `starter id ${id} must be installable`);
  }
  assert.equal(STARTER_PATH[0], "homebrew", "Homebrew 应排第一");
  for (const must of ["node", "git", "claude-code"]) {
    assert.ok(STARTER_PATH.includes(must), `starter path must include ${must}`);
  }
});

test("反查：agentKey 命中优先，其次按命令回退", () => {
  assert.equal(getInstallEntry("cursor")?.id, "cursor");
  assert.equal(getInstallEntry("no-such-id"), null);
  assert.equal(findInstallIdForAgent("codex", "codex"), "codex");
  assert.equal(findInstallIdForAgent("claude", "claude"), "claude-code");
  // 未配置 agentKey 的条目靠 detect.commands 回退
  assert.equal(findInstallIdForAgent("qwen", "qwen"), "qwen-code");
  assert.equal(findInstallIdForAgent("nope", "nope"), null);
});

test("安装页 UI：新手推荐横条、官网链接卡片与新分组静态合约", () => {
  const html = readFileSync(join(ROOT, "public/index.html"), "utf-8");
  assert.ok(html.includes('id="inst-starter"'), "index.html must host the starter strip");
  assert.ok(html.includes("大模型官网"), "index.html subtitle must mention model sites");

  const js = readFileSync(join(ROOT, "public/js/index.js"), "utf-8");
  assert.ok(js.includes("function renderStarter"), "index.js must render the starter strip");
  assert.ok(js.includes('models:"🌐 热门大模型官网"'), "index.js must declare the models group");
  assert.ok(js.includes('e.method === "link"'), "index.js must render link entries as homepage buttons");
  assert.ok(js.includes("api/install/updates"), "index.js must fetch the updates scan");
  assert.ok(js.includes('data-update'), "index.js must render update buttons on outdated cards");

  const installer = readFileSync(join(ROOT, "public/js/installer.js"), "utf-8");
  assert.ok(installer.includes("action: opts.action"), "installer modal must pass the update action through");

  const css = readFileSync(join(ROOT, "public/css/index.css"), "utf-8");
  assert.ok(css.includes("#inst-starter") && css.includes(".schip"), "index.css must style the starter strip");
  assert.ok(css.includes(".inst-up"), "index.css must style the update button");
});

test("安装弹窗轮询器：归属检查必须有配套登记，否则弹窗卡死在「提交中…」", () => {
  const src = readFileSync(join(ROOT, "public/js/installer.js"), "utf8");
  // 2026-09-24 修复的回归：guard 存在但从未登记 timer，导致每次轮询回调空转
  assert.ok(src.includes("pollTimer = timer;"), "setInterval 后必须把 timer 登记到 pollTimer");
  assert.ok(src.includes("if (pollTimer !== timer) return;"), "await 归属检查应保留");
  assert.ok(src.includes('opts.action === "uninstall" ? "卸载" : "安装"'), "状态文案应区分更新/卸载/安装动词");
});

test("卸载功能 UI：双击确认 + 卸载动词 + 样式的静态合约", () => {
  const js = readFileSync(join(ROOT, "public/js/index.js"), "utf8");
  assert.ok(js.includes("uninstallArmed"), "卸载须有确认状态（防误触）");
  assert.ok(js.includes('action: "uninstall"'), "卸载动作须传给安装弹窗");
  assert.ok(js.includes("确认卸载?"), "首击显示确认文案");
  const installer = readFileSync(join(ROOT, "public/js/installer.js"), "utf8");
  assert.ok(installer.includes('opts.action === "uninstall" ? "卸载"'), "弹窗状态须区分卸载动词");
  const css = readFileSync(join(ROOT, "public/css/index.css"), "utf8");
  assert.ok(css.includes(".inst-del") && css.includes(".inst-del.armed"), "卸载按钮及确认态样式存在");
});

test("控制台↔快捷安装目录对齐：扫描器已知工具都有安装入口", () => {
  // 扫描器 CATALOG 不导出（import 会触发真扫描），从源码提取 id
  const scannerSrc = readFileSync(join(ROOT, "scripts/scan-tools.js"), "utf8");
  const catalogBlock = scannerSrc.slice(scannerSrc.indexOf("const CATALOG = ["), scannerSrc.indexOf("];", scannerSrc.indexOf("const CATALOG = [")));
  const scannerIds = [...catalogBlock.matchAll(/id: "([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(scannerIds.length >= 25, `扫描器目录应有不少于 25 个条目，实际 ${scannerIds.length}`);

  // 扫描器 id → 安装目录 id（命名不同的显式映射，其余要求同名）
  const MAPPING = {
    pi: "pi-agent", brew: "homebrew", lmstudio: "lm-studio", gemini: "gemini-cli",
    qwen: null, // 扫描器未收录 qwen-code，反向不要求
  };
  const missing = [];
  for (const sid of scannerIds) {
    const iid = MAPPING[sid] !== undefined ? MAPPING[sid] : sid;
    if (iid === null) continue;
    if (!getInstallEntry(iid)) missing.push(`${sid}→${iid}`);
  }
  assert.deepEqual(missing, [], `控制台有但快捷安装缺失的条目: ${missing.join(", ")}`);
});

test("集中管理筛选条：已安装/可更新视图与空态提示的静态合约", () => {
  const html = readFileSync(join(ROOT, "public/index.html"), "utf8");
  assert.ok(html.includes('id="inst-filter"'), "index.html 须挂载筛选条容器");
  const js = readFileSync(join(ROOT, "public/js/index.js"), "utf8");
  assert.ok(js.includes("function visibleInstallEntry"), "须有筛选可见性判断");
  assert.ok(js.includes('"installed"') && js.includes('"updates"') && js.includes('"missing"'), "筛选须覆盖已安装/可更新/未安装");
  assert.ok(js.includes("renderInstallFilter"), "须渲染筛选条");
  assert.ok(js.includes("没有需要更新的工具"), "可更新为空时给明确反馈");
  assert.ok(/renderInstallGrid[\s\S]{0,400}visibleInstallEntry/.test(js), "分组渲染必须走筛选");
  const css = readFileSync(join(ROOT, "public/css/index.css"), "utf8");
  assert.ok(css.includes(".ifchip") && css.includes(".ifchip.active"), "筛选 chips 样式存在");
});

test("控制台卡片卸载入口：共用双击确认 + installId 联动的静态合约", () => {
  const js = readFileSync(join(ROOT, "public/js/index.js"), "utf8");
  assert.ok(js.includes("function requestUninstall"), "卸载须有共用入口（安装页/控制台共享确认状态）");
  assert.ok(js.includes("function uninstallableTool"), "控制台卡片须按 installId+canUninstall 判断");
  assert.ok(js.includes("card-del") && js.includes('requestUninstall(t.installId'), "控制台卡片须挂卸载按钮并联动");
  const css = readFileSync(join(ROOT, "public/css/index.css"), "utf8");
  assert.ok(css.includes(".card-del") && css.includes(".card-del.armed"), "控制台卸载按钮样式存在");
});

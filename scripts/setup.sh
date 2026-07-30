#!/usr/bin/env bash
# AI·OPS DECK 一键安装脚本
# 用法：bash scripts/setup.sh   或   npm run setup
set -e

BLUE='\033[1;34m'; GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'; RESET='\033[0m'
say()  { echo -e "${BLUE}▸${RESET} $1"; }
ok()   { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET} $1"; }
err()  { echo -e "${RED}✗${RESET} $1"; }

cd "$(dirname "$0")/.."
ROOT=$(pwd)

echo
echo -e "${BLUE}╭──────────────────────────────────────────╮${RESET}"
echo -e "${BLUE}│   AI·OPS DECK  一键安装 v1               │${RESET}"
echo -e "${BLUE}╰──────────────────────────────────────────╯${RESET}"
echo

# ─────────────────────────── 1. 系统检查 ───────────────────────────
say "检查操作系统…"
UNAME=$(uname)
if [[ "$UNAME" != "Darwin" ]]; then
  err "当前仅支持 macOS（检测到 $UNAME）"
  err "Windows / Linux 支持在 roadmap 中，请等待或提 PR"
  exit 1
fi
ok "macOS $(sw_vers -productVersion)"

# ─────────────────────────── 2. Node.js ───────────────────────────
say "检查 Node.js…"
if ! command -v node >/dev/null 2>&1; then
  err "未检测到 Node.js"
  echo "  推荐用 nvm 安装："
  echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "    nvm install 20 && nvm use 20"
  echo "  或从官网下载：https://nodejs.org/"
  exit 1
fi
NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
if (( NODE_V < 18 )); then
  err "Node.js 版本过低：v$(node -v)，需要 v18+"
  exit 1
fi
ok "Node.js $(node -v)"

# ─────────────────────────── 3. Xcode CLT（编译 node-pty） ───────────────────────────
say "检查 Xcode Command Line Tools（node-pty 需要）…"
if ! xcode-select -p >/dev/null 2>&1; then
  warn "未安装 Xcode CLT，正在触发安装弹窗…"
  xcode-select --install 2>/dev/null || true
  echo "  请在弹出窗口完成安装后，重新运行本脚本。"
  exit 1
fi
ok "Xcode CLT: $(xcode-select -p)"

# ─────────────────────────── 4. 依赖安装 ───────────────────────────
say "安装 npm 依赖（首次会编译 node-pty，约 30-60 秒）…"
if [[ -d node_modules ]] && [[ -f node_modules/.package-lock.json ]]; then
  ok "node_modules 已存在，跳过（如需重装：rm -rf node_modules && npm run setup）"
else
  npm install --no-audit --no-fund
  ok "依赖安装完成"
fi

# ─────────────────────────── 5. 端口检查 ───────────────────────────
say "检查默认端口 3210…"
if lsof -iTCP:3210 -sTCP:LISTEN >/dev/null 2>&1; then
  warn "端口 3210 已被占用。启动时可通过 PORT=xxxx npm start 指定其他端口"
else
  ok "端口 3210 空闲"
fi

# ─────────────────────────── 6. 首次扫描本机工具 ───────────────────────────
say "扫描本机 AI CLI / 桌面 App…"
if node scripts/scan-tools.js >/dev/null 2>&1; then
  TOOL_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('tools.json')).tools.filter(t=>t.installed).length)" 2>/dev/null || echo "?")
  ok "扫描完成，检测到 ${TOOL_COUNT} 个已安装工具（可在页面顶栏 ⟳ 重新扫描）"
else
  warn "扫描出错，可稍后在页面点 ⟳ 重新扫描"
fi

# ─────────────────────────── 完成 ───────────────────────────
echo
echo -e "${GREEN}╭──────────────────────────────────────────╮${RESET}"
echo -e "${GREEN}│  ✓ 安装完成                              │${RESET}"
echo -e "${GREEN}╰──────────────────────────────────────────╯${RESET}"
echo
echo -e "  启动服务：${BLUE}npm start${RESET}"
echo -e "  浏览器打开：${BLUE}http://localhost:3210${RESET}"
echo -e "  首次进入建议点主页的 ${YELLOW}⟳ 重新扫描${RESET} 刷新工具列表"
echo
read -r -p "$(echo -e "${BLUE}▸${RESET} 现在就启动？[Y/n] ")" ANS
ANS=${ANS:-Y}
if [[ "$ANS" =~ ^[Yy]$ ]]; then
  exec npm start
fi

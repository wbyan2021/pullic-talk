// ===== 日志 =====
export function log(...args) {
  console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}]`, ...args);
}

// ===== 全局子进程注册表（用于优雅关闭） =====
export const activeProcs = new Set();

// ===== 后台进程注册表（用于 command 类型启动 + 可查询/终止） =====
export const bgProcs = new Map(); // id -> { id, command, pid, startedAt, proc }
export let bgSeq = 1;
export function nextBgId() { return `bg${bgSeq++}`; }

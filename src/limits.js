// ===== 安全与资源限制 =====
export const LIMITS = {
  messageMaxLen: 8000,      // 单条用户消息最大字符数
  historyMaxItems: 20,      // 参与拼接的历史最多条数
  historyItemMaxLen: 4000,  // 单条历史最大字符数
  historyTotalMaxLen: 16000,// 历史部分总字符数上限
  promptMaxLen: 32000,      // 最终 prompt 上限（防 argv 过长 E2BIG / token 爆炸）
  procTimeoutMs: 180000,    // 子进程默认超时（3 分钟），可在 agent 配置 cli.timeoutMs 覆盖
  maxTargets: 8,
  maxRounds: 5,             // 多轮讨论最大轮数
};

export const VALID_THINKING = new Set(["off", "low", "medium", "high", "max"]);
export const VALID_MODES = new Set(["parallel", "collaborate"]);

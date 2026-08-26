## [ERR-20260826-001] temporary-output-cleanup

**Logged**: 2026-08-26T16:13:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
安全策略拒绝了包含 `rm -f` 的临时输出清理命令。

### Error
```text
exec_command rejected: rm -f style commands are not permitted
```

### Context
- 页面级只读检查后，尝试把健康检查响应写入临时文件并清理。
- 该清理不是项目操作，也未改变工作区。

### Suggested Fix
直接把健康检查响应输出到终端，或使用受控的临时目录生命周期，避免在命令中使用被策略拦截的删除模式。

### Metadata
- Reproducible: yes
- Related Files: none

### Resolution
- **Resolved**: 2026-08-26T16:13:00+08:00
- **Notes**: 改用不落盘的 `curl` 检查；健康接口 HTTP 200、未授权恢复接口 HTTP 401。

---

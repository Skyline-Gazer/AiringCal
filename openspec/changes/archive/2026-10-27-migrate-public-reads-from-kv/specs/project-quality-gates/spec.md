## ADDED Requirements

### Requirement: 公开读取切换必须有影子门禁
自动与生产验收 MUST 验证连续 7 次 shadow 一致、KV 预算达标、R2 pointer 校验与旧 KV fallback 后才允许切换。

#### Scenario: shadow streak 不足
- **WHEN** 只有 6 次连续一致结果
- **THEN** 切换操作被拒绝且公开读取仍使用旧 KV

### Requirement: 迁移和回滚必须可演练
质量门禁 MUST 覆盖批次中断续跑、重复导入、缺失 legacy key、pointer 回滚和限速清理。

#### Scenario: 新读取切换后回滚
- **WHEN** 运维恢复上一已验证 generation 或旧读取策略
- **THEN** API 继续满足既有契约且不需要回滚 D1 行

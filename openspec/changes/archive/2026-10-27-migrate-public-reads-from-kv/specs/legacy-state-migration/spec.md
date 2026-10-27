## ADDED Requirements

### Requirement: legacy metadata 迁移必须可恢复且幂等
系统 MUST 按当前收藏 subject 集合每批最多 50 个读取 legacy detail/meta/image/refresh KV，并在 D1 保存游标与计数；已有更新 D1 状态不得被覆盖。

#### Scenario: 迁移在第三批中断
- **WHEN** runner 在部分批次完成后重启
- **THEN** 系统从持久化游标继续且已导入 subject 不重复覆盖

### Requirement: shadow 一致必须连续七次
系统 MUST 对规范化旧公开结果与 R2 snapshot 执行逐字段比较，只有连续 7 次每日成功且 KV 预算达标才允许切换。

#### Scenario: 第六次出现 calendar 差异
- **WHEN** shadow 连续成功六次后发现 calendar 不一致
- **THEN** 连续成功计数重置且公开读取保持旧 KV

### Requirement: legacy 清理必须延迟且限速
切换成功后系统 MUST 保持 legacy KV 只读至少 14 天，之后每天最多删除 100 个旧逐 subject key。

#### Scenario: 切换后第十天
- **WHEN** 清理任务运行
- **THEN** 系统删除零个 legacy key

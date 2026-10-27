## ADDED Requirements

### Requirement: D1 必须保存可变权威状态
系统 MUST 在 D1 保存收藏、subject media、sync run、每日预算与 app state，且 KV 不得继续作为这些状态的新写入权威来源。

#### Scenario: 首次成功全量同步
- **WHEN** D1 尚无收藏且 bgm.tv 返回完整 collections
- **THEN** 系统写入规范 collection rows、稳定 content hash 与 hot/cold temperature

### Requirement: 收藏 diff 必须忽略运行字段
系统 MUST 仅对影响公开业务结果的规范字段计算 content hash；generation、同步时间与 heartbeat 不得造成内容变化。

#### Scenario: 连续两日业务内容相同
- **WHEN** 第二日上游返回相同业务字段但同步时间不同
- **THEN** collection_items 产生零行更新

### Requirement: 删除必须经过两次成功读取确认
系统 MUST 在第一次完整读取缺失时记录 missing state，只有下一次完整读取仍缺失时才确认删除；分页失败不得推进删除状态。

#### Scenario: 上游暂时漏页
- **WHEN** 一轮 collection 分页最终失败
- **THEN** 系统不新增 missing 标记也不确认任何删除

### Requirement: QoS 预算必须原子预留
系统 MUST 在 D1 中按日期与资源原子预留、消费每日预算，并在不足时延后低优先级工作。

#### Scenario: 两个 consumer 并发申请最后一个名额
- **WHEN** 两个请求同时申请只剩一个的媒体预算
- **THEN** 恰好一个申请成功且总消费不超过 hard limit

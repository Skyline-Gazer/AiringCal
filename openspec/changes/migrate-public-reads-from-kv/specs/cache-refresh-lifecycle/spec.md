## ADDED Requirements

### Requirement: legacy 媒体状态只能作为兼容输入
迁移期间系统 MUST 允许读取 legacy detail/meta/image 状态补充尚未导入的 subject，但新媒体结果只能写入 D1。

#### Scenario: D1 尚无 subject media
- **WHEN** shadow snapshot 构建遇到仅存在于 legacy KV 的已缓存图片引用
- **THEN** 系统可使用该引用生成候选并安排迁移，不覆盖或重写 legacy key

### Requirement: 迁移不得复制图片二进制
系统 MUST 复用 legacy metadata 中现有 `airing-cal-images` R2 key，不得因状态迁移重新下载或复制图片。

#### Scenario: legacy 图片对象有效
- **WHEN** metadata 指向现有 common 和 large R2 key
- **THEN** D1 导入保存相同引用且 R2 PUT 为零

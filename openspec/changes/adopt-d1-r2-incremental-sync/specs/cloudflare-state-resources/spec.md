## ADDED Requirements

### Requirement: 状态资源必须可重复 bootstrap
手动 bootstrap MUST 创建或复用 D1 `airing-cal-state`、R2 `airing-cal-data`、现有图片桶、KV 与 Queue，并返回稳定资源标识。

#### Scenario: 资源已经存在
- **WHEN** 运维再次运行 bootstrap workflow
- **THEN** 系统复用现有资源且不创建同名副本

### Requirement: D1 migration 必须先于 Worker 发布
部署流程 MUST 在 read、media、sync Worker 使用新 binding 前解析 D1 ID 并成功应用 repository migration。

#### Scenario: D1 migration 失败
- **WHEN** migration 命令返回失败
- **THEN** 任一 Worker 上传均不得开始

### Requirement: 缺失资源必须在上传前失败
resource resolve MUST 在任何 deploy 前验证 D1、数据 R2、图片 R2、KV 与 Queue 存在。

#### Scenario: 数据 R2 bucket 尚未 bootstrap
- **WHEN** 自动部署解析不到 `airing-cal-data`
- **THEN** workflow 失败并提示先运行手动 bootstrap

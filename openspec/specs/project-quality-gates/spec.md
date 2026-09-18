# project-quality-gates Specification

## Purpose
TBD - created by archiving change restore-project-quality-gates. Update Purpose after archive.
## Requirements
### Requirement: 包管理器必须唯一
仓库 MUST 使用 pnpm 及其锁文件作为唯一依赖来源，CI MUST 使用 frozen lockfile。

#### Scenario: npm lockfile 被加入仓库
- **WHEN** 质量检查发现 `package-lock.json`
- **THEN** 检查失败并提示使用 pnpm 更新依赖

### Requirement: 高风险逻辑必须有自动检查
完整输入、删除保护、PostgreSQL transaction/advisory lock、R2 幂等发布、manifest 验证、备份恢复、飞书脱敏、容器加固、公开输出编码、严格查询参数和管理写入 MUST 有可运行自动测试。

#### Scenario: Workflow enqueue 被重放
- **WHEN** 测试对相同 content hash 重放 publication
- **THEN** 不增加 generation、不重复上传 snapshot 且 manifest 保持不变

#### Scenario: 恶意数据进入公开 HTML
- **WHEN** 测试注入脚本标签、事件属性和 pre 结束标签
- **THEN** 输出不可执行且安全响应头完整

### Requirement: 类型和 Worker bundle 必须可验证
每次部署前 MUST 完成 TypeScript typecheck、自动测试、Read Worker Wrangler dry-run、production/debug image build 和 Compose config 校验；生产 image 内容与运行身份 MUST 通过自动审计。

#### Scenario: Workflow binding 与 class 漂移
- **WHEN** 生成的 Worker bundle 与声明的 binding 或 class 不一致
- **THEN** 部署前校验失败且不得发布产物

#### Scenario: debug 工具进入 production image
- **WHEN** production image 包含仅允许在 debug target 的 package
- **THEN** CI 失败且不得推送 production SHA tag

### Requirement: 声明能力必须可运行
README、架构文档、配置和代码中声明的外部能力 MUST 有完整运行路径；无法端到端工作的能力 MUST 被删除或明确标记为未提供。

#### Scenario: R2 图片链路没有生产者
- **WHEN** 同步流程不写入图片而前端仍依赖 R2 hash
- **THEN** 质量验收失败，必须恢复完整管线或删除该能力

### Requirement: CI 工具版本必须可复现
仓库依赖与 pnpm MUST 使用已声明版本；浮动 `node:alpine` 构建 MUST 记录实际 Node、Alpine 和 base digest，GHCR SHA tag MUST 不可覆盖。

#### Scenario: 新版 pnpm 发布
- **WHEN** CI 解析到不同 base digest
- **THEN** 构建元数据记录差异且旧 git-SHA image 不被覆盖

### Requirement: 文档必须通过实现核对
README、技术设计和 runbook MUST 与 VPS cron、Compose SHA、PostgreSQL migrations、R2 manifest/backup、飞书通知、Cloudflare read bindings 和当前切流阶段一致，不得把未启用的未来路径描述为已上线。

#### Scenario: Free Plan 定时触发已激活
- **WHEN** VPS 切流已完成且文档审计发现旧声明
- **THEN** 发版门禁失败直到文档与运行状态一致

### Requirement: 部署不得等待业务同步
CI/CD MUST 构建、测试并发布代码/image，但不得连接生产数据库、触发正式同步、修改 R2 manifest 或等待业务数据收敛。

#### Scenario: 内部 Worker 部署完成
- **WHEN** image push 成功
- **THEN** workflow 结束且 VPS 继续运行人工批准的既有 SHA

### Requirement: 自动部署必须串行且来源唯一
自动 deploy MUST 只监听 `dev`，并使用不取消当前运行的全局 concurrency；手动 deploy MUST 显式解析所选 ref。

#### Scenario: 连续推送多个原子提交
- **WHEN** 当前部署运行中又有多个 dev push 到达
- **THEN** 当前部署完成且 pending 只保留最新一次，不出现 dev/main 并行竞争同一 Worker

#### Scenario: 手动 ref 未进入 dev
- **WHEN** 手动部署 ref 解析出的完整 SHA 不是 `origin/dev` 的 ancestor
- **THEN** 无 secrets 的 ref 解析 job 拒绝部署，后续 production job 不启动

#### Scenario: dev 在部署期间前进
- **WHEN** resolve job 完成后 `dev` 又产生新提交
- **THEN** 所有后续 job 仍 checkout 同一解析 SHA，footer SHA 与实际部署 revision 一致

### Requirement: 部署前必须完成 Cron 配额预检
部署 workflow MUST 在任何 Worker 上传前核对目标账号 Cron trigger 配额；不足时不得产生部分部署。

#### Scenario: Cron 已达上限且目标无 trigger
- **WHEN** 账号已有 5 个 Cron trigger 且目标 Worker 尚无 trigger
- **THEN** workflow 在任何 deploy 命令前失败并报告配额原因

### Requirement: 回退步骤必须可执行且保留 Durable Object migration
runbook MUST 记录以不可变 GHCR SHA、上一 R2 manifest 和 legacy read mode 回退的流程；回退不得 reverse PostgreSQL migration 或删除 PostgreSQL/R2/Cloudflare 数据。

#### Scenario: live generation 异常
- **WHEN** 运维决定回退公开读取
- **THEN** 恢复上一已验证 manifest 或 legacy mode，并保留新数据库行和 snapshot 供调查

### Requirement: 公开缓存读取必须有界
公开 cache API MUST 使用 cursor pagination、限制 `limit <= 100`，calendar hydration MUST 使用有界并发且不得单次展开全部 KV key。

#### Scenario: 请求过大 limit
- **WHEN** 客户端请求 limit 大于 100
- **THEN** API 拒绝或收敛到上限且不会扫描全部缓存

### Requirement: 资产生成链路必须防止副本漂移
质量门禁 MUST 验证 Widget 主题源码、生成产物和部署入口一致，并拒绝已删除的手工副本重新出现。

#### Scenario: 旧 Widget 副本被重新加入
- **WHEN** `assets/public` 或 `theme/v1` 再次包含部署资产副本
- **THEN** 自动检查失败并指向唯一源码链路

### Requirement: 写放大必须有自动回归门禁
质量门禁 MUST 验证大批量未变化 subject 不产生逐 subject PostgreSQL UPDATE、图片 PUT 或新 snapshot/manifest。

#### Scenario: 659 个稳定 subject 回归样例
- **WHEN** 测试运行完整每日同步且所有内容未变化、未到刷新时间
- **THEN** 仅允许 run/backup/notification 状态变化，业务行与公开 manifest 无写入


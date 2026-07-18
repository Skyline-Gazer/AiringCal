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
合并、primary 失败保护、管理鉴权、同步输入验证、Workflow 幂等发布、Queue 去重、部署业务解耦、公开输出编码、严格查询参数、章节分页/分批与 404 tombstone MUST 有可运行的自动测试。

#### Scenario: Workflow enqueue 被重放
- **WHEN** 测试重复执行相同 enqueue step
- **THEN** 测试验证相同 `job_id` 不会产生重复媒体副作用

#### Scenario: 恶意数据进入公开 HTML
- **WHEN** 测试注入脚本标签、事件属性和 pre 结束标签
- **THEN** 测试验证输出不可执行且安全响应头完整

### Requirement: 类型和 Worker bundle 必须可验证
每次部署前 MUST 完成 TypeScript 类型检查、自动测试和 Wrangler dry-run；部署 Workflow 后 MUST 检查其 Cloudflare 控制面注册状态。

#### Scenario: Workflow binding 与 class 漂移
- **WHEN** 配置引用不存在的 Workflow class 或 binding
- **THEN** 类型、bundle 或控制面检查失败且 frontend 不继续部署

### Requirement: 声明能力必须可运行
README、架构文档、配置和代码中声明的外部能力 MUST 有完整运行路径；无法端到端工作的能力 MUST 被删除或明确标记为未提供。

#### Scenario: R2 图片链路没有生产者
- **WHEN** 同步流程不写入图片而前端仍依赖 R2 hash
- **THEN** 质量验收失败，必须恢复完整管线或删除该能力

### Requirement: CI 工具版本必须可复现
CI MUST 使用仓库声明的包管理器和依赖版本，不得用浮动 latest 替代锁文件。

#### Scenario: 新版 pnpm 发布
- **WHEN** 上游发布新的 pnpm 版本
- **THEN** 未修改仓库配置的部署仍使用已声明版本

### Requirement: 文档必须通过实现核对
README 和技术设计 MUST 与当前路由、绑定、同步行为、Workflow 运维命令及部署流程一致，且不得声明 Free Plan 未启用的原生 Workflow schedule 或已删除的 trigger queue。

#### Scenario: Free Plan 定时触发已激活
- **WHEN** 生产 shadow 已通过且 Worker Cron 桥接完成切换
- **THEN** 文档明确 `0 */4 * * *` 只创建 live Workflow instance，且不再声明旧业务 Cron、trigger queue、原生 Workflow schedule 或 post-deploy sync

### Requirement: 部署不得等待业务同步
CI/CD MUST 只部署代码、解析既有资源并验证控制面，不得触发 full sync、轮询业务 KV 或等待媒体缓存收敛。

#### Scenario: 内部 Worker 部署完成
- **WHEN** read、media、sync Worker 与 Workflow 成功部署并通过控制面检查
- **THEN** frontend 部署立即继续且不读取 `sync:meta.synced_at`

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
README MUST 记录基于不可变 `dev` ancestor SHA 的正式回退流程；回退不得自动删除 Durable Object migration，旧代码必须保持新 binding/class 可加载。

#### Scenario: live generation 异常
- **WHEN** 运维需要回退到稳定 SHA
- **THEN** runbook 指导先暂停 Cron 与 terminate 异常 Workflow，再部署并验证 binding、migration、health 与 active generation 后恢复 Cron

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


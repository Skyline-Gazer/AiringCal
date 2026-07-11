## MODIFIED Requirements

### Requirement: 高风险逻辑必须有自动检查
合并、primary 失败保护、管理鉴权、同步输入验证、Workflow 幂等发布、Queue 去重与部署业务解耦 MUST 有可运行的自动测试。

#### Scenario: Workflow enqueue 被重放
- **WHEN** 测试重复执行相同 enqueue step
- **THEN** 测试验证相同 `job_id` 不会产生重复媒体副作用

### Requirement: 类型和 Worker bundle 必须可验证
每次部署前 MUST 完成 TypeScript 类型检查、自动测试和 Wrangler dry-run；部署 Workflow 后 MUST 检查其 Cloudflare 控制面注册状态。

#### Scenario: Workflow binding 与 class 漂移
- **WHEN** 配置引用不存在的 Workflow class 或 binding
- **THEN** 类型、bundle 或控制面检查失败且 frontend 不继续部署

### Requirement: 文档必须通过实现核对
README 和技术设计 MUST 与当前路由、绑定、同步行为、Workflow 运维命令及部署流程一致，且不得声明 Free Plan 未启用的原生 Workflow schedule 或已删除的 trigger queue。

#### Scenario: Free Plan 定时触发已激活
- **WHEN** 生产 shadow 已通过且 Worker Cron 桥接完成切换
- **THEN** 文档明确 `0 */4 * * *` 只创建 live Workflow instance，且不再声明旧业务 Cron、trigger queue、原生 Workflow schedule 或 post-deploy sync

## ADDED Requirements

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

### Requirement: 公开缓存读取必须有界
公开 cache API MUST 使用 cursor pagination、限制 `limit <= 100`，calendar hydration MUST 使用有界并发且不得单次展开全部 KV key。

#### Scenario: 请求过大 limit
- **WHEN** 客户端请求 limit 大于 100
- **THEN** API 拒绝或收敛到上限且不会扫描全部缓存

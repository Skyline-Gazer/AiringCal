## 1. 解除部署与业务同步耦合

- [x] 1.1 先更新部署配置测试，要求仅 `dev` 自动部署、全局 concurrency、job timeout、无 post-deploy sync/KV polling
- [x] 1.2 拆分 `ci.yml` 与 `deploy.yml`，删除缓存刷新 job，并让 frontend 只依赖内部 Worker 部署；Workflow 注册后再增加控制面检查
- [x] 1.3 将 Cloudflare 资源创建迁移到手动 bootstrap workflow，常规部署只解析既有资源且 API 请求有 15 秒 timeout
- [x] 1.4 同步部署文档并运行部署配置测试、typecheck、build check 后原子 commit/push

## 2. 约束 bgm.tv 请求与账号 apply

- [x] 2.1 先为 GET timeout、两次有限重试、Retry-After、写请求不重试和 549 条收藏 11 页补失败测试
- [x] 2.2 实现 `BgmClient` GET 10 秒 timeout、可重试错误分类和 `fetchAllCollections` 50 条分页/120 秒总预算
- [x] 2.3 先为 apply items 上限、旧 subject_ids 兼容、零 collections 重拉与 no-store/脱敏日志补失败测试
- [x] 2.4 实现 compare items 直接 apply、最多 5 条、一个版本的旧输入兼容和 operation log 终态更新
- [x] 2.5 同步账号 API 文档并运行 bgm-api/frontend-worker 测试后原子 commit/push

## 3. 建立缓存刷新生命周期

- [ ] 3.1 先为 Workflow run/staging/shadow key、`subject:refresh` 状态和 6～8 天确定性刷新窗口补失败测试
- [ ] 3.2 在 storage/domain 中实现兼容 key、`SyncRun`、refresh 状态、`MediaRefreshJobV2` 与 SWR 判断
- [ ] 3.3 先为 Media consumer job 去重、单消息、瞬态 delay retry、404/missing source 终态 ack 补失败测试
- [ ] 3.4 实现 Media consumer V2 幂等处理与 refresh/image 状态分离，并兼容旧消息过渡
- [ ] 3.5 将 Media Queue 配置改为 batch 1、timeout 5、concurrency 4、retries 3，更新文档并原子 commit/push

## 4. 实现 shadow Workflow 编排

- [ ] 4.1 建立 fake Workflow step 测试，覆盖确定性 step 名、step 小输出、401/403 不重试、429/5xx/timeout 重试
- [ ] 4.2 补充 100 个同时到期 subject 的 25 条规划分组、sendBatch 上限、重复 enqueue job_id 去重测试
- [ ] 4.3 实现 `SyncWorkflow` initialize、收藏分页、calendar staging 与运行状态/heartbeat
- [ ] 4.4 实现五类收藏/calendar 的 shadow/live 发布与失败保留旧 snapshot
- [ ] 4.5 实现 refresh plan/enqueue/finalize，确保 Workflow 不调用 subject detail API
- [ ] 4.6 在 Wrangler 配置注册无 schedule 的 Workflow binding，生成并核对 Worker 类型
- [ ] 4.7 更新 Workflow 架构、key、状态与手动 shadow 运维文档，完整验证后原子 commit/push

## 5. 收敛读取 API 与健康状态

- [ ] 5.1 先为 `/api/health` 最近 instance/stale 状态和 `/api/cache` cursor/limit/有界 hydration 补失败测试
- [ ] 5.2 实现健康 API 的 Workflow 摘要与 20 分钟 stale 判定
- [ ] 5.3 实现 cache cursor pagination、`limit <= 100` 和 calendar 有界 hydration
- [ ] 5.4 更新 endpoint 文档并运行 read/frontend 测试后原子 commit/push

## 6. Shadow 生产验证与 schedule 切换

- [ ] 6.1 使用已验证的 Wrangler CLI 显式创建生产 shadow instance 并核对 instance、step、retry、输出与正式 key 隔离
- [ ] 6.2 修复 shadow 发现的问题并重新执行全量 typecheck/test/build/diff-check
- [ ] 6.3 启用 `0 */4 * * *` Workflow schedule 并同时删除旧 Worker Cron，更新运行与回退文档后原子 commit/push
- [ ] 6.4 观察至少一个完整 live instance，确认正式 snapshot 更新、media backlog 异步收敛且无永久 running

## 7. 移除旧触发路径并完成发版

- [ ] 7.1 先更新测试要求不存在 sync trigger queue、旧 queue handler、consumer 自动修复和 `push-sync-trigger.mjs`
- [ ] 7.2 删除 `airing-cal-sync-trigger` 配置、旧 queue handler 与触发脚本，并更新 bootstrap/资源文档
- [ ] 7.3 审计 README、endpoint、环境变量、Worker、Workflow、日志事件、配置与发版文档，删除未实现或过时声明
- [ ] 7.4 运行 `pnpm typecheck`、`pnpm test`、`pnpm build:check`、`git diff --check` 与本地 Workflow smoke test
- [ ] 7.5 核对生产控制面与健康 API，提交并 push 最终发版原子提交

## 1. 安全渲染与 Token 生命周期

- [ ] 1.1 为恶意标题、用户名、weekday、错误、属性值和 operation `</pre><script>` 增加 RED 回归测试
- [ ] 1.2 实现统一 HTML/属性编码与数值/枚举验证，移除 inline handler 并保护外链
- [ ] 1.3 删除 sessionStorage Token 持久化并在页面初始化清除历史 `sync-tokenA/B`
- [ ] 1.4 增加 CSP、nosniff、frame/base 限制并验证 JSON operation check 契约不变

## 2. Read API 严格契约

- [ ] 2.1 增加零收藏 health 仍返回完整 data 的 RED 测试并修复提前返回
- [ ] 2.2 增加 `page=2junk`、未知 type、非法 limit/cursor 的 RED 测试并实现完整字符串校验与 400
- [ ] 2.3 将 cache 当前页计数改为 `page_subjects`，保持 cursor 兼容并更新 README

## 3. bgm.tv 章节同步与认证错误

- [ ] 3.1 对照 `docs/example/api/bgm-api.json` 验证章节读取和 PATCH 接口字段、limit 与 payload
- [ ] 3.2 增加 1001+ 章节收藏分页 RED 测试并实现 `limit=1000` offset 循环
- [ ] 3.3 增加每批最多 100 ID 和第二批失败 RED 测试，实现分批 PATCH 与 partial/error 汇总
- [ ] 3.4 增加单/双账户无效 Token compare RED 测试，返回稳定非 200 认证错误

## 4. Subject 404 tombstone

- [ ] 4.1 增加已有 detail 后刷新 404、TTL 内不重复请求的 RED 测试
- [ ] 4.2 定义 tombstone 类型、key/TTL 与保守 NSFW 投影，404 时停止返回旧 detail
- [ ] 4.3 验证 tombstone 到期后允许重新探测且 generation 协调语义不倒退

## 5. Widget 资产唯一来源

- [ ] 5.1 使用 `rg` 与构建入口证明旧 `assets/public`、`theme/v1` 副本无部署消费者
- [ ] 5.2 删除旧副本并增加源码、生成产物、部署入口一致性测试
- [ ] 5.3 更新 README 与生成说明，明确 `assets/theme` 和 `generated-assets.ts` 唯一链路

## 6. 验证、审查与交付

- [ ] 6.1 运行相关包 RED→GREEN 测试、typecheck、Wrangler dry-run 与 diff check，并按安全/API/缓存边界原子 commit/push
- [ ] 6.2 运行全量 `pnpm test`、`pnpm typecheck`、`pnpm build:check`、OpenSpec strict、`git diff --check` 与 `pnpm audit --prod`
- [ ] 6.3 完成 thorough code review，修复全部 P0/P1/P2 并记录验证报告

Verify/archive follow-up（由 Comet 后续阶段验收，不作为 build guard checkbox）：

- 6.4 以 dev 不可变 SHA 部署，验证公开安全头、恶意 payload、health/cache/compare/tombstone 行为与 footer SHA
- 6.5 创建 PR、等待检查、合并并归档 change

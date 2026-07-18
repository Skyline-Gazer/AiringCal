# Brainstorm Summary

- Change: remediate-full-repository-audit
- Date: 2026-07-14

## 确认的技术方案

- 剩余审计问题保持单一 change，不重复已归档的 Durable Object、snapshot 或部署 revision 修复。
- subject detail 404 tombstone TTL 为 24 小时；TTL 内停止返回旧 detail 且不重复请求，到期允许重新探测。
- 用户 Token 仅保留当前页面内存，刷新后重新输入。
- 保持现有公开 endpoint 路径和 Cloudflare Free Plan，不引入外部数据库。
- Widget 安全渲染采用混合方案：静态控件与事件绑定使用 DOM API；批量卡片模板保留受控 `innerHTML`，所有动态文本、属性、URL、枚举和数值按上下文编码或验证。
- 架构数据流已确认：Widget/Frontend 安全边界、Read 严格 parser、bgm.tv 完整分页与分批、Media 24 小时 tombstone、资产单向生成链路。

## 关键取舍与风险

- 24 小时 tombstone 在抑制重复请求与发现条目恢复之间取中间值。
- Widget 是大型现有脚本，全面改写 DOM 结构可能扩大回归面；仅补 escape 又可能遗漏上下文。
- 严格 query parser 会把旧客户端的宽松输入改为 400，但 endpoint 和合法 cursor 保持兼容。
- 章节 PATCH 允许 partial/error 汇总，不再把部分成功伪装为完整成功。
- 网络或 5xx 不得写 not_found tombstone，继续沿用 stale-on-error。

## 测试策略

- 所有修复遵循 RED→GREEN；恶意 payload、严格参数、1001+ 章节、部分 PATCH、认证失败和 tombstone 时钟均有独立回归。
- 定向测试后运行全量 test/typecheck/build/OpenSpec/diff/audit、thorough review 和生产不可变 SHA 验收。

## Spec Patch

- tombstone TTL 明确为 24 小时。
- 网络/5xx 不得写 not_found tombstone。
- 章节分页在空页且累计未达到 total 时必须报错，避免无限循环。
- 动态 URL 必须限制允许协议或站内相对路径，不能仅做 HTML 编码。

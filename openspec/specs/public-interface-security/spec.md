# public-interface-security Specification

## Purpose
TBD - created by archiving change remediate-full-repository-audit. Update Purpose after archive.
## Requirements
### Requirement: 公开 HTML 必须按上下文编码不可信数据
系统 MUST 对标题、用户名、weekday、错误、JSON 文本和属性值使用与输出上下文匹配的编码，禁止未经处理的数据形成可执行 HTML。

#### Scenario: 恶意标题与错误进入页面
- **WHEN** API 数据包含 `<img onerror>`、引号属性注入或 `</pre><script>`
- **THEN** 响应只显示文本且不得包含可执行 payload

#### Scenario: 动态 URL 使用危险协议
- **WHEN** API 数据或配置提供 `javascript:` 等非允许协议 URL
- **THEN** 系统拒绝该 URL 或回退安全值，不得仅做 HTML 编码后输出

### Requirement: 浏览器 Token 不得持久化
同步 Token MUST 仅保存在当前页面内存，页面初始化 MUST 清除历史 `sync-tokenA` 与 `sync-tokenB` sessionStorage 项。

#### Scenario: 页面刷新
- **WHEN** 用户刷新同步页面
- **THEN** 页面没有可恢复 Token 且要求重新输入

### Requirement: 公开 HTML 必须使用严格浏览器安全策略
HTML 响应 MUST 禁止 inline event handler，设置 CSP、`X-Content-Type-Options: nosniff`、frame/base 限制，并为外链设置 `rel="noopener noreferrer"`。

#### Scenario: 加载 Widget 或 operation 页面
- **WHEN** 浏览器请求公开 HTML
- **THEN** 响应头和链接属性阻止脚本注入、嗅探、嵌套与 opener 访问

### Requirement: Widget 资产必须有唯一来源
仓库 MUST 只以 `assets/theme` 作为手写 Widget 源码、`generated-assets.ts` 作为生成产物，不得保留未部署且手工同步的副本。

#### Scenario: 生成资产漂移
- **WHEN** 生成产物与主题源码不一致或旧副本重新出现
- **THEN** build check 失败


# Task 5 Report — secure-management-api

## 结论

- 已完成 README 文档修订并提交。
- 提交哈希：`fe7a4f5886c0fa7406870558bdceb409157b0409`
- 仅修改并提交了 `README.md`。
- 现存的 `openspec/changes/secure-management-api/.comet/subagent-progress.md` 修改与 `openspec/changes/secure-management-api/.comet/task-4-report.md` 未处理、未提交，保持原样。

## RED：旧的不安全文案扫描

先执行：

```bash
rg -n "MANAGE_SECRET.*可选|未配置则放行|管理页密码保护（推荐）|强烈建议配置" README.md
```

结果（修订前）：

- `README.md:52` → ``MANAGE_SECRET`` 仍写为“可选。管理页写操作密码，强烈建议配置”
- `README.md:138` → 仍包含“管理页密码保护（推荐）”与“未配置则放行”
- `README.md:161` → `.dev.vars` 示例中 `MANAGE_SECRET=可选的管理密码`
- `README.md:181` → 环境变量表中 `MANAGE_SECRET` 仍写为“可选”

## GREEN：README 最小修订

只修改了 `README.md`，完成这些文案收敛：

- `MANAGE_SECRET` 在阶段一 secrets 表中改为必填，并注明管理 API 未配置时返回 503。
- 管理页面说明补充：密码只保存在当前页面内存，刷新后需要重输。
- cron OAuth 说明补充：浏览器只看到成功状态，`access_token` / `refresh_token` 由 Worker 写入 `bgm:tokens`。
- 删除旧的“推荐/可选/未配置则放行”说法。
- `.dev.vars` 示例把 `MANAGE_SECRET` 改成 `本地管理密码`，不再标可选。
- 环境变量表把 `MANAGE_SECRET` 改为必填 secret，并说明未配置时管理 API 返回 503。
- 增加迁移与回滚说明：先配 secret，再部署，再验证 cron OAuth；回滚代码时保留 `MANAGE_SECRET` 和 `bgm:tokens`。

已提交：

```bash
git add README.md
git commit -m "docs: document secure management deployment"
```

提交结果：

- `fe7a4f5886c0fa7406870558bdceb409157b0409`

## 验证命令与结果

1. 旧文案扫描：

```bash
rg -n "MANAGE_SECRET.*可选|未配置则放行|管理页密码保护（推荐）|强烈建议配置" README.md
```

- 结果：无匹配，退出码 1。

2. Node 测试：

```bash
node --test packages/worker/src/manage/security.test.ts packages/worker/src/manage/index-html.test.mjs
```

- 结果：49 项测试全部通过，退出码 0。

3. OpenSpec 校验：

```bash
OPENSPEC_TELEMETRY=0 /Users/ian/Desktop/Projects/BangumiTV/node_modules/.bin/openspec validate secure-management-api --strict
```

- 结果：`Change 'secure-management-api' is valid`，退出码 0。

4. Wrangler dry-run：

```bash
WRANGLER_LOG_PATH=/tmp/bangumitv-secure-management-task5.log ./packages/worker/node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/bangumitv-secure-management-task5 --config packages/worker/wrangler.toml
```

- 结果：输出 `Total Upload: 134.57 KiB / gzip: 34.74 KiB`，`--dry-run: exiting now.`，退出码 0。

5. Diff 检查：

```bash
git diff --check
```

- 结果：无输出，退出码 0。

6. 敏感模式扫描：

```bash
rg -n "sessionStorage|bgm-manage-secret|postMessage\\([^)]*,\\s*[\"']\\*[\"']|/api/manage/exchange\\?|/api/manage/gate|last_error:|users:" packages/worker/src README.md
```

- 结果：命中仅来自测试文件里的断言：
  - `packages/worker/src/manage/index-html.test.mjs:278`
  - `packages/worker/src/manage/security.test.ts:347`
  - `packages/worker/src/manage/security.test.ts:415`
- 这些不是运行时代码；实际源码与 README 未发现对应敏感模式。

7. HTML 内联写入扫描：

```bash
rg -n "\\.innerHTML\\s*=" packages/worker/src/manage/index.html
```

- 结果：无匹配，退出码 1。

## 自审

- 只改了 `README.md`，没有触碰源码、`package.json`、锁文件、plan、OpenSpec tasks 或 `.comet` 里的现存文件。
- `git diff --check` 干净。
- Node 测试、OpenSpec 校验、Wrangler dry-run 都通过。
- `rg` 敏感模式扫描的命中仅在测试断言中，不是产品代码。
- 由于用户额外要求“仅修改 README.md”，未修改 `openspec/changes/secure-management-api/tasks.md`，也未执行任何可能扩展范围的源码更改。

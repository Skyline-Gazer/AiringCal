# Task 7.1 报告：Alpine production/debug 镜像

## 状态

DONE_WITH_CONCERNS — Dockerfile、`.dockerignore`、静态 verifier 与 `@airing-cal/vps-sync` 的 `start` script 已实现；本机没有 Docker CLI，无法直接执行目标镜像 inspect/APK/build 或运行时 user/port 检查，因此不宣称镜像构建通过。

## 实现

- `Dockerfile.vps-sync` 使用 `node:alpine` 的 dependencies → build → runtime-compile → production → debug 多阶段流程；build 通过 `pnpm -F @airing-cal/vps-sync build` 编译应用，使用 `pnpm --filter @airing-cal/vps-sync deploy --prod /prod` 生成 production dependencies。
- production 只拷贝 `apps/vps-sync/dist/`、部署后的 production `node_modules` 与已编译的 workspace runtime packages；安装 `ca-certificates`、`postgresql17-client`，以非 root `node` 用户执行 `node dist/cli.js`，不声明 `EXPOSE`。
- production 在拷贝 deployed `node_modules` 后清理版本化 `.pnpm/@airing-cal+*` workspace store payload，并在 runtime package copy 后对 workspace `.ts`/`.test.ts` payload fail-closed；保留 `runtime-compile` 生成的 workspace `.js` packages 供 CLI 运行。
- `.dockerignore` 排除 git、node_modules、dist、测试、source map、文档与本地环境文件；debug 仅添加 HTTPS/DNS/TCP/process/network/JSON 诊断包：`curl`、`bind-tools`、`netcat-openbsd`、`procps-ng`、`iproute2`、`jq`。
- `scripts/verify-vps-sync-image.mjs` 同时检查 targets、build/deploy/lockfile contracts、dist/prod-deps boundary、workspace store cleanup/fail-closed source boundary、CA/PG client、non-root/entrypoint/no-port、source/test/dev-tool exclusions、debug packages 和 package scripts；给定 `VPS_SYNC_IMAGE` 时额外检查 Docker image config，inspect 缺失、失败或 JSON 无效均返回非零错误。

## TDD 证据

先强化 verifier 测试要求 production 从 build stage 拷贝编译后的 `dist/`，旧 partial Dockerfile 观察到预期 RED：

```sh
node --test scripts/verify-vps-sync-image.test.mjs
# 2 pass, 1 fail；缺少 COPY --from=build /workspace/apps/vps-sync/dist/ ./dist/
```

将 app runtime copy 收敛到 build stage 的 dist 后，同一测试 GREEN：

```sh
node --test scripts/verify-vps-sync-image.test.mjs
# 4 pass, 0 fail
```

## 合约核验与限制

- 已用本地 help 核对 `pnpm deploy --help`、`pnpm install --help`、`pnpm exec tsc --help --all`；Dockerfile 使用的 deploy、`--prod`、`--frozen-lockfile`、runtime compiler flags 均存在。仓库根 `packageManager` 为 `pnpm@9.15.9`，与 Dockerfile `PNPM_VERSION` 一致。
- 已尝试 `docker buildx imagetools inspect node:alpine`、`docker run --rm node:alpine sh -c 'apk search ...'`、`docker buildx build --help`；三者均因本机 `docker: command not found` 无法执行。按允许 fallback，核对了 Docker 官方 [`node` 镜像说明](https://hub.docker.com/_/node) 与 Alpine 官方 [`postgresql17-client` 包索引](https://pkgs.alpinelinux.org/package/v3.24/main/x86_64/postgresql17-client)。Node/Alpine resolved version 与 digest 留给具备 Docker 的 CI；未把网页 tag 信息当作本地 image build 证据。
- production read-only root filesystem、capability dropping、tmpfs 与无端口运行时门禁属于 Task 7.2 Compose；Task 7.1 verifier 对 Dockerfile 的 no-listener/non-root/temporary-directory 边界负责。

## 最终验证

- `node --test scripts/verify-vps-sync-image.test.mjs` — PASS，4/4。
- `node scripts/verify-vps-sync-image.mjs` — PASS；无 image reference 时仅报告 read-only/capability warning 与 inspect skip。
- `pnpm -F @airing-cal/vps-sync build` — PASS。
- `pnpm -F @airing-cal/vps-sync build:check` — PASS。
- `pnpm -F @airing-cal/vps-sync typecheck` — PASS。
- `git diff --check` — PASS。

## 复审修复

- RED：复审回归测试在旧实现上为 4/6 通过、2/6 失败，分别暴露 versioned `.pnpm` workspace payload 未清理和有 image reference 时 inspect 失败仍返回 `ok=true`。
- GREEN：加入 production store 清理与 workspace source/test fail-closed 门禁、image inspect error 传播后，`node --test scripts/verify-vps-sync-image.test.mjs` 为 6/6 通过。
- runbook 顶部不再声称 debug 包已核验，统一记录为目标包名待 Docker 环境用 `apk search` 重跑确认。

未修改 plan、OpenSpec task 勾选或 `.comet/subagent-progress.md`；未实现 Task 7.2/8/9 的 Compose、GHCR、cron、secrets 或生产切换。

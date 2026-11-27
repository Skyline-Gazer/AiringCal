# AiringCal v3.0.0 — 部署、更新与恢复指南

[English](DEPLOYMENT.md) | [简体中文](DEPLOYMENT.zh-CN.md)

本文档是 **AiringCal `v3.0.0`** 唯一权威的部署、更新、恢复与日常运维指南。

---

## 1. 支持的架构拓扑与环境

AiringCal `v3.0.0` 采用收敛后的单一无服务器（Serverless）架构拓扑：

```text
GitHub Actions Portable Writer (portable-writer.yml)
  └── 私有 Cloudflare R2 存储桶（每个环境独立单桶，禁用 r2.dev）
        ├── checkpoints/builder.sqlite & checkpoints/lease.json（私有，绝不可被匿名路由访问）
        └── public/current-release.json, snapshots/v1/*, images/*（通过 Worker 白名单路由对外提供）
              └── 无状态 Cloudflare Reader Worker (apps/v3-read-worker)
```

| 环境名称 | 标准 R2 存储桶 | 标准 Cloudflare Worker | GitHub Environment | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| **`production`** | `airingcal-production` | `airingcal-production` | `production` | 个人正式部署环境（推荐） |
| **`development`** | `airingcal-development` | `airingcal-development` | `development` | 可选的开发与测试环境 |

---

## 2. 前置条件与凭据权限说明

### 本地工具链要求

- **Node.js `>= 24`** (`node -v`)
- **pnpm `9.15.9`** (`corepack enable && pnpm -v`)
- **GitHub CLI (`gh`)**：已登录且对目标仓库拥有写入/管理员权限 (`gh auth status`)
- **Wrangler `4.x`**（已内置于项目开发依赖，通过 `pnpm exec wrangler` 调用）

### 所需 API 令牌（双 Token 模式）

1. **Cloudflare 管理 API Token** (`AIRINGCAL_CLOUDFLARE_API_TOKEN`)：
   - **Account → Workers R2 Storage: Edit**（创建/检查 R2 存储桶并禁用 `r2.dev`）
   - **Account → Workers Scripts: Edit**（部署 `airingcal-production` / `airingcal-development` 并检查 Worker 绑定）
   - **User → User Details: Read**（通过 `wrangler whoami` 自动发现账号列表）
   - **User → API Tokens: Edit** *(推荐)*：允许部署引擎自动签发限定单桶权限的专用 Writer Token（`airingcal-production-writer` 或 `airingcal-development-writer`），权限严格限制为目标存储桶的 `Workers R2 Storage Bucket Item Write`。
     - *回退方式*：如果你的管理 Token 不包含 `User API Tokens: Edit`，向导会通过掩码输入框引导你手动输入独立的单桶 R2 S3 Access Key ID 与 Secret Access Key。
   - **Zone → Zone: Read & DNS: Edit** *(可选)*：仅在为 Worker 绑定自定义域名（Custom Domain）时需要。
2. **Bangumi 个人访问令牌 (PAT)** (`AIRINGCAL_BANGUMI_TOKEN`)：
   - 在 [next.bgm.tv/demo/access-token](https://next.bgm.tv/demo/access-token) 创建的标准个人令牌，用于校验身份（`/v0/me`）以及读取动画收藏与单集进度。

---

## 3. Fork 与目标仓库解析契约

AiringCal 原生支持在 Fork 仓库或独立仓库中运行，无需修改任何源码中的仓库名称：

1. **解析优先级**：
   - 显式环境变量 `AIRINGCAL_REPOSITORY=<owner>/<repo>`
   - 受信任的 `GITHUB_REPOSITORY=<owner>/<repo>`
   - 经校验的 `git remote get-url origin`（支持 `https://github.com/<owner>/<repo>(.git)` 与 `git@github.com:<owner>/<repo>(.git)`）
2. **源不一致时默认拒绝（Fail-Closed）**：
   - 如果多个来源同时存在但互相冲突（例如 `AIRINGCAL_REPOSITORY` 与 `git remote origin` 不一致），部署引擎会以 `REPOSITORY_CONFLICT` 立即拒绝执行，除非显式设置 `AIRINGCAL_REPOSITORY_OVERRIDE_CONFIRM=yes`。
   - 对于任何会产生远端变更的操作，当 `origin` 缺失或指向非 GitHub 主机时，绝不会静默回退到 `Skyline-Gazer/AiringCal`。
3. **动态分支解析**：
   - 首次全量同步与工作流触发会自动解析当前检出分支或通过 GitHub API 查询目标仓库的 `default_branch`（`main` 或 `dev`），无硬编码分支依赖。

---

## 4. 操作模型：`install`、`update` 与 `recover`

`pnpm run setup` 与部署引擎严格区分三种生命周期操作：

### A. 全新安装 (`install`)

适用于目标 R2 存储桶与 Cloudflare Worker 尚不存在的场景：

1. **令牌、账号与发布源码身份预检**：校验 Cloudflare 账号访问权限、`workers.dev` 子域名、Bangumi 用户身份，以及经显式批准的 Production Writer 发布源码身份（`AIRINGCAL_PRODUCTION_RELEASE_SHA` 与可选的 `AIRINGCAL_PRODUCTION_RELEASE_REF`，后者必须解析到该 40 位提交 SHA）。全新安装绝不会将当前 Git `HEAD`、`BANGUMI_GIT_COMMIT_SHA` 或 `plan.gitSha` 隐式当作已批准的发布版本；在交互式模式下，`pnpm run setup` 会自动探测已发布的 Release 标签候选（如 `v3.0.0`）并在配置审阅界面由操作者显式确认后才写入，而无头（Headless）全新安装必须在执行任何远端资源创建前于 `.env.production` / 环境变量中显式提供 `AIRINGCAL_PRODUCTION_RELEASE_SHA`。
2. **创建私有 R2 存储桶**：创建 `airingcal-production`（或 `airingcal-development`）。
3. **签发单桶受限 Writer 凭据**：在存储桶创建完成后签发 `airingcal-production-writer`，校验 Token 身份（`/user/tokens/verify`），回读策略（`/user/tokens/:id`）证明其仅作用于当前目标存储桶，并通过 S3 `list+head` 验证对象访问。若任一校验失败，立即自动清理刚创建的 Token。
4. **全新安装空桶门禁 (`verify-bucket-empty`)**：验证存储桶内没有任何既有对象。若发现任何外部对象，立即以 `BUCKET_NOT_EMPTY` 中止且绝不删除已有数据。
5. **禁用 `r2.dev`**：关闭 R2 存储桶的 `r2.dev` 公共访问并回读确认。
6. **同步 GitHub Environment**：创建/更新 `production`（或 `development`）GitHub Environment 变量与 Secrets，同时保持 Writer 运行门禁为关闭状态（`false`）。
7. **部署 Cloudflare Reader Worker**：生成 Wrangler 配置并部署绑定到该存储桶（`AIRINGCAL_R2`）的 Reader Worker。
8. **正向 Checkpoint 私有隔离证明**：通过 S3 写入 `checkpoints/_isolation-probe.txt` 并用 S3 `HEAD` 证明对象真实存在，随后对已部署 Worker 的匿名入口发起 `GET`/`HEAD`（含 URL 编码与路径穿越变体）证明全部返回 HTTP `404`，最后删除探测对象并确认清理完成。

### B. 现有安装的安全更新 (`update`)

适用于你的 Cloudflare 账号与 GitHub 仓库中已部署过 AiringCal 的场景：

1. **变更前归属与一致性校验 (`verifyExistingInstallation`)**：
   在创建、修改或部署任何资源之前，引擎会先校验：
   - 目标 R2 存储桶在所选 Cloudflare 账号中已存在。
   - 现有 Cloudflare Worker 已部署，且其 `AIRINGCAL_R2` 绑定确实指向目标 R2 存储桶（若绑定到其他桶则以 `WORKER_BINDING_MISMATCH` 立即中止）。
   - GitHub Environment 已存在，且其中的 `AIRINGCAL_<ENV>_R2_BUCKET`、`CLOUDFLARE_ACCOUNT_ID`、`PRIMARY_USER_ID`、`PUBLIC_BASE_URL` 与当前目标一致。
   - 本地 `.airingcal/inventory.<env>.json`（若存在）与远端仓库、账号、存储桶或 Bangumi 用户 ID 不存在冲突。
   - 已部署 Worker 上的现有 Release 指针（`/public/current-release.json`）合法有效（或确认为等待首次同步的空桶部署）。
2. **非破坏性保留原则**：
   - **绝不要求空桶或清空数据**：完整保留现有 Release 指针、快照、清单、SQLite Checkpoint 及所有封面图片。
   - **绝不静默轮换或重建现有 Writer Token**：由于 GitHub Environment Secrets（`AIRINGCAL_<ENV>_S3_*`）不可回读明文，`update` 默认复用现有 GitHub S3 Secrets，并通过 Cloudflare API 校验现有 Writer Token 的激活状态与单桶权限范围；仅在你显式提供 `AIRINGCAL_WRITER_TOKEN_ROTATION_ID=<token-id>` 或新 `AIRINGCAL_S3_*` 凭据时才更新密钥。
   - **默认保留现有 Production Writer 发布源码身份**：从新的代码检出更新 Reader Worker 或环境配置时，默认保留 `production` GitHub Environment 中既有的 `AIRINGCAL_PRODUCTION_RELEASE_SHA`（及 `AIRINGCAL_PRODUCTION_RELEASE_REF`），绝不会在仅更新 Reader 时静默把 Production Writer 推进到当前检出的 `HEAD`。如确需在 `update` 期间变更已批准的 Production Writer 发布版本，必须显式设置 `AIRINGCAL_ALLOW_RELEASE_CHANGE=yes`（且若新批准的 `AIRINGCAL_PRODUCTION_RELEASE_SHA` 未指定新的 `RELEASE_REF`，引擎会自动从 `production` GitHub Environment 删除旧的 `AIRINGCAL_PRODUCTION_RELEASE_REF`，防止旧标签与新 SHA 产生不匹配的残留组合）。
   - **不自动重跑首次全量同步**：已初始化的部署在更新 Worker 后直接沿用现有 Release 数据。
3. **诚实的终端结论（Truthful Verdict）**：
   - 当复用现有 GitHub S3 Secrets（未在本地提供 S3 密钥明文）完成更新时，向导会验证更新后 Worker 对 `checkpoints/*` 的匿名拒绝，并输出 `UPDATED_PARTIAL_VERIFICATION`（`credentialVerification.runtimeVerification = "not-verified-github-secret-only"`），明确区分“Cloudflare API Token 策略范围已校验”与“运行时 S3 读写未在本次更新中执行”。
   - 当提供本地 S3 凭据（或显式轮换 Token）并通过 25 项线上验收检查时，终端结论为 `READY`。

### C. 中断尝试恢复 (`recover`)

适用于前一次安装在中途失败（例如已创建 R2 存储桶，但 Token 签发或网络传输中断）的场景：

1. 结合执行点变更账本（`.airingcal/inventory.<env>.json`）与只读远端状态探测（`discoverPartialState`），清晰列出已确认变更、已存在资源、未知传输结果与未确认清理项。
2. 在验证存储桶归属（或获得用户显式确认）后复用空的既有存储桶，同时保持空桶安全门禁生效。
3. 提供受控恢复菜单：**提供/替换独立 R2 S3 凭据**、**重新核对远端资源 (Reconcile)**、**重试失败操作**、**返回配置审阅**、**查看详细失败账本** 或 **安全退出**。

---

## 5. 交互式向导使用指南 (`pnpm run setup`)

在仓库根目录下运行：

```bash
pnpm run setup
```

### `pnpm run setup` 命令行参数

| 命令 | 模式 | 说明 |
| :--- | :--- | :--- |
| `pnpm run setup` | 交互式主菜单 | 完整交互式界面：安装或更新、验证 API 凭据、Doctor 诊断 |
| `pnpm run setup -- --doctor --environment production` | 只读 Doctor 诊断 | 检查 `gh auth`、`portable-writer.yml` 状态、环境门禁、定时开关及最近运行记录 |
| `pnpm run setup -- --headless --environment production` | 无头（Headless）执行 | 由 `.env.production` 及显式确认开关驱动的非交互式部署/更新 |
| `pnpm run setup -- --sync --environment production` | 独立触发首次全量同步 | 触发带门禁保护的首次全量同步（`force_mode=full`）并在完成后自动关闭临时门禁 |

---

## 6. 无头（Headless）非交互式执行

在自动化脚本或无交互终端中，可通过独立的配置文件（Production 必须使用 `.env.production`，Development 使用 `.env`）运行部署引擎。

### `.env.production` 必填项示例（权限 `0600`，已被 Git 忽略）

```dotenv
AIRINGCAL_ENV=production
AIRINGCAL_DEPLOY_TARGET=cloudflare
AIRINGCAL_REPOSITORY=<your-owner>/<your-repo>
AIRINGCAL_CLOUDFLARE_API_TOKEN=<your-cloudflare-api-token>
AIRINGCAL_CLOUDFLARE_ACCOUNT_ID=<your-32-hex-account-id>
AIRINGCAL_WORKERS_DEV_SUBDOMAIN=<your-workers-dev-subdomain>
AIRINGCAL_BANGUMI_TOKEN=<your-bangumi-pat>
AIRINGCAL_PRIMARY_USER_ID=<your-bangumi-numeric-user-id>
AIRINGCAL_USERS_JSON=[{"userId":"<your-bangumi-numeric-user-id>","username":"<your-bangumi-username>"}]

# 无头（Headless）全新安装必填（更新既有部署时默认自动保留远端 production 环境中的既有值）：
AIRINGCAL_PRODUCTION_RELEASE_SHA=<40-char-hex-approved-release-commit-sha>
# 可选：不可变发布标签/引用（必须解析到 AIRINGCAL_PRODUCTION_RELEASE_SHA）：
# AIRINGCAL_PRODUCTION_RELEASE_REF=v3.0.0
# 仅在更新（update）期间确需变更既有已批准发布身份时显式开启：
# AIRINGCAL_ALLOW_RELEASE_CHANGE=yes

# 可选：更新现有已初始化部署时设置为 "update"
# AIRINGCAL_OPERATION=update

# 可选：自定义域名（使用默认 workers.dev 时无需配置）
# AIRINGCAL_PUBLIC_BASE_URL=https://anime.example.com
# AIRINGCAL_WORKER_CUSTOM_DOMAIN=anime.example.com
# AIRINGCAL_ZONE_ID=<your-cloudflare-zone-id>
```

### 第一步 —— 只读预览执行计划 (`--dry-run`)

```bash
AIRINGCAL_ENV=production \
AIRINGCAL_DOTENV_PATH=.env.production \
node scripts/deploy-env.mjs --dry-run --target cloudflare
```

### 第二步 —— 授权执行变更 (`--apply`)

Production 变更需要三重显式授权（`--apply --i-am-sure-production`、`AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes` 与 `AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes`）：

```bash
AIRINGCAL_ENV=production \
AIRINGCAL_DOTENV_PATH=.env.production \
AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes \
AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes \
node scripts/deploy-env.mjs --apply --i-am-sure-production --target cloudflare
```

---

## 7. 线上部署验收 (`scripts/v3-ship-verify.mjs`)

首次全量同步完成后（或在具备本地 S3 凭据的更新后），运行官方验收脚本验证全部 25 项指标：

```bash
AIRINGCAL_S3_ACCESS_KEY_ID=<your-bucket-s3-key-id> \
AIRINGCAL_S3_SECRET_ACCESS_KEY=<your-bucket-s3-secret-key> \
AIRINGCAL_S3_ACCOUNT_ID=<your-32-hex-account-id> \
node scripts/v3-ship-verify.mjs \
  --base https://airingcal-production.<your-subdomain>.workers.dev \
  --bucket airingcal-production
```

`v3-ship-verify.mjs` 验收范围（共 25 项检查）：
1. **正向私有对象隔离证明**：通过 S3 `HEAD` 证明 `checkpoints/builder.sqlite`（或临时探测对象）真实存在于私有 R2 存储桶中，再验证匿名 `GET`/`HEAD` 请求访问 `/checkpoints/builder.sqlite`、`/checkpoints/lease.json`、URL 编码变体 `%63heckpoints` 以及路径穿越 `/public/..%2f..%2fcheckpoints/*` 时全部被拒绝（HTTP `403`/`404`）。
2. **Release 指针与不可变快照校验**：校验 `/public/current-release.json`（`Cache-Control: public, max-age=0, must-revalidate`）及其指向的 `/snapshots/v1/<gen>-<sha>.json`（`Cache-Control: public, max-age=31536000, immutable`）。
3. **Reader API 与 Widget 契约**：校验 `/`、`/src/bangumi.js`、`/src/bangumi.css`、`/api/health`、`/api/collections?type=watching`、`/api/calendar`、`/api/config?key=nsfw`、`/api/version`、`/api/sync/apply`（HTTP `410`）以及封面图片流式读取 `/image/:hash`。

> [!NOTE]
> 如果在更新后仅需验证公开 HTTP 路由与匿名拒绝行为而不在本地提供 S3 凭据，可使用 `--allow-unproven-isolation` 替代 `--bucket`。注意该模式仅验证匿名路由拒绝，不提供私有对象在 R2 中存在的正向 S3 证明。

---

## 8. 开启或关闭定时自动同步

GitHub Actions 工作流 `.github/workflows/portable-writer.yml` 将 **Production 定时自动同步**、**Production 手动按需同步** 与 **Development 手动测试同步** 严格分离为三个独立的授权开关，并在 Production 中强制执行 **发布源码身份校验**：

1. **仓库级定时总开关** (`vars.AIRINGCAL_WRITER_ENABLED`)：
   - 控制每日 Production 定时任务（`0 20 * * *`，北京时间每日 `04:00` / `20:00 UTC`）是否生效。定时触发器绝不会运行 `development` 作业。
   - 开启：`gh variable set AIRINGCAL_WRITER_ENABLED --repo <owner>/<repo> --body true`
   - 关闭：`gh variable set AIRINGCAL_WRITER_ENABLED --repo <owner>/<repo> --body false`
2. **Production 发布源码身份契约**（`production` 环境级变量 `AIRINGCAL_PRODUCTION_RELEASE_SHA` 与可选的 `AIRINGCAL_PRODUCTION_RELEASE_REF`）：
   - `AIRINGCAL_PRODUCTION_RELEASE_SHA`（必填，精确的 40 位十六进制 Git 提交 SHA）锁定经显式批准的发布提交。`production` 作业在检出代码后、执行 `pnpm install` / 构建 / 运行 Writer 之前，会通过 `git rev-parse HEAD` 严格核对实际检出源码的 SHA，不一致则立即失败中止（Fail-Closed）。部署引擎绝不会隐式回退到当前 Git `HEAD`、`BANGUMI_GIT_COMMIT_SHA` 或 `plan.gitSha`，且常规 `update` 默认保留既有 `AIRINGCAL_PRODUCTION_RELEASE_SHA`（除非显式设置 `AIRINGCAL_ALLOW_RELEASE_CHANGE=yes`）。
   - `AIRINGCAL_PRODUCTION_RELEASE_REF`（可选，例如 `v3.0.0` 或 `refs/tags/v3.0.0`）锁定不可变的发布标签/引用；若被设置为可变开发分支（`dev`、`refs/heads/dev`、`HEAD`）或解析出的提交与 `AIRINGCAL_PRODUCTION_RELEASE_SHA` 不一致，部署预检与工作流作业均会立即拒绝执行。当通过 `AIRINGCAL_ALLOW_RELEASE_CHANGE=yes` 授权了新的 `AIRINGCAL_PRODUCTION_RELEASE_SHA` 且未携带新 `RELEASE_REF` 时，部署引擎会自动从 `production` 环境删除旧的 `AIRINGCAL_PRODUCTION_RELEASE_REF`。
3. **环境级临时手动触发门禁**（默认必须保持 `false` 关闭状态）：
   - `production` 环境变量 `AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED`：仅控制针对 `production` 的手动 `workflow_dispatch` 触发（包括首次全量同步与日常手动触发）。定时 `schedule` 运行不读取该变量，**切勿**将其长期保留为 `true`。
   - `development` 环境变量 `AIRINGCAL_DEVELOPMENT_WRITER_ENABLED`：仅控制针对 `development` 的手动 `workflow_dispatch` 触发。

> [!IMPORTANT]
> **代码级源码校验与 GitHub Actions 默认分支及环境策略机制的边界**：
> - 在 GitHub Actions 中，`schedule` 定时触发始终从仓库的默认分支（`refs/heads/<default_branch>`）解析并执行工作流 YAML 定义本身。
> - 在工作流运行内部，锁定 `AIRINGCAL_PRODUCTION_RELEASE_SHA` 能够在代码层面保证检出的执行源码、依赖安装、打包产物与写入快照的 `BANGUMI_GIT_COMMIT_SHA` 均来自经批准的发布提交。
> - GitHub Environment `production` 的受保护部署分支/标签策略（Deployment branch/tag policy）仅负责拦截未被授权访问 `production` 环境的分支，**不会**把默认分支上的 `schedule` 触发重定向到其他分支。因此，“将 `main` 设为默认分支”与“为 `production` 环境配置仅允许 `main`/`v*` 的分支策略”**不是**可以互换的替代方案：如果仓库默认分支仍为 `dev`，同时 `production` 环境策略拒绝 `dev`（仅允许 `main` 或 `v*`），定时 Production 运行将被 GitHub Actions **直接拦截**，而不会自动切换到 `main` 运行。
> - 反之，在包含 `AIRINGCAL_PRODUCTION_RELEASE_SHA` 校验的加固版 `.github/workflows/portable-writer.yml` 正式发布到 `main` 之前，若提前将默认分支切换为 `main`，定时任务将执行 `main` 上的旧版工作流定义。此外，若在 `production` 环境上启用必需审批人（Required reviewers），无人值守的定时任务也会暂停等待人工审批。

### 手动按需触发同步

你可以随时手动触发一次增量或全量同步：

```bash
# 推荐：通过设置向导自动开启临时门禁、触发运行并在通过门禁后自动关闭：
pnpm run setup -- --sync --environment production

# 或通过 GitHub CLI 手动临时开启门禁、触发运行，并在作业通过门禁步骤后立即关闭：
gh variable set AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED --env production --repo <owner>/<repo> --body true
gh workflow run portable-writer.yml --repo <owner>/<repo> -f target=production -f force_mode=incremental
gh variable set AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED --env production --repo <owner>/<repo> --body false
```

---

## 9. 本地资产清单与常见故障排查

- **脱敏本地清单 (`.airingcal/inventory.<env>.json`)**：
  - 以 `0600` 权限保存在本地并被 Git 忽略。
  - 记录解析后的目标仓库、脱敏后的 Cloudflare 账号信息、存储桶状态、Worker URL、Writer 凭据元数据（`source`、`scope`、`tokenName`、`tokenId`，绝不包含密钥明文）、执行点变更账本以及验收结果。
- **常见错误码与处理建议**：
  - `REPOSITORY_CONFLICT` / `REPOSITORY_UNRESOLVED`：`AIRINGCAL_REPOSITORY`、`GITHUB_REPOSITORY` 与 `git remote get-url origin` 冲突或缺失 `origin`。请显式设置 `AIRINGCAL_REPOSITORY=<owner>/<repo>`（若确需覆盖 `origin` 则同时设置 `AIRINGCAL_REPOSITORY_OVERRIDE_CONFIRM=yes`）。
  - `BUCKET_NOT_EMPTY`：全新 `install` 或 `recover` 在目标桶中发现了既有对象。如果这是已有的 AiringCal 部署，请使用 `update` 模式；如果该存储桶属于其他项目，请勿复用。
  - `WORKER_BINDING_MISMATCH`：现有 Cloudflare Worker 的 `AIRINGCAL_R2` 绑定到了其他存储桶。请先在 Cloudflare 控制台核对 Worker 绑定关系。
  - `FOREIGN_OR_INCONSISTENT_INSTALLATION`：远端 GitHub Environment 变量、Worker 绑定或本地 Inventory 与当前目标账号、存储桶或 Bangumi 用户 ID 冲突。
  - `OWNERSHIP_EVIDENCE_INSUFFICIENT`：网络传输或权限错误导致更新前无法读取存储桶、Worker 或 GitHub Environment 元数据。请检查 Cloudflare API Token 权限及 `gh auth status`。
  - `Checkpoint lease held by <owner> until <unix>`：另一个 Writer 实例正持有 `checkpoints/lease.json` 租约（TTL 45 分钟）。请等待正在运行的任务结束或租约过期；若前一次任务异常崩溃导致租约未释放，可在确认无运行中任务后检查 R2 中的 `checkpoints/lease.json`。

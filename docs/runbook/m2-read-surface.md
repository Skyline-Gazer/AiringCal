# M2 一条过（读面验收）

**前提：** M1 已能跑通 sync（preflight → success / `generation=`）。下面 **按序号一次做完** 即 M2。

**变量：** 把 `SITE` 换成你的站点根 URL（无尾 `/`），例如 `https://airing.example.com`。

---

## 0. 准备（只做一次）

- [ ] 青龙 env 已有 `AIRINGCAL_BUNDLE_GITHUB_TOKEN`（或你能手动更新 bundle）
- [ ] 本机可 deploy Worker：`AiringCal` 仓库 `dev` 分支，`pnpm install`，Cloudflare `wrangler login` 或 `CLOUDFLARE_API_TOKEN`

---

## 1. 最新 bundle

**自动（推荐）：** 青龙面板手动跑一次 **airingcal-sync**（0.2.21 会在有 PAT 时拉 **≥ PR #55** 的 CI artifact）。

**手动：** [Actions → CI → qinglong-bundle](https://github.com/Skyline-Gazer/AiringCal/actions/workflows/ci.yml) 下载 artifact → 解压到容器 `QL_DATA_DIR/airingcal-bundle/`。

- [ ] 日志无 `BUNDLE_MISSING`；结束 **success**，含 `generation=`

---

## 2. 全量 sync（同一次面板运行）

- [ ] 同上任务已 success（若 calendar 封面仍缺，可 **再跑 1～2 次** sync，detail cap 120/轮）

---

## 3. Deploy 读 Worker

在 **AiringCal** 仓库（`dev`）：

```bash
pnpm install
pnpm -F @airing-cal/web-worker deploy
```

（或你惯用的 GitHub Actions deploy workflow，目标服务名 **`airing-cal-frontend`**。）

- [ ] 命令成功；记下 deploy 的 commit（与 `/api/version` 一致更好）

---

## 4. API 一条命令 smoke

```bash
SITE='https://你的域名'
curl -sf "$SITE/api/version" | head -c 400; echo
curl -sf "$SITE/api/collections?type=watching&limit=3" | head -c 400; echo
curl -sf "$SITE/api/calendar" | head -c 400; echo
```

- [ ] `/api/version` 有 JSON
- [ ] `/api/collections` 有 `data` 数组
- [ ] `/api/calendar` 为按星期结构（非空或符合预期）

（可选：从 collections JSON 取一个 `images.large.hash`，`curl -sfI "$SITE/image/<hash>"` 应 **200**。）

---

## 5. 浏览器（30 秒）

- [ ] 打开 `SITE`，番组计划 Tab 与放送日历 Tab **同一番** 封面清晰度可接受（widget 大图 ≥ PR #55）

---

## 5b. Cover thumb（AC-2，可选于 M2+）

前置：AiringCal PR 含 web-worker thumb-gen + node-jobs batch；QINGLONG [QL-4](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/plans/airingcal-thumb-pipeline.md) env 已配。

1. Deploy web-worker：`THUMB_GEN_BEARER` secret + `[images]` binding（见 `apps/web-worker/README.md`）
2. 青龙 env：`AIRINGCAL_THUMB_GEN_URL`、`AIRINGCAL_THUMB_GEN_BEARER`（与 secret 相同）
3. 拉含 AC-2-03 的 bundle → 手动 sync 一轮
4. `curl -sf -o /dev/null -w '%{http_code}\n' -X POST "$SITE/api/thumb-gen"` → **401**
5. 浏览器 Network：列表封面为 `/image/<hash>/thumb`（WebP），体积明显小于 `/image/<hash>`

Worker Cron `15 * * * *` 会补偿漏掉的 thumb（无公网接口）。

---

## 6. 开 cron（M2 收尾，M3 运维）

| 青龙任务 | cron |
| --- | --- |
| airingcal-sync | `0 20 * * *` UTC |
| airingcal-backup（可选） | `30 4 * * 0` |

- [ ] sync cron 已开；backup 按需

---

## 失败速查

| 现象 | 动作 |
| --- | --- |
| 页面糊、API 有数据 | 确认 **步骤 3** deploy + **步骤 1** bundle 为 PR #55 之后 CI |
| calendar 大量无图 | 多跑 sync；bundle 须 PR #54+ |
| API 空 | 回到 **步骤 2** sync / KV·R2 是否写入（M1） |

**M2 通过定义：** 步骤 1–5 全勾；步骤 6 可选但推荐。

## Homelab 记录（2026-10-13）

| 项 | 值 |
| --- | --- |
| SITE | `https://airingcal.q9m3.com` |
| Worker | `042ea38` |
| Sync | 面板 success，`generation=9`，~107s |
| QingLong | `task Skyline-Gazer_QINGLONG-REPO_ql/scripts/airingcal-sync.js` |

QingLong：[operator-checklist](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/usage/airingcal-operator-checklist.md) · [homelab-closure](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/governance/2026-10-13-homelab-closure.md)

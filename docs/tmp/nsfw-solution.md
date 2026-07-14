# NSFW 标注修复方案

## 背景

当前前端遮罩逻辑已经统一到 `renderSubjectCard()`：只要后端返回的条目含有 `nsfw: true`，番组计划和放送日历都会加上 `.bgm-nsfw`，从而显示粉色 R18 遮罩并模糊封面。

实际问题不在前端样式，而在同步快照里的 `nsfw` 数据来源不可靠：

- 番组计划来自 `GET /v0/users/{username}/collections`，收藏条目内嵌的 `subject` 是 `SlimSubject`。
- 放送日历来自 `GET /calendar`，日历 item 是 `Legacy_SubjectSmall`。
- 本地 OpenAPI 里 `SlimSubject` 和 `Legacy_SubjectSmall` 都没有 `nsfw` 字段。
- 只有完整 `Subject` schema 有 `nsfw` 字段。

因此当前 `merger.ts` 的 `nsfw: subj?.nsfw ?? false` 大多数情况下会把实际 R18 条目写成 `false`，导致前端不遮罩。

## 已验证的 API 证据

证据来源：`docs/example/api/bgm-api.json`。

- `GET /v0/subjects/{subject_id}` 返回完整 `Subject`，`Subject.nsfw` 是 boolean 字段。
- `GET /v0/subjects/{subject_id}` 使用 `OptionalHTTPBearer`。
- `OptionalHTTPBearer` 描述明确说明：部分 subject API 不需要授权，但 NSFW 内容只对授权用户可见；非授权用户会得到 404。
- `GET /v0/users/{username}/collections` 返回 `Paged_UserCollection`，其中 `subject` 引用 `SlimSubject`，没有 `nsfw`。
- `GET /calendar` 返回 `Legacy_SubjectSmall`，没有 `nsfw`。

用户通过代理验证过无 Bearer 请求：

```bash
curl -sL \
  -H 'User-Agent: markd3ng/AiringCal (https://github.com/markd3ng/AiringCal)' \
  -H 'Accept: application/json' \
  -w '\nHTTP_STATUS:%{http_code}\n' \
  https://api.bgm.tv/v0/subjects/23080
```

返回：

```json
{
  "title": "Not Found",
  "details": {
    "path": "/v0/subjects/23080",
    "method": "GET"
  },
  "request_id": "a132ce20e9212638-LHR",
  "description": "resource can't be found in the database or has been removed"
}
```

状态码为 `404`。结合 OpenAPI，这个 404 不能直接当作“条目不存在”，也可能是未授权访问 NSFW 内容。

## 目标

在后台同步阶段补全 subject 元信息，让公开 API 的收藏和日历快照都带可靠的 `nsfw` 布尔值。

前端不再承担 NSFW 推断，只消费后端返回的最终 `nsfw` 字段。

## 设计方案

### 1. 新增 subject meta 缓存

使用 KV 缓存完整 subject 查询结果，避免每次同步重复打 bgm.tv API。

建议 key：

```text
subject:meta:{subject_id}
```

建议 value：

```json
{
  "subject_id": 23080,
  "exists": true,
  "nsfw": true,
  "checked_at": 1782650000,
  "reason": "subject_detail"
}
```

字段语义：

- `exists: true`：`GET /v0/subjects/{id}` 返回 200。
- `exists: false`：返回 404。
- `exists: null`：网络错误、5xx、超时等临时失败，不应长期缓存。
- `nsfw`：后端写入快照时使用的最终判断。
- `reason`：便于排障，例如 `subject_detail`、`not_found_or_restricted`、`tag_fallback`、`network_error`。

TTL 建议：

- 200 结果：缓存 7-30 天。
- 404 结果：缓存 1-7 天，避免永久记住可能恢复的条目。
- 网络错误/5xx：不缓存或短缓存。

### 2. 同步阶段收集 subject ids

在 `runSync()` 中，收藏和日历拉取后收集 subject id。

优先级：

1. 番组计划收藏条目。
2. 放送日历中当前日期或本周优先展示条目。
3. 其他日历条目。

每次同步只补一小批缺失或过期的 meta，避免 Worker 子请求爆掉。

建议初始预算：

```text
subject detail enrichment: 10-20 requests per sync
```

### 3. 使用带 Bearer 的 BgmClient 查询完整 Subject

`runSync()` 当前已经通过 `ensureFreshToken()` 得到 token，并创建：

```ts
const client = new BgmClient(token)
```

因此后续调用：

```ts
await client.getSubject(subjectId)
```

会带 `Authorization: Bearer <token>`。这点很重要，因为无 Bearer 查询 NSFW subject 可能返回 404。

### 4. 404 策略

对 `GET /v0/subjects/{id}` 的 404 不能简单视为普通非 NSFW。

建议保守策略：

```json
{
  "subject_id": 23080,
  "exists": false,
  "nsfw": true,
  "reason": "not_found_or_restricted"
}
```

理由：

- OpenAPI 明确说明未授权访问 NSFW 内容会 404。
- 同步使用 Bearer 后仍出现 404 时，可能是删除、隐藏、权限不足、旧数据残留等。
- 对公开前端来说，宁可多遮罩，不应裸露不可确认的受限条目。

如果后续希望更精细，可增加 `restricted: true`，但前端仍可直接把 `restricted || nsfw` 当作遮罩条件。

### 5. 写回收藏快照

`packages/shared/src/merger.ts` 当前通过 `subj?.nsfw ?? false` 生成 `MergedEntry.nsfw`。

建议改为让 `merge()` / `primaryMerge()` 接收 subject meta map：

```ts
type SubjectMetaMap = Map<number, { nsfw: boolean }>

merge(usersCollections, imageHashMap, subjectMetaMap)
primaryMerge(masterCollections, imageHashMap, subjectMetaMap)
```

写入优先级：

```ts
nsfw = subjectMetaMap.get(subjectId)?.nsfw ?? subj?.nsfw ?? false
```

这样一旦 meta 补齐，番组计划会正确返回 `nsfw: true`。

### 6. 写回日历快照

`transformCalendar()` 当前只注入图片 hash。

建议改为同时接收 subject meta map：

```ts
transformCalendar(rawCalendar, imageHashMap, subjectMetaMap)
```

写入：

```ts
return {
  ...entry,
  nsfw: subjectMetaMap.get(entry.id)?.nsfw ?? entry.nsfw ?? false,
  images: { ...entry.images, hash },
}
```

这样放送日历也能和番组计划共用前端卡片遮罩逻辑。

### 7. API 过滤逻辑保持不变

现有公开 API 已经按 `NSFW_SHOW` 控制是否过滤：

- `handleCollections()`：`nsfwShow ? bucket : bucket.filter((e) => !e.nsfw)`
- `handleCalendar()`：`nsfwShow ? d.items : d.items.filter((item) => !item.nsfw)`

只要同步快照里 `nsfw` 正确，这两个 API 不需要重写。

### 8. 前端逻辑保持不变

前端共享卡片渲染器已经按 `card.nsfw` 加 `.bgm-nsfw`。

后端修复后：

- 番组计划返回 `nsfw: true` → 显示粉色遮罩。
- 放送日历返回 `nsfw: true` → 同样显示粉色遮罩。

## 测试计划

### shared merge 测试

新增或扩展 `packages/shared/src/merger.test.ts`：

- `SlimSubject` 没有 `nsfw` 时，subject meta map 可写入 `MergedEntry.nsfw = true`。
- 没有 meta 时保持现有 fallback：`subj?.nsfw ?? false`。
- `primaryMerge()` 正确透传 subject meta map。

### worker cron 测试

扩展 `packages/worker/src/cron.test.ts`：

- subject detail 返回 200 且 `nsfw: true` 时，收藏快照写入 `nsfw: true`。
- subject detail 返回 200 且 `nsfw: true` 时，日历快照写入 `nsfw: true`。
- subject detail 返回 404 时，缓存 meta 为 `nsfw: true`、`reason: not_found_or_restricted`。
- KV 已有未过期 `subject:meta:{id}` 时，不重复调用 `getSubject()`。
- enrichment 请求数量不超过预算。

### API 测试

扩展 collections/calendar handler 测试：

- `NSFW_SHOW=false` 时过滤 `nsfw: true` 条目。
- `NSFW_SHOW=true` 时保留 `nsfw: true` 条目，交给前端遮罩。

### 前端测试

现有 `public/src/bangumi-js.test.mjs` 已覆盖收藏和日历共用 renderer。

可补一个源码断言：

- `card.nsfw` 会加 `bgm-nsfw` class。
- `bgm-nsfw-overlay` 仍存在。

## 风险与取舍

### 子请求预算

Cloudflare Workers 有子请求限制。不能对全部收藏和全部日历条目每次全量查 `GET /v0/subjects/{id}`。

必须使用：

- KV 缓存。
- 每次同步预算。
- 收藏优先、日历逐步补全。

### 404 误遮罩

把 404 当作 `nsfw: true` 可能误遮普通但被删除的条目。

这是有意取舍：公开页面宁可多遮罩，不裸露不可确认的受限内容。

### Token 权限

如果部署 token 无权访问 NSFW 内容，`GET /v0/subjects/{id}` 仍可能 404。

保守策略会把这些条目标成 `nsfw: true`，用户体验上会多遮罩，但安全性更好。

### 日历补全速度

日历条目多，首次上线后可能需要多轮同步才能补齐全部 NSFW meta。

可通过提高初始预算或优先今天/本周条目改善体验。

## 推荐实施顺序

1. 增加 subject meta 类型和 KV 读写 helper。
2. 写 TDD 测试覆盖 200/404/cache/budget。
3. 修改 `merge()` / `primaryMerge()` 接收 subject meta map。
4. 修改 `transformCalendar()` 注入 `nsfw`。
5. 在 `runSync()` 中收集 subject ids 并执行限量 enrichment。
6. 跑 `pnpm -r test`。
7. 根据代码变更更新 README 的 NSFW 说明。

## 最终目标状态

数据流应变为：

```text
bgm.tv collection/calendar lightweight data
  + authorized GET /v0/subjects/{id}
  + subject:meta:{id} KV cache
  -> sync snapshot with nsfw boolean
  -> /api/collections and /api/calendar
  -> shared renderSubjectCard()
  -> .bgm-nsfw pink overlay
```


# Comet Design Handoff

- Change: restore-project-quality-gates
- Phase: design
- Mode: compact
- Context hash: 5236c5e05c1b2a5f5384652af8343e1a9a8390611bfe625ffcf84c090c55e1ac

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/restore-project-quality-gates/proposal.md

- Source: openspec/changes/restore-project-quality-gates/proposal.md
- Lines: 1-26
- SHA256: ff64aa912814ca043af8af235daa7dfa40ff2719d8b56e9065a46f541ab4ac65

```md
## Why

仓库缺少测试、类型检查和部署前质量门，且 pnpm/npm 状态混杂；R2 图片能力在文档和类型中存在，但运行链路已经删除。项目需要恢复“声明的架构等于可验证实现”的基本约束。

## What Changes

- 对 R2 图片能力作出明确收敛：只保留能够端到端运行并验证的实现，否则删除绑定、接口、路由和文档承诺。
- 统一使用 pnpm，清理 npm lockfile 和与项目运行无关的本地工具依赖污染。
- 添加最小业务测试，覆盖合并、primary 保护、鉴权和同步输入等高风险逻辑。
- 添加 TypeScript 类型检查、Wrangler dry-run 和部署前静态检查。
- CI 使用锁定版本和 frozen lockfile，在检查未通过时禁止部署。
- 更新 README、设计文档和运行配置，使其只描述真实存在的能力。

## Capabilities

### New Capabilities

- `project-quality-gates`: 包管理一致性、测试、类型检查、构建验证、架构文档一致性和死能力清理。

### Modified Capabilities

无。

## Impact

影响根目录 package 配置、pnpm lockfile、Worker 配置、R2 相关模块、测试文件、CI 和项目文档。不会引入与当前规模不匹配的测试框架或通用抽象。
```

## openspec/changes/restore-project-quality-gates/design.md

- Source: openspec/changes/restore-project-quality-gates/design.md
- Lines: 1-40
- SHA256: 630d74a35e8c9fe0a9a56b9931640f28112f2951fe891ef8f064fbb6eb618c8c

```md
## Context

仓库使用 pnpm workspace，但本地工具安装引入了 npm lockfile 和未同步的根依赖；项目没有测试和类型检查脚本。R2 绑定、接口、路由和文档仍存在，而同步端不再生产图片。

## Goals / Non-Goals

**Goals:**

- 建立与项目规模匹配的最小质量门。
- 清除包管理和架构声明漂移。
- 对 R2 能力作出可验证的保留或删除决定。

**Non-Goals:**

- 不引入复杂测试平台、覆盖率服务或通用 CI 框架。
- 不把 Codex/Comet 工具依赖变成产品运行依赖。

## Decisions

- pnpm 为唯一包管理器，根 `packageManager` 固定版本，CI 使用 `--frozen-lockfile`。
- 使用 Node 原生测试能力或已安装工具实现最小测试集；只有现有能力不足时才加一个轻量测试依赖。
- 增加 `typecheck`、`test`、`build:check` 三个清晰脚本，CI 依次执行后再部署。
- Ponytail 取向：默认删除没有生产者的 R2 图片链路和虚假图片字段；只有深度设计证明能在 Worker 限制内以小改动恢复完整链路时才保留。
- 使用 Wrangler 生成的 Env 类型替代手写绑定接口，并启用必要的可观测性配置。

## Risks / Trade-offs

- [删除 R2 后卡片暂时无封面] → 数据模型可直接保留 bgm.tv 图片 URL 或明确使用占位图；具体隐私与缓存取舍在深度设计确认。
- [测试基础设施也会膨胀] → 只覆盖高风险分支，不追求行覆盖率。
- [工具配置属于用户未提交改动] → 只清理明确属于项目依赖的冲突，不删除用户的 Codex/Comet 文件。

## Migration Plan

先统一包管理和脚本，再加入检查，最后处理 R2 与文档；CI 在全部检查通过后切换为强制门禁。

## Open Questions

深度设计阶段确认图片最终策略：直接使用上游 URL、恢复受限缓存管线，或接受无封面。

→ **已确认**：恢复受限 R2 缓存管线，单 Worker 内完成。Cron 同步时拉取封面写入 R2，加并发限流控制避免 CPU 超限。多 Worker 拆分作为后续独立 change。
```

## openspec/changes/restore-project-quality-gates/tasks.md

- Source: openspec/changes/restore-project-quality-gates/tasks.md
- Lines: 1-18
- SHA256: af6f2b253fab2543c69ebb81017fc911121a6075169ba7471dc0b415f2ac5f70

```md
## 1. 包管理与类型

- [ ] 1.1 固定 pnpm 版本并同步唯一 lockfile
- [ ] 1.2 移除 npm lockfile 和不属于产品的根运行依赖
- [ ] 1.3 添加 TypeScript 与 Wrangler 生成的 Env 类型

## 2. 架构清理

- [ ] 2.1 确认图片策略并删除或恢复 R2 端到端链路
- [ ] 2.2 删除未使用接口、绑定、路由和失真的数据字段
- [ ] 2.3 更新 README、设计文档和配置以反映真实能力

## 3. 最小质量门

- [ ] 3.1 添加合并与 primary 失败保护测试
- [ ] 3.2 添加管理鉴权和同步输入测试
- [ ] 3.3 添加 `test`、`typecheck` 和 `build:check` 脚本
- [ ] 3.4 在 CI 中使用 frozen lockfile 并按顺序运行所有检查
```

## openspec/changes/restore-project-quality-gates/specs/project-quality-gates/spec.md

- Source: openspec/changes/restore-project-quality-gates/specs/project-quality-gates/spec.md
- Lines: 1-43
- SHA256: 0d18c95c97d569d52150b18d8c53f2e304f655bf616ae74df166a9d34515c7b1

```md
## ADDED Requirements

### Requirement: 包管理器必须唯一
仓库 MUST 使用 pnpm 及其锁文件作为唯一依赖来源，CI MUST 使用 frozen lockfile。

#### Scenario: npm lockfile 被加入仓库
- **WHEN** 质量检查发现 `package-lock.json`
- **THEN** 检查失败并提示使用 pnpm 更新依赖

### Requirement: 高风险逻辑必须有自动检查
合并、primary 失败保护、管理鉴权和同步输入验证 MUST 有可运行的自动测试。

#### Scenario: primary 保护被回归破坏
- **WHEN** 主账户失败后代码生成空快照
- **THEN** 测试失败

### Requirement: 类型和 Worker bundle 必须可验证
每次部署前 MUST 完成 TypeScript 类型检查和 Wrangler dry-run。

#### Scenario: Worker 绑定类型与配置漂移
- **WHEN** 代码引用未声明绑定或类型不匹配
- **THEN** 类型或 bundle 检查失败且不会部署

### Requirement: 声明能力必须可运行
README、架构文档、配置和代码中声明的外部能力 MUST 有完整运行路径；无法端到端工作的能力 MUST 被删除或明确标记为未提供。

#### Scenario: R2 图片链路没有生产者
- **WHEN** 同步流程不写入图片而前端仍依赖 R2 hash
- **THEN** 质量验收失败，必须恢复完整管线或删除该能力

### Requirement: CI 工具版本必须可复现
CI MUST 使用仓库声明的包管理器和依赖版本，不得用浮动 latest 替代锁文件。

#### Scenario: 新版 pnpm 发布
- **WHEN** 上游发布新的 pnpm 版本
- **THEN** 未修改仓库配置的部署仍使用已声明版本

### Requirement: 文档必须通过实现核对
README 和技术设计 MUST 与当前路由、绑定、同步行为及部署流程一致。

#### Scenario: 功能被删除
- **WHEN** 代码删除某项能力
- **THEN** 同一 change 内同步删除或修改相关文档说明
```


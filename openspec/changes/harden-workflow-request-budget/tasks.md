## 1. 预算模型与 durable continuation

- [ ] 1.1 通过官方限制、Worker 类型与现有调用点定义 typed external/internal invocation budget，并为所有计算增加终态与重试余量测试
- [ ] 1.2 引入版本化 fetch continuation manifest 与确定性新 step 名，使任意用户/页数的 collections 获取按外部预算跨 invocation 续跑
- [ ] 1.3 将 calendar 和完整输入 prepare 放入有内部预算余量的 continuation 阶段；缺页、损坏 manifest 或最终重试失败时 fail closed

## 2. 安全终态与兼容运行

- [ ] 2.1 将 live refresh planning、reservation、commit、finalize 与 record-error 接入统一内部预算边界，并保留固定 planner 时间和 replay 幂等性
- [ ] 2.2 保持旧运行实例的历史 step 兼容，确保 shadow 隔离、legacy 公共读取、媒体预算与 Queue 契约不发生变化

## 3. 验证与运维文档

- [ ] 3.1 添加多用户 50+ 页、外部/内部预算边界、休眠恢复、分页失败、预算尾部重试和终态记录的 RED→GREEN 回归测试
- [ ] 3.2 更新 README、同步设计和运维证据，运行全仓门禁、materialized Wrangler dry-runs 与 OpenSpec 严格验证

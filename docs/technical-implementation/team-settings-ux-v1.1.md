# 团队设置 UX v1.1 实现记录

本次落实方案 P0 / P1（Phase 1、2）。复用原 Team Schema、持久化接口和 Runtime，不新增后端配置字段。

## 已实现

- `renderer/team/` 独立语义层：角色预设、五种团队模板、草稿与运行时映射、按职责生成提示词。
- 三步创建：选择用途、确认成员、查看工作方式。ID 自动生成，创建和编辑过程中保持稳定。
- 成员卡片与原生 modal dialog：名称、职责、角色、工作权限、任务分派、模型继承；高级设置折叠。
- 运行情况单独展示成员启停、当前任务、等待任务、最近任务、未读数、模型、时间和 Token 用量。
- 团队预览、自动并发、创建后的对话示例、删除说明。
- 未保存的草稿不随团队刷新被覆盖；切换团队或新建时提示放弃修改，保存携带原始 revision。
- 团队设置入口遵循 `projectBound`，普通未绑定项目的对话不再误用临时工作目录创建团队。

## 兼容与边界

- 旧成员保留显式 `false`、空提示词、空工具数组、禁用但带参数的 spawn，以及自定义 Profile / Provider / Model。编辑名称和职责不会覆盖手写提示词。
- 自动提示词通过确定性内容识别，重新打开后修改职责会重新生成；也可以显式恢复自动生成。
- Profile 的只读限制仍由 Runtime 执行。基础编辑器对内置只读角色禁用可写选项；自定义 Profile 的真实限制由运行时决定。
- 默认不写工具策略；高级设置支持精确工具列表和恢复默认。能力开关属于后续 Capability Preset。
- 自动并发取启用成员数，范围 1–3。由于现有 Schema 只保存数字，重开已有团队按“自定义”展示已保存值，不猜测原先是自动还是手动设置。
- 团队预览是职责分工，未虚构工作流顺序或 worktree 自动隔离保证。
- P2（动态 Profile Registry、模型自动路由、AI 自动生成团队、Capability Preset）未实现，保留在后续范围。
- 提示词已做角色内容与再生成测试；真实模型任务质量对比、灰度委派数据验证仍需后续评估，不能由映射单测代替。

## 验证入口

```sh
pnpm typecheck
pnpm lint
pnpm exec vitest run packages/orchestration/test apps/desktop/src/renderer/team-settings.test.ts
pnpm --filter @desktop-agent/desktop build:e2e
cd apps/desktop
pnpm exec playwright test -c playwright.electron.config.ts e2e/team-settings.spec.ts
```

Electron 用例覆盖项目绑定、模板创建、增删成员、切换角色/权限/委派、提示词与工具覆盖、团队保存、运行页成员启停、刷新时保留草稿、重新打开高级配置和恢复模型继承。

本次验证结果：全仓 TypeScript 检查和 ESLint 通过；22 个测试文件、168 项单元/编排回归通过；Electron 构建通过，团队设置端到端用例通过。构建保留现有的 bundle 体积提示。端到端测试使用临时数据目录，不修改用户真实团队。

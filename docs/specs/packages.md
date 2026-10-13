# 包与宿主边界

一个独立仓库管理 Core 与各插件包。包的名称、公开入口和依赖以 `packages/*/package.json` 为准；workspace 只协调源码开发与构建。

项目与宿主品牌为 QuiFox，字标为 QUIFOX；包名、命令、目录、配置与应用标识使用小写 quifox。应用留在同一仓库的 quifox/{desktop,tui,runtime}，通用 Core 与插件继续由 packages/* 拥有，examples/* 只保存框架组合示例。

## 包归属

Core 不依赖具体模型实现或插件。框架的顶级能力为 Core 与插件包；模型插件拥有连接配置、协议适配与传输调用。调用方配置 ModelPlugin，不组装独立 Provider，也不向 Agent 传入底层模型对象。

每个插件拥有自己的状态、能力接口、顺序、生命周期与失败契约。组合对象只组织自己承诺的关系，不把第三方插件的隐含要求提升为 Core 约束。

新增能力由各 owner 保存合同：[后台任务](../../packages/agent-plugin-tasks/docs/specs/architecture.md)、[Skills/项目指引](../../packages/agent-plugin-project-context/docs/specs/architecture.md)、[请求上下文](../../packages/agent-plugin-request-context/docs/specs/architecture.md)、[两阶段 Memory](../../packages/agent-plugin-memory/docs/specs/architecture.md)。Memory 的派生算法与提示词保留包内 Apache-2.0 LICENSE/NOTICE，不被根 MIT 声明覆盖。

GUI 展示工具与临时能力提示归[展示插件](../../packages/agent-plugin-presentation/docs/specs/architecture.md)；文件与原生 I/O 仍归 Host，标签与媒体交互归 Desktop。

应用专属集成及其依赖属于应用宿主。宿主拥有 UI、业务授权、数据库、认证与网络配置。Formal Backend 是注入 API 的参考组合，不自动兼容任意后端。

当前 QuiFox 宿主由 [shared-runtime](../../quifox/runtime/docs/specs/architecture.md) 统一组装插件、配置、持久化、命令与事件；[TUI](../../quifox/tui/README.md) 和 [Desktop](../../quifox/desktop/docs/specs/architecture.md) 只提交相同命令与展示结果。Rust 只管理窗口和 Bun sidecar，不建立第二套 Agent 状态 owner。

## 构建边界

workspace 使用根 package.json 固定版本的 Bun 管理依赖与脚本；package.json 声明 packages/*、examples/* 与 quifox/*，bun.lock 是唯一依赖锁文件。根构建按包依赖顺序执行，局部验证使用包名过滤，不引入自定义 workspace 调度器。

每个包继续由 TypeScript 编译到 dist 并生成声明；Bun 的 TS 执行不替代 strict 类型检查。分发范围以各自 package.json 的 files 字段为准。Core 与通用插件保持 ES2022 ESM，不引入 Bun/Node 专属 API 或环境 I/O；Bun 专属能力只属于 Host 或开发工具。

现有测试继续使用 Vitest，V8 覆盖率范围由 vitest.coverage.config.mjs 定义；两者运行在 Node.js 22.12+，由 `bun run test` / `bun run test:coverage` 调用。`bun test` 是另一套测试运行器，不作为现有测试入口。切换包管理器不同时改写测试合同或宣称所有开发工具都使用 Bun 运行时。

TS 配置保持 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes 和未使用检查；ESLint 与测试 lint 由 eslint.config.mjs 和根脚本统一维护。无增量事件的 Hook 生成器、生成器/getter 的具名 owner 引用及显式 `_` 忽略值是合法合同；异步断言必须被等待或返回，禁止 focused/skipped tests 与重复测试标题。

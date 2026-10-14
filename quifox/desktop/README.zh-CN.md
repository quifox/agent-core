# QuiFox Desktop

[English](README.md) | [简体中文](README.zh-CN.md)

Tauri 2 + React + 编译的 Bun sidecar。工作目录、会话、聊天、审批、Skills、Memory 与可展开的工具/子任务轨迹，均调用与 TUI 相同的 [Host](../runtime/README.zh-CN.md)。Rust 拥有窗口与进程桥。

设置在主内容区打开，Skills 和 Memory 收在设置中，无需先创建会话。左上“插件”查看已安装能力，已有会话还可查看实际装配。模型可从 Models.dev 的 Chat 供应商目录选择，也可手动配置自定义 Chat；接口没有提供的思考档位保持未配置，可开启手动能力覆盖。显式能力配置优先，全局 `high` 仅在模型已知支持时发送。

在仓库根目录运行，需要 Bun 与本机 [Tauri 前置环境](https://v2.tauri.app/start/prerequisites/)：

```sh
bun run --filter @quifox/desktop desktop:dev
bun run --filter @quifox/desktop desktop:build
```

构建按 Rust 宿主 target 生成引擎，并从原创蓝黄狐狸 SVG 生成图标。macOS 会对完整 sidecar 签名并验证；`APPLE_SIGNING_IDENTITY` 可指定签名身份，否则本地构建使用 ad hoc 签名。发行签名/公证属于单独发布工作，参见 [Bun 可执行文件签名](https://bun.com/docs/bundler/executables#code-signing-on-macos)。

在设置中配置 Chat 模型列表，或使用共享 `MODEL_*` 环境变量。默认资料目录为 `~/.quifox`；`QUIFOX_ROOT`、`QUIFOX_WORKSPACE` 指定独立根目录与工作目录。同一资料目录可以打开多个宿主，独立运行不同会话；每棵会话树保留唯一执行者。

终端运行应用可执行文件时，默认将当前目录作为初始浏览目录，无需设置 `PWD` 环境变量；可用 `--workspace /path/to/project` 覆盖该目录。输入框上方的原生目录选择器在同一窗口选择新对话的工作目录；已有会话保留自己的目录与继承配置。插件中的观察入口先显示按项目分组、可搜索的会话列表，选中后查看运行详情，返回列表不会改变聊天选择。

启动显示新对话，历史显式选择。**⌘/Ctrl+N** 新建会话，**Enter** 发送，**Shift+Enter** 换行；输入区可选择模型与思考强度。Queue/Steer、直接/逐次授权、MCP 与 Agent 定义放在设置。正文支持 Markdown，区分用户与 Agent；工具展示操作摘要和真实差异。右栏显示文件、本轮修改、子/后台任务，执行详情按需打开；黑白深浅主题默认跟随系统。

新建直接进入空白对话，不弹创建表单。输入框上方通过原生目录选择器选择工作目录，取消保留草稿；发送首条消息才保存会话。未选目录时，Host 创建 `~/.quifox/workspaces/YYYY-MM-DD/new-chat`，同日后续目录使用 `-2`、`-3` 后缀。已有会话显示原工作目录；只有已知支持的思考档位时才显示思考选择控件。

切换会话或提交被拒绝时保留草稿；回执不确定时使用同一身份重试。可从侧栏、任务面板或轨迹进入子会话，通过父会话按钮返回。密钥输入留空保留现有密钥，未编辑 URL 保留隐藏参数。旧目录/配置失效的会话仍可读，修复后恢复执行。

输入 `/spawn 3 保留这些需求`，从同一当前上下文前缀创建待机子 Agent。回执展示实际名称与 ID，并可打开对应子会话。`@Turing @Curie 审查 @Newton 搜索` 向 Turing/Curie 发送第一段，向 Newton 发送第二段。接收者补全包含当前会话树中的所有子 Agent 与后代，也包含模型工具创建的任务。部分接纳失败时保留草稿，重试不重复派发已接纳消息。

右侧工作区可调整宽度，分别保留源码、Markdown、图片、视频和真实本轮差异的标签页。文件树可收起、筛选嵌套文件，也可在没有会话时选择浏览目录。代码支持行号、语法高亮、查找与换行；差异支持并排、统一展示和折叠未修改内容。图片支持适合窗口、缩放和展开预览；切换或关闭视频会停止播放。文件也可交给默认应用或 VS Code 打开。

Desktop 展示插件提供 `open_view`，让 Agent 展示任意目录中的本地文件；尚未安装时，在插件页安装并启用“Desktop 展示”。相对路径使用会话工作目录。回执确认实际打开的标签页，HTTP(S) URL 交给默认外部浏览器；完整内嵌浏览器暂缓。TUI 宿主不注册此工具，展示指引只进入当前模型请求。

纯浏览器 Vite 预览没有原生引擎。前端构建、原生窗口与真实模型请求分别证明不同结果；实验性宿主不宣称生产就绪或多平台验收。

参见 [Desktop 合同与行为锚点](docs/specs/architecture.md)。

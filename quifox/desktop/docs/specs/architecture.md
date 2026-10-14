# QuiFox Desktop

工作流插件启用后提供顶级工作流入口。保存列表选择脚本，主区采用左图右多轮对话；对话复用相同 ChatRuntime、Conversation 与输入区，Host 仍拥有消息和运行状态。只读图使用 React Flow 与自动布局，初始为入口与注解方法之间可解析的调用关系，不推断执行顺序。dynamic-workflow 围栏在普通对话中渲染图卡，运行打开右侧工作流测试面板。脚本校验失败显示可定位诊断，不生成虚构节点。

图复用 [React Flow 布局](https://reactflow.dev/learn/layouting/layouting) 与[无障碍能力](https://reactflow.dev/learn/advanced-use/accessibility)，Dagre 同时计算节点和连线路径，默认从左到右排布调用层级，兄弟分支分行。调用关系视图汇总每个定义的本轮已观测调用次数；调用实例视图展示真实父子调用树，循环与并行分别保留各自实例。点击或键盘选中节点可查看调用状态。虚线为静态关系；只有真实父子调用证据使连线变为实线和状态色。未调用显示“尚未调用”，不是推断跳过或失败。运行中使用琥珀色、完成绿色、失败红色；状态同时提供文字，不依赖动画。更新状态不重置视口，用户可缩放、平移和适合窗口。

图使用 Host 会话终态兜底收束缺少结束事件的调用；重启恢复为停止或错误的会话不能继续显示运行中。缺少真实返回的调用显示已中断，已有完成和失败事实保留，不推断未知副作用已回滚。

Desktop 使用 Tauri 2 + React + Bun sidecar，复用 shared-runtime 的命令/事件协议与所有通用插件，Core 不因 GUI 改动。Rust 不组装另一套 Agent，也不拥有会话历史。

首期原生安装包交付 Linux .deb、macOS .dmg 与 Windows NSIS .exe；Linux 平台缺省目标为 deb，流水线核对包内引擎与 Bun 编译产物逐字节一致。当前 AppImage 部署链在处理 Bun sidecar 后检查失败，未提供经验证的产物；不能以跳过失败检查宣称可分发。发布签名、公证与实际安装验收独立报告。

业务数据通过语义 renderer 展示，不直接把 JSON.stringify 结果作为用户界面。命令工具展示终端形式的真实命令、标准输出、标准错误和退出状态；文件修改展示 Diff；子 Agent 与后台任务展示名称、中文状态、克制的状态色及适用操作。其他结构数据用具名字段、列表和嵌套展开呈现，隐藏无助于当前操作的内部身份和凭据字段。Markdown 正文中的代码块、文件阅读与真实命令输出保留代码语义；业务 JSON 不因折叠就改为原始 JSON 展示。

思考过程位于对应正文之前。输入区一个按钮在发送、暂停和恢复之间切换；运行中有草稿时可发送排队消息，无草稿时显示暂停图标。待排队列表显示条数、内容预览、逐条删除与前缀引导；引导消息并入聊天展示，不列入排队条数。设置分类复用窗口导航，不再叠加返回对话与折叠标题栏；工具详情归右侧工作区入口，不重复在窗口右上展示详情或已停止。

共享控件以 Radix Primitives 为基础，开关、折叠、提示和弹窗仅有 ui.tsx 一个入口；不在业务页面各自维护焦点锁定、Esc 关闭或弹窗返回焦点。可搜索选择器沿用共享 SelectMenu，普通原生控件保留浏览器键盘语义。依据 [Radix 无障碍设计](https://www.radix-ui.com/primitives/docs/overview/accessibility)、[WAI-ARIA 弹窗模式](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) 与 [WCAG 2.2 目标尺寸](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)，控件具有可访问名称、可见焦点与键盘路径；状态同时提供文字，不仅靠颜色表达。字号由同一 token 管理，默认 18px；界面缩放不复写字号。聊天、输入、审批与接纳回执共用内容宽度，空列表、加载和失败分别用语义状态组件表示，不留无意义筛选输入。

聊天视口与跳到最新消息使用 MIT 的 [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store) 和 Thread primitives；chat-runtime.tsx 仅适配 Host 已有消息、流式正文与运行状态。消息提交、草稿、排队、审批和恢复仍调用同一 Host，不启用 LocalRuntime、云会话或另一消息存储。自动滚动与历史阅读由 Thread viewport 统一管理，不叠加手写自动滚动循环。工具与业务结构保留本项目的语义 renderer。

浏览器自动化通过 Playwright 驱动正式 App 与 DesktopEngine，合成 EnginePort 隔离原生文件、用户数据与模型请求；覆盖流式交接、消息排队/引导、暂停/恢复、缩放、导航、弹窗焦点、审批对齐和观察页滚动。截图、trace 与报告留在忽略的 artifacts 中。该验收证明 Web UI 行为，不能替代真实 Tauri sidecar、原生窗口与平台打包验收。

终端启动的 Host 默认浏览目录沿用进程当前目录，无需设置 PWD 环境变量；显式 --workspace 或 QUIFOX_WORKSPACE 仍可覆盖。Desktop 新对话在未选择工作目录时采用下述日期目录，与 Host 启动默认目录区分；TUI 缺省创建仍使用启动目录。输入区选择工作目录与工作区选择浏览目录共用一个原生目录选择入口，浏览选择不改会话目录；工作目录选择先读取继承配置，取消或失败保留选择和草稿。不从历史会话自动恢复项目。目录选择使用官方 [Tauri Dialog](https://v2.tauri.app/plugin/dialog/) 的 Rust API，桌面端跨平台支持由插件提供；前端不获得任意文件系统权限。

观察插件入口先展示按工作目录分组、可搜索的会话列表，再进入所选会话的运行详情；返回列表保留筛选。列表收窄居中，目录分组只显示末级名称，完整路径保留在悬停提示和可访问名称中。观察目标独立于聊天选择，不要求先打开聊天或创建会话。列表只读取全局会话摘要，进入详情才读取目标的观测与轨迹；只读导航不发起模型请求、改变已有会话装配或取得执行租约。详情跟随 Host 刷新，空运行、目录不可用和读取失败分别表达，过期响应不得覆盖新目标。没有聊天会话时，插件配置投影使用窗口所选工作目录，而非固定启动目录。

窗口顶层工具区统一提供侧栏折叠、后退/前进和页面标题，位于侧栏与主内容之上，不再保留独立的内容标题栏。工具区保持固定显示尺度并为 macOS 原生窗口按钮预留位置，内容缩放不使二者重叠；空白与标题为拖拽区域，交互按钮不参与拖拽。macOS 采用 Overlay / hiddenTitle 保留原生关闭、最小化与全屏按钮，其他平台保留系统窗口装饰；依据 [Tauri 标题栏配置](https://v2.tauri.app/reference/config/#titlebarstyle) 与 [窗口拖拽权限](https://v2.tauri.app/learn/window-customization/#permissions)。窗口内导航历史由一个 UI owner 管理对话、工作目录、设置、插件页面和观察目标；输入草稿继续按会话保留。新位置访问清除前进分支，重复访问当前位置不制造记录，列表筛选只更新当前位置。插件和观察内容不再各自叠加返回工具栏；导航恢复仅恢复展示位置，不执行任务、配置写入或取得执行租约。

插件一级入口展示我的插件与插件市场。市场筛选全部/已安装，我的插件筛选全部/启用/禁用。已安装能力使用卡片和同一 Host 配置启停；内部 Hook 收进装配详情。普通详情采用可关闭对话框；自定义 surface 在足够宽的独立插件面板展示，Observability 分轨迹、上下文与指标。轨迹复用真实事件与调用身份展示输入/回执与时间概览，运行中的调用只给开始标记；调用类型用克制的语义色区分，成功回执用检查标记减少重复状态文字。模型设置只列出连接 Profile，新增/编辑在可关闭弹窗中完成；模型目录自动获取，没有手动刷新主流程。普通设置标签/控件左右排布，中文导航，主题选项、独立字号与可编辑快捷键有明确控件；Memory 即使为空仍展示实际 memory.md 文件入口。

无会话管理页等待实际资源预览就绪，不以 Host 浏览起点代替配置目录。尚未选择工作目录时，插件和 MCP 只提供全局配置；选择目录或进入会话后才提供当前目录作用域。切换配置目录时，MCP 与资源查询的过期成功和错误回执都不能覆盖新目录状态。

- 窗口启动一个编译的 quifox-engine sidecar。前端经 Tauri command 写入带 id 的 JSONL 命令，Rust 按完整行解析输出并用 Channel 返回响应/事件；部分行保留到下一块，坏帧明确失败。stderr 不进入业务协议。
- macOS 在 Bun 编译完成后签名并验证引擎，Tauri 继续签名完整 app；本地默认 ad hoc，APPLE_SIGNING_IDENTITY 可覆盖。发布身份/公证另行处理，不能跳过签名验证掩盖本机不可执行产物。
- 应用目录由共享 Host 决定，默认 `.quifox`；每次启动可创建独立 Host，目录可共享，会话树租约保证一个执行 owner。打开应用显示新对话，旧主/子会话通过导航明确选择；外部 owner 的会话可只读查看。关闭窗口先发 close 让 Host 停止和收尾，再关闭进程；异常退出留下真实未知状态供重启核实。
- 主界面按工作目录组织会话，保留当前会话输入草稿；父子会话可切换并回到父会话。消息和运行轨迹分开展示，工具参数/配对结果可展开；无结果的调用保持运行或未知，不能推断成功。
- 新建按钮与快捷键直接进入空白对话、聚焦输入，不显示地址输入或创建表单，不提前持久化空会话。输入框上方提供工作目录入口，使用原生目录选择器；取消保留目录与草稿，明确新建清空未保存的新对话草稿，不清理已有会话草稿。发送首条消息才创建会话。未选目录时由 Host 在 `.quifox/workspaces/YYYY-MM-DD/new-chat` 创建独立目录，同日目录已存在则依次使用 `new-chat-2` 等；日期采用宿主本地日期，不使用随机目录名称。已有会话显示其实际目录，不在原会话内改写工具工作目录。
- 子任务轨迹嵌套实际子事件；replan 的明确回执与原调用配对，not-started 与 unknown 分开。压缩只展示成功配对提交后的检查点；界面不从文案推断提交或任务完成。
- 接纳模式在设置中管理，缺省 Queue；Steer 由共享 Inbox 在完整请求边界接纳。输入区直接选择当前会话模型与思考强度，不在运行中切换。暂停和唯一的恢复操作（replan）、审批、配置、Skills 与 Memory 都调用同一 Host 命令。
- 设置占据主内容区，Skills、Memory 与 Agent 定义在设置内展示；读取目录资源不要求先创建会话。左上插件入口展示已安装能力及配置，只有已存在会话时展示实际装配顺序；无会话的管理与历史观测入口不要求模型可执行。Memory 禁用与 MCP 未连接不冒充启用。
- 会话侧栏与设置分类导航都可完整折叠；展开入口保持可见且带明确名称、展开状态与目标。设置只管理全局默认审批，当前会话的逐次询问/完全访问在输入区选择，不重复显示状态说明；完全访问直接执行可用能力，不叠加项目目录白名单或逐次批准。Context 保留三个配置字段，安全余量默认 10,240 Tokens；预算规则放在问号提示，不占据独立下方区块。
- Settings 使用可折叠的左侧分类导航与独立领域页面；模型、外观、交互、权限、MCP、Agents、Skills、Instructions、Memory、Context 分域，压缩配置归 Context。资源列表的开关保留辅助技术名称，不重复显示“启用名称”；搜索用紧凑工具栏，空列表不展示无意义搜索框。资源状态与辅助说明使用 EmptyState、StatusMessage、FieldHint、SectionDescription，不用裸段落代替状态组件；tokens.css 是字号、间距与控件尺度的入口。Radix 承担 [Switch](https://www.radix-ui.com/primitives/docs/components/switch)、Dialog、Collapsible、Tooltip 等通用交互，不引入第二套 Agent runtime。
- 全局界面缩放为 80%–140%，设置和 Cmd/Ctrl +、-、0 共享 Host preferences.uiScale；快捷键写入串行化，失败保持真实反馈。Composer 的 @Agent、$Skill、/Skill、/Command 共用建议面板，Enter/Tab 接纳、上下筛选、Esc 隐藏且保留草稿；Skill 插入准确 catalog 身份，指令仍由 Host 执行。
- 插件页面采用卡片、普通详情弹窗与独立 surface；Host 提供可选 surface kind/title，Desktop renderer registry 只渲染受支持的 kind，未知 kind 显示通用详情。Observability 展示 journal 折叠出的 Run/Model/Tool、Token、错误、恢复、Eval/variant、请求组合；缺失 usage 显示未知，长轨迹与正文按需展开。
- 模型连接可从 Models.dev 的 Chat 供应商与模型目录选择，也可手动配置自定义 Chat。目录没有声明的思考档位不推断；用户覆盖优先。配置覆盖用六档多选，输入区用黑白键盘可操作菜单，只展示当前模型支持的档位；没有可选档位时隐藏整个思考控件，不显示“思考档位未配置”等占位。输入区直接选中当前生效值，不单列“继承设置”；选择与默认相同的档位恢复配置继承。默认来自连接配置或受支持的全局偏好，不标称供应商默认。密钥不从公开快照读回。
- 蓝身体、黄耳朵狐狸是 QuiFox 的可复用矢量标识；应用主体只有黑白深浅两种主题，可跟随系统。正文使用 React Markdown/CommonMark/GFM，保留代码、列表、表格与安全链接，关闭原始 HTML；外部图片不自动加载。依赖为维护活跃、MIT 的 [react-markdown](https://github.com/remarkjs/react-markdown) 与 [remark-gfm](https://github.com/remarkjs/remark-gfm)。差异使用 BSD-3-Clause 的 [jsdiff](https://github.com/kpdecker/jsdiff)，以真实 before/after 为输入，计算与展示有界，截断明确说明。
- 主界面为会话导航、对话、工作区三栏；启动先显示对话，工作区由用户打开或展示工具/文件引用展开。工作区可拖动调宽、收起与放大还原，标签页支持切换和关闭，内部文件树独立开关；窄窗切换到工作区时隐藏被覆盖的对话控件。文件树与阅读不依赖创建会话；原生目录选择器可独立切换浏览目录，保留已打开标签，目录展开和筛选不创建另一会话 owner。采用 [Tauri Dialog](https://v2.tauri.app/plugin/dialog/) 的目录选择接口。文件与工具修改引用打开工作区标签，不使用大文件弹窗。
- 文件阅读器使用 MIT 的 [Monaco Editor](https://github.com/microsoft/monaco-editor)，只读、行号、语法高亮与查找；编辑器/model 关闭或切换时 dispose。差异输入来自真实工具 before/after，上一轮按实际 runId 选择，会话累计与上一轮区分，支持统一/左右对比与未改上下文折叠；截断内容标明。工具默认显示自然语言摘要，参数/回执按需展开；审批继续显示真实 Diff。
- 图片支持缩放、适合窗口与展开还原；视频使用原生控件，切换、关闭或隐藏工作区时停止并释放资源，不承诺所有编码。媒体用 Tauri asset scope 加载已选择文件，支持项目目录之外的路径，不另建业务权限；HTML 首期为源码阅读与外部预览，不执行不受信页面脚本。HTTP(S) URL 通过 [Tauri Opener](https://v2.tauri.app/plugin/opener/) 交给外部浏览器，不冒充内嵌浏览器或已加载网页。
- GUI 装配 PresentationPlugin，open_view 复用同一工作区。Host 发送有身份的请求，界面实际创建/选中标签或 OS 打开成功后确认；工具返回实际标签或外部目的。请求超时、取消、窗口关闭与展示失败有明确回执；发送事件不能作为成功。提示只在本轮 RequestContext 注入，TUI 不装配该工具；当前运行宿主决定能力，切换在运行边界重组。历史回执不删除，未知请求在不具备重试保证时不得盲重试。
- 历史展示按有限窗口读取，完整模型上下文和原始归档不裁剪；流式增量单独更新，不因每个 token 重传或扫描全部历史。UI 验收包含长会话、窄窗口、键盘、焦点、长工具内容与错误/停止/审批状态；浏览器自动化与原生窗口验收分开，跨平台打包成功不替代交互验收。
- 输入区不常驻 Enter/Shift+Enter 操作讲解，首页不重复列出已由任务建议表达的通用说明；状态、字段约束与正文按语义保留。切换会话等待快照期间不允许发送或修改模型配置，思考控件也不沿用上一会话。
- 弹窗统一使用 Radix Dialog，背景不可交互，关闭恢复触发控件焦点。提交被拒绝时保留草稿，成功确认后只清空同一份输入。进程故障拒绝待处理/后续命令，显式重连后才能继续；观察订阅异常不影响 RPC 回执。

行为锚：[Codex app](https://developers.openai.com/codex/app/) 与 [subagents](https://developers.openai.com/codex/subagents/)，[DSH Workspace](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/README.md)、[Subagent](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-subagent/README.md)、[Trajectory](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-trajectory/README.md)。桥接依据 [Tauri sidecar](https://v2.tauri.app/develop/sidecar/) 与 [IPC Channel](https://v2.tauri.app/develop/calling-frontend/)。

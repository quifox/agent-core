# AGENTS.md

Scope: quifox/tui。继承根规则，读 [共享 Host 合同](../runtime/docs/specs/architecture.md)。

- Ink 只处理终端输入、布局与展示；命令、审批、会话、工具、子 Agent 和配置走 shared-runtime。
- 展示蓝身体、黄耳朵狐狸与 QUIFOX；读取真实 SessionView/RuntimeEvent，不能创建假工具结果或假进度。
- 审批通过独立的三选项键盘菜单：批准、拒绝、拒绝并回复；上下键选择、Enter 确认，普通消息字符不触发授权。拒绝说明进入对应工具回执，不作为新用户消息另行排队。失败提交保留输入，成功确认只清空原稿；连续输入与重复 Enter 不制造重复接纳。
- 助手与流式正文使用 assistant-ui 的 Ink Markdown 组件及 Shiki 高亮；用户消息使用白底黑字整行，不显示 user/assistant 标签。顶部采用紧凑狐狸、品牌、中文状态与目录摘要；色彩用于结构和状态，不对普通正文任意染色。尊重 NO_COLOR，传入渲染器前清除外部终端控制符。
- Markdown 与代码高亮 API 以 [assistant-ui Ink 官方文档](https://www.assistant-ui.com/docs/ink) 和固定版本声明为准；UI 适配只消费 shared-runtime，不接入第二套执行 runtime。
- NO_COLOR 在 CLI 入口统一关闭 Ink 使用的 Chalk 实例与 Markdown 高亮，避免逐组件维护第二套着色逻辑；全局实例只在应用入口配置，依据 [Chalk level 合同](https://github.com/chalk/chalk#chalklevel)。
- 使用组件测试与真实 PTY 检查输入、流式刷新、宽度、停止、审批和退出资源收尾。跨平台接口复用 Host。
- 按 columns/rows 限制视口；长正文可滚动，草稿保留完整值且只显示光标附近区域，狐狸与明确审批操作不被内容挤走。
- 默认创建新的主会话，旧会话用可视化 /resume 或明确 CLI --resume 选择；不按归档排序自动选择旧主/子会话。/ 前缀展示可筛选命令/Skills，Tab 只用于补全，不切接纳模式；配置、模型与 MCP 有键盘选择入口。
- 流式增量独立刷新；历史消息/轨迹采用有界投影，完整上下文保留在 Host。输出清除非展示控制字符，密钥编辑使用掩码，不能把终端转义或密钥写入可见帧。
- 验证 `bun run --filter @quifox/tui check`；未执行的终端或平台验收明确说明。

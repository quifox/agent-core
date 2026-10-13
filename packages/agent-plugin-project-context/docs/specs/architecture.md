# Skills 与项目指引

本包提供独立 SkillsPlugin 和 ProjectGuidancePlugin，通过 Host 注入的文件端口和请求上下文 writer 工作；不访问 Node、文件系统、网络或 Core 状态。

- [Agent Skills](https://agentskills.io/specification) 为文件格式与渐进读取锚点。目录读取每个 SKILL.md 的 YAML frontmatter，name 与目录一致，description 非空；正文仅在显式选择或 skill_load 时读取，引用经 skill_read 按需读取。采用 [yaml 2 的公开 API](https://eemeli.org/yaml/)，ISC License，支持浏览器且无外部依赖；重复键与非法元数据明确报告。
- skill_load/skill_read 为普通只读工具。资源读取限制在选定技能根目录；脚本只能交给 Host 的普通执行工具，其 policy 与审批不受 allowed-tools metadata 自动放宽。
- 根标识由 Host 提供，文件相对引用使用 `/`；拒绝绝对路径、反斜杠、空段、`.`、`..`、URI 与编码穿越。Host 必须用真实路径校验符号链接，不能依赖字符串前缀模拟边界。
- [AGENTS.md](https://agents.md/) 为项目指引锚点。Host 提供当前工作目录的有序祖先作用域；每级优先非空 AGENTS.override.md，再读 AGENTS.md。全局到项目到更具体目录按序贡献，兄弟目录不参与。指引为请求上下文，不伪装成人类原文。
- 读取失败与非法技能条目可观察；基础设施失败不伪装为空目录。不同 Agent 的显式选择和已加载资源相互隔离。文件读取不会执行其中指令，执行始终由模型与普通工具链决定。
- Host 提供的技能根按全局到最近目录排列；同名选择采用最后一个有效条目，精确 catalog identity 仍可选择其他来源。元数据保留来源身份，覆盖不合并技能正文。

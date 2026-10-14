# MCP 工具映射

以 [MCP tools/list 与 tools/call](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 为协议锚点。连接、认证、传输与 SDK 归 Host；本插件不执行隐式网络/进程 I/O，不改变 Core。

- 初始化完整读取分页目录；重复分页游标、工具重名或非法 schema 明确失败。模型名称由 namespace、可读原名和稳定哈希生成，长度符合 Chat 工具名要求；调用仍使用原始 MCP 名称，别名碰撞不静默覆盖。
- MCP JSON Schema 由 [Ajv 8](https://ajv.js.org/guide/getting-started.html) 校验，不裁剪、填默认值或强转参数。Ajv 为 MIT、浏览器可用的纯验证器；支持 draft-07/2020-12，拒绝远端引用与异步验证。Zod 普通 record 贡献 schema metadata，使 Core 公开定义保留原字段；实际参数校验经同一 safeParse/prepare 入口。
- 默认所有 MCP 工具使用 external/host，retrySafe 缺省；Host 可按可信配置提供独立 policy，不能把服务器提示当作批准。结果保留标准 content、structuredContent 与 isError；业务 isError 返回工具 error，传输/协议异常保持基础设施失败和未知副作用语义。
- 取消信号来自 Host 的当前调用，不表示业务回滚。Host 退出时关闭客户端；普通回合结束不关闭共享连接。查询与调用均经普通工具、授权和执行记录入口。

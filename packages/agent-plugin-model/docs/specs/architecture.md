# 模型插件

模型生成是 Agent 插件提供的能力。Core 调用插件的 model Hook 并消费结果，从不接收 Provider 或模型连接对象。

- 使用者为 ChatModelPlugin 配置 Session、模型名称、地址、认证及可选传输和生成参数；协议客户端由插件内部创建。
- ChatSessionPlugin 拥有历史、输入接纳、持久化和恢复。模型插件在 beforeStep 准备请求，等待全部 beforeModel 完成，再通过 Session 接纳最终消息后发起网络请求。
- 协议工厂、HTTP/SSE 解析、供应商字段映射和底层客户端属于本包内部实现；不存在需要使用者组装或注册的独立 Provider 能力。
- 自定义模型实现提供自己的 model Hook，无须实现框架统一的 Provider 工厂。
- 请求变更、流聚合、结束语义和协议错误属于模型插件，Core 不校验具体协议。
- Fork 为子 Session 创建新的生成状态，可复用连接配置，不继承父请求状态和取消信号。
- 子 Fork 可显式绑定自身的 signal 提供者；父子停止相互隔离，摘要和其他请求仍遵循各自传入的信号。
- 压缩通过模型插件生成摘要，不提取底层连接对象。
- ResponsesModelPlugin 接受明确的 Responses 请求输入并提供 onRunStart/model/onRunEnd 钩子。面向 Agent 的请求槽位每次只接纳一个运行，仅由所属 Outcome 释放；被拒绝的重叠调用不能覆盖或释放它。后端会话插件组合它的无状态流式生成与请求投影方法，并拥有服务端游标和检查点。协议工厂仅由本包实现访问，不导出内部子路径。
- 平台传输注入是 I/O 边界；密钥和 Node/微信环境加载属于宿主。
- 模型容量可从 Host 明确提供的 [models.dev 数据](https://github.com/anomalyco/models.dev#api) 与本地配置解析。已知容量与本地值取较小值；缺失元数据保持未知，不凭空补用量或容量。网络与缓存归 Host，资料可见不代表端点可用；实际输出请求与压缩阈值另行归一化。
- `resolveModelCapabilities` 只解析 Host 提供的能力数据，没有网络 I/O；显式 reasoningEfforts 优先。Models.dev 的 reasoning 布尔只表示支持思考，不代表通用六档或供应商默认值。接口未提供的档位保持未知，不用供应商或模型名称建立内置档位表；全局 high 不等同于模型支持 high。
- Chat 的可选 `provider` 选择协议方言，供应商专有参数转换在本包内部完成；例如 DeepSeek 的 none 转为关闭 thinking，其他显式 effort 转为启用 thinking 并发送对应 effort。此转换不声明任何模型支持哪些档位；Host 仍负责依据元数据/用户配置选择值。旧的高思考示例常量只在调用方显式使用时生效，不参与自动能力、默认设置或 Host 装配。

协议测试验证流解析和请求投影；集成测试验证插件组装、多轮历史、工具、Fork、取消与错误传播。合成响应不代表真实模型验证。

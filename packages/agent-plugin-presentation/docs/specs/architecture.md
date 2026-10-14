# 展示插件

PresentationPlugin 注册 open_view，输入为本地目标路径或 HTTP(S) URL。它是只读展示，支持任意目录中的文件；工作目录仅为相对路径基准，不另建目录白名单或权限设置。插件不读文件、不创建 UI、不调用隐式网络；Host 适配器解析目标并等待真实展示回执。规范化目标与请求身份的匹配由适配器验证；相对路径输入可返回绝对路径，插件不自行猜测路径解析，只校验回执的必要字段。

回执为 panel（viewId、target、kind）或 external（target）；external 只代表 OS 接受打开，不代表网页加载。错误和停止返回明确工具失败，尚未确认时不得提前成功。工具不声明 retrySafe，未知恢复不能盲目重复外部动作。

beforeModel 通过注入 writer 提供当前宿主展示能力临时提示；工具被权限移除后不贡献提示。贡献不进入 canonical history，不继承父会话的旧临时上下文。TUI 宿主不注册本插件；GUI/TUI 切换在运行边界装配。

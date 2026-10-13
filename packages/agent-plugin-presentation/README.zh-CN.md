# 展示插件

通过宿主适配器在 Desktop 展示任意目录中的文件、图片和视频。open_view 返回已确认的标签身份，或报告 HTTP(S) URL 已交给外部浏览器。

`new PresentationPlugin({ open, context })` 接收宿主异步展示适配器和请求上下文 writer。只有能够确认界面的执行宿主才注册；路径、原生打开与取消归宿主，插件没有平台 I/O，工具仍受宿主权限约束。

临时提示在每次模型请求前重算，不进入会话原文；未知结果不声明可安全重试。

见[合同](docs/specs/architecture.md)、[共享宿主](../../quifox/runtime)和 [Desktop](../../quifox/desktop)。

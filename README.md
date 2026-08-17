# dsh-longtask-notice-tui

长任务状态通知插件，面向 dsh-TUI。

## 当前目标

- 任务运行超过可配置阈值后，进入“长任务”状态，但不发送通知。
- 任务完成、失败或取消时，发送最终状态通知。
- 任务需要用户输入时，立即发送通知。
- 首批通知渠道规划为 SMTP 和 Generic Webhook。

默认阈值为 10 分钟，可配置。

## 项目状态

当前处于设计阶段。插件依赖的任务生命周期事件和出站通知权限尚未在 dsh-ecosystem-spec v0.15 公共 registry 中定义，因此暂不声明 Community v0.15 conformance。

设计约束见 [DESIGN.md](DESIGN.md)。

## 非目标

- 不通过解析普通消息文本猜测任务状态。
- 不在插件日志中记录密码、token、完整提示词或完整对话。
- 第一版不内置多个厂商通知 SDK；厂商接入优先通过 Webhook 完成。

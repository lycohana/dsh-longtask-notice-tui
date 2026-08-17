# Design: dsh-longtask-notice-tui

## 1. 产品策略

插件采用安静的默认策略：

```text
turn/start
    |
    +-- duration >= threshold --> 标记 long_running，不发送通知
    |
    +-- turn/end: completed --------------------> 最终状态通知
    +-- turn/end: error/max-tokens/interrupted --> 失败通知
    +-- turn/end: aborted ----------------------> 取消通知
    +-- turn/end: blocked ----------------------> 立即发送输入请求通知
```

默认阈值是 600 秒。阈值只改变内部状态，不代表任务失败，也不触发通知。

## 2. 宿主适配

插件遵循 dsh-TUI 的 Cordis 插件入口：

- `name = "longtask-notice-tui"`
- `Config` 是 Schemastery schema，同时导出对应 TypeScript 类型
- `apply(ctx, config)` 注册生命周期监听和可选命令
- 资源通过 `ctx.effect` 清理

实际事件来自 `@deepseek-ai/dsh-session`：

| dsh-session | 插件内部事件 | 处理 |
| --- | --- | --- |
| `turn/start` | `task.started` | 创建任务并启动阈值计时器 |
| `turn/end` + `completed` | `task.completed` | 发送最终完成通知 |
| `turn/end` + `aborted` | `task.cancelled` | 发送最终取消通知 |
| `turn/end` + `blocked` | `task.input_required` | 立即发送输入请求通知 |
| 其他 `turn/end` reason | `task.failed` | 发送失败通知 |

一个 turn 的 task ID 为 `${session.id}:turn:${turn}`，事件幂等 ID 使用稳定的 session ID 与 session event sequence。插件不会通过普通消息文本猜测任务状态，也不会向 session 追加自定义事件。

`dsh-session` 当前没有单独的结构化 input-required 事件，所以 `blocked` 是第一版的保守映射。它能保证“宿主明确阻塞”立即触达，但不能推断阻塞的具体 UI 控件或问题内容。

## 3. 状态模型

任务状态与渠道投递状态分离：

```text
Task:     running -> long_running -> terminal
                       |                  |
                       +-> awaiting_input +-> completed / failed / cancelled

Delivery: pending -> sending -> sent
                         |
                         +-> failed -> retry
```

状态引擎具备以下约束：

- 按 `sessionId + taskId` 建立任务键。
- 每个任务保留最近事件 ID，重复事件直接忽略。
- 每个通知类型、每个渠道有独立 delivery record 和幂等键。
- 终态通知最多对每个渠道成功发送一次；失败会按有界指数退避重试。
- 进程内状态使用 `MemoryStateStore`。session 创建时只恢复日志中尚未闭合的 `turn/start`，不重放已结束 turn，避免重启时重复发送最终通知。
- session disposed 时清除该 session 的计时器和任务记录。宿主持久化 session 日志，因此正在运行的 turn 仍可从 session log 恢复。

## 4. 通知渠道

### SMTP

使用 Nodemailer，要求 TLS/STARTTLS 和证书校验。密码只通过 `SecretProvider` 读取；当前适配器将 secret reference 映射到 `DSH_NOTICE_` 环境变量。

### Generic Webhook

发送版本化 JSON 负载，包含状态、任务 ID、session ID、摘要、耗时、错误或输入请求。请求带 `X-DSH-Idempotency-Key`；配置 secret 时追加 HMAC-SHA256 签名。默认：

- 仅允许 HTTPS；
- 禁止 URL 中携带用户名、密码或 token；
- 解析域名并拒绝 loopback、private、link-local、unspecified 和保留地址；
- 不跟随重定向；
- 使用超时和 AbortSignal；
- 日志只记录渠道 ID、尝试次数和清理后的错误摘要。

如果用户明确使用内网 Webhook，必须同时配置 `allowPrivateNetwork`；如果明确使用 HTTP，必须同时配置 `allowInsecureHttp`。这两个开关是有意显式的风险确认。

## 5. 配置与命令

非敏感配置包括阈值、通知类型开关、重试上限和 channel 配置，示例见 [config.example.json](config.example.json)。secret 不写入普通配置或状态文件。

可选 commands service 存在时，插件注册：

- `longtask-notice-status`
- `longtask-notice-test`
- `longtask-notice-enable`
- `longtask-notice-disable`

命令只访问 engine，不依赖单一 Presentation；没有 commands service 时插件仍可正常工作。

## 6. 安全与隐私边界

- 插件按可信 dsh-TUI 进程内扩展处理，不把配置中的 secret 交给日志、命令返回值或通知模板。
- `summary`、错误和请求摘要会做控制字符清理和长度限制。
- 通知 payload 不携带完整 prompt、transcript、原始工具参数或工具输出。
- Webhook 的默认 DNS/地址检查用于降低 SSRF 风险；放宽时由用户配置承担风险。
- stdout 保持安静，调试信息只在显式开启时写入 stderr。

## 7. 验证计划与当前覆盖

已覆盖：

- 假时钟下的阈值状态转换；
- 完成/失败/取消和 input-required 通知；
- 重复事件与渠道幂等；
- 有界重试；
- 默认配置、Webhook URL 校验、SMTP header 注入校验；
- Webhook HMAC、幂等 header 和私网地址拒绝。

后续可补充：真实 Cordis host fixture、session restore/dispose 集成测试、SMTP transport fixture、通知模板和宿主 secret-store 接口。

## 8. 变更历史

### 2026-08-17 — 0.1.0 初始实现

- 从 dsh-TUI 的 Cordis plugin contract 建立 TypeScript/ESM 包结构。
- 对接 `session/event`、`session/created` 和 `session/disposed`。
- 实现 10 分钟默认策略、终态/阻塞通知、SMTP、Webhook、重试和幂等。
- 增加配置 schema、示例、测试、debug 日志和安全边界文档。

本仓库不声明 dsh-ecosystem-spec Community conformance，因为该公共 registry 尚未定义本插件所需的 task lifecycle 和出站通知能力。

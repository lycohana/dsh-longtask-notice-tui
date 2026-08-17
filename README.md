# dsh-longtask-notice-tui

面向 dsh-TUI 的长任务通知插件。它监听 dsh-session 的 turn 生命周期，在任务真正需要关注时发送 SMTP、Generic Webhook 或 Bark 通知。

源码仓库：[github.com/lycohana/dsh-longtask-notice-tui](https://github.com/lycohana/dsh-longtask-notice-tui)

## 默认策略

- 运行超过 10 分钟（可配置）后标记为长任务，但不发送“超时”通知。
- 任务达到长任务阈值后，完成、失败、取消时发送一次最终状态通知；阈值前结束的短任务不发送最终通知。
- turn 以 `blocked` 原因结束时，按“需要用户输入”处理并立即通知。
- 重复事件、重复加载和同一渠道的重试使用幂等键，避免重复发送。

最终通知会优先展示本轮对话最后一条可见的助手回复；如果没有可用回复才回退到任务摘要。SMTP 和 Bark 的标题、正文会统一使用当前 TUI 语言，不再中英混排；Webhook 负载保留 `lastReply` 字段。

当前插件使用 dsh-TUI 的 Cordis 插件契约：根模块导出 `name`、`Config` Schema 和 `apply(ctx, config)`，不提供旧式 manifest 或 default export。

## 安装与加载

当前版本尚未发布到 npm，可以直接从 GitHub 安装到 `dsh-tui` profile：

```bash
dsh plugin --profile dsh-tui add github:lycohana/dsh-longtask-notice-tui
```

仓库通过 `prepare` 脚本自动构建 `lib` 运行文件，安装包自带 [cordis.patch.yml](cordis.patch.yml)，不需要手工复制 patch。安装或升级后重启 `dsh-tui`，然后在 TUI 中输入 `/notice`。

如果需要离线安装或调试本地源码，也可以执行 `npm run build && npm pack`，再将生成的 `.tgz` 文件传给同一条 `dsh plugin --profile dsh-tui add` 命令。

在插件配置中填写 [config.example.json](config.example.json) 对应的内容。没有配置 channel 时插件仍可加载，但不会发送网络通知。

## 通知渠道

### SMTP

配置用户名、SMTP 服务器、端口、测试邮箱和加密方式（SSL、TLS 或不加密）。发信地址可留空，插件会回退使用用户名；如果 SMTP 服务拒绝别名发件人（553），插件会自动用认证用户名重试。显示名称可选。密码通过 `passwordRef` 指向环境变量或 dsh credentials。插件只读取 `DSH_NOTICE_` 前缀下的环境变量：

```text
passwordRef: DSH_NOTICE_SMTP_PASSWORD
DSH_NOTICE_SMTP_PASSWORD=***
```

默认启用 TLS/STARTTLS 要求和证书校验；密码不会写入日志或通知内容。

### Generic Webhook

Webhook 使用 HTTP POST JSON，带 `X-DSH-Idempotency-Key`。配置 `secretRef` 后还会带 `X-DSH-Signature: sha256=...` HMAC-SHA256 签名。默认只允许 HTTPS，并拒绝解析到本机、内网、链路本地和保留地址；只有明确配置 `allowInsecureHttp` 与 `allowPrivateNetwork` 才会放宽限制。

### Bark

Bark 默认使用官方 API `https://api.day.app`，发送 JSON POST 到 `/push`，内容包含 `device_key`、当前语言标题和通知正文，协议参考 [Bark 官方教程](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md)。也可以将 `apiUrl` 改成自建 Bark Server 的地址；插件会在末尾自动补 `/push`。`device_key` 在面板中输入后会保存到 dsh credentials，普通配置只保存 `deviceKeyRef`，例如：

```text
apiUrl: https://api.day.app
deviceKeyRef: DSH_NOTICE_BARK_DEVICE_KEY
DSH_NOTICE_BARK_DEVICE_KEY=***
```

默认只允许 HTTPS，并拒绝解析到本机或内网地址；使用自建 HTTP 或内网 Bark Server 时，需要显式打开 `allowInsecureHttp` 或 `allowPrivateNetwork`。

## `/notice` 命令

插件通过 dsh commands registry 注册一个根命令，在 TUI 输入 `/` 后即可看到：

```text
/notice
/notice ui
/notice status
/notice on
/notice off
/notice threshold 600
/notice test
/notice test default-email
/notice help
```

`/notice` 和 `/notice ui` 会在当前会话上方打开半屏设置面板，聊天内容保持可见，不会切换到全屏 Scene。面板支持：

- ↑/↓ 选择设置或通知渠道，Enter 切换总开关/渠道启用状态；
- `n` 新增 SMTP、Webhook 或 Bark 渠道；选中渠道后按 `e` 编辑、`d` 删除；
- 选中 SMTP 渠道后按 `t` 会通过该 SMTP 服务器实际发送测试邮件；选中 Webhook 或 Bark 则发送对应测试通知。选中“通知渠道”标题时测试全部已启用渠道；
- Esc 或 `q` 关闭面板。

面板文案跟随 dsh-TUI 当前语言（宿主值为 `zh` 或 `en`，其中 `zh` 对应中文界面），切换语言后无需重启插件即可更新。

`on`、`off` 和 `threshold` 会写入 dsh settings；当前运行中的 engine 会立即应用。没有 settings service 的宿主会退化为当前进程内生效。`test [channel-id]` 可测试全部或指定渠道；SMTP 测试会发送一封真实测试邮件，而不只是检查配置。

测试发送在后台异步执行，面板不会因为 SMTP 网络连接而锁死；失败结果会显示渠道 ID 和清理后的具体原因。SMTP 连接、握手和 socket 默认各有 15 秒超时。

密码、Webhook 签名密钥、Bark `device_key` 等敏感值只在编辑面板中临时输入，通过 dsh credentials 保存；普通设置文件只保存凭据引用，不保存 secret 明文。

## 开发

```bash
npm install
npm run check
npm run build
```

插件不向 stdout 输出内容；调试日志仅在 `DSH_TUI_DEBUG=1` 时写入 stderr。状态只在当前插件实例内保存，并在 session 创建时从仍未结束的 turn 恢复；session 结束时清理对应任务。通知本身不包含完整 prompt、transcript 或工具输出。安装或升级后需要重启 dsh-TUI，命令注册才会进入当前 TUI。

## 兼容性说明

本实现对接的是 dsh-TUI 当前公开的 Cordis/dsh-session 运行时，不声明 dsh-ecosystem-spec Community conformance。`dsh-session` 当前没有独立的 `input_required` 事件，因此第一版将 `turn/end` 的 `blocked` reason 映射为输入请求；待宿主提供结构化请求事件后，适配器可以无损扩展。

更多设计、状态模型和安全边界见 [DESIGN.md](DESIGN.md)。

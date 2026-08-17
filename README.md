# dsh-longtask-notice-tui

面向 dsh-TUI 的长任务通知插件。它监听 dsh-session 的 turn 生命周期，在任务真正需要关注时发送 SMTP 或 Generic Webhook 通知。

## 默认策略

- 运行超过 10 分钟（可配置）后标记为长任务，但不发送“超时”通知。
- 完成、失败、取消时发送一次最终状态通知。
- turn 以 `blocked` 原因结束时，按“需要用户输入”处理并立即通知。
- 重复事件、重复加载和同一渠道的重试使用幂等键，避免重复发送。

当前插件使用 dsh-TUI 的 Cordis 插件契约：根模块导出 `name`、`Config` Schema 和 `apply(ctx, config)`，不提供旧式 manifest 或 default export。

## 安装与加载

```bash
pnpm add @dsh-tui-ecosystem/longtask-notice-tui
```

把插件加入 dsh-TUI 的 bundle patch（本仓库的 [cordis.patch.yml](cordis.patch.yml) 已包含最小示例）：

```yaml
- insert:
    - id: longtask-notice-tui
      name: '@dsh-tui-ecosystem/longtask-notice-tui'
```

在插件配置中填写 [config.example.json](config.example.json) 对应的内容。没有配置 channel 时插件仍可加载，但不会发送网络通知。

## 通知渠道

### SMTP

配置 `host`、`from`、`to` 等非敏感字段，并把 `passwordRef` 指向环境变量。插件只读取 `DSH_NOTICE_` 前缀下的环境变量：

```text
passwordRef: DSH_NOTICE_SMTP_PASSWORD
DSH_NOTICE_SMTP_PASSWORD=***
```

默认启用 TLS/STARTTLS 要求和证书校验；密码不会写入日志或通知内容。

### Generic Webhook

Webhook 使用 HTTP POST JSON，带 `X-DSH-Idempotency-Key`。配置 `secretRef` 后还会带 `X-DSH-Signature: sha256=...` HMAC-SHA256 签名。默认只允许 HTTPS，并拒绝解析到本机、内网、链路本地和保留地址；只有明确配置 `allowInsecureHttp` 与 `allowPrivateNetwork` 才会放宽限制。

## 命令

当 dsh-TUI 提供可选 commands service 时，插件注册以下命令：

- `longtask-notice-status`
- `longtask-notice-test`
- `longtask-notice-enable`
- `longtask-notice-disable`

## 开发

```bash
npm install
npm run check
npm run build
```

插件不向 stdout 输出内容；调试日志仅在 `DSH_TUI_DEBUG=1` 时写入 stderr。状态只在当前插件实例内保存，并在 session 创建时从仍未结束的 turn 恢复；session 结束时清理对应任务。通知本身不包含完整 prompt、transcript 或工具输出。

## 兼容性说明

本实现对接的是 dsh-TUI 当前公开的 Cordis/dsh-session 运行时，不声明 dsh-ecosystem-spec Community conformance。`dsh-session` 当前没有独立的 `input_required` 事件，因此第一版将 `turn/end` 的 `blocked` reason 映射为输入请求；待宿主提供结构化请求事件后，适配器可以无损扩展。

更多设计、状态模型和安全边界见 [DESIGN.md](DESIGN.md)。

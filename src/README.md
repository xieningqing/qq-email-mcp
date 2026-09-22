# Source Layout

生产代码按职责拆分，依赖方向固定为：

```text
mcp -> mail -> adapters | mime | security
```

各目录职责：

- `mcp/`：MCP Server、工具定义、Schema、结果编码。
- `mail/`：邮件业务编排。
- `adapters/`：QQ IMAP 和 SMTP 协议适配器。
- `mime/`：MIME 解析、清洗和附件处理。
- `security/`：凭据、确认、沙箱和审计。
- `config/`：配置模型和加载。

具体规则见 [项目结构](../docs/project-structure.md)。

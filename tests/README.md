# Test Layout

- `unit/`：纯函数和单模块测试。
- `integration/`：适配器、fake 服务和跨模块契约测试。
- `e2e/`：通过 MCP 工具执行的完整用户流程。

默认测试不连接真实 QQ 邮箱。真实账号测试必须显式启用，并使用独立测试账号。

真实账号只读检查：

```powershell
$env:QQ_EMAIL_MCP_E2E = "1"
$env:QQ_EMAIL_MCP_CONFIG = "E:\project\web\qq_email_mcp\qq-email-mcp.toml"
npm test -- tests/e2e/real-account.test.ts
```

该检查只执行 `mail_status`、`mail_folders`、`mail_list` 和一次 `mail_get(mode="agent")`，不会发送邮件或修改邮箱。

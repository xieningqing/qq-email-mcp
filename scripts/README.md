# Scripts

放置构建、检查、测试和发布辅助脚本。业务逻辑不得放在此目录。

计划包含：

- `check`：格式、类型和静态检查。
- `test`：单元和集成测试。
- `test:e2e`：显式启用真实邮箱的端到端测试。
- `build`：生产构建。
- `set-password.mjs`：把 QQ 邮箱授权码写入本地加密凭据文件。
- `smoke-test.mjs`：使用真实凭据完成 MCP 握手，并只读验证 `mail_status`、`mail_folders` 和 `mail_list`。

# QQ Email MCP

一个面向 AI 客户端的单账号 QQ 邮箱 MCP。它通过 IMAP/SMTP 提供可靠的邮件搜索、阅读、附件处理、发送、回复和基础管理能力，并把邮件整理成适合模型理解的结构化上下文。

## 当前状态

已经实现 TypeScript MCP Server、IMAP/SMTP 适配、MIME 规范化、附件沙箱、发送确认和 9 个 MCP 工具。项目已通过类型检查、构建和本地自动化测试，真实 QQ 邮箱联调仍需要用户提供授权码。

运行时要求 Node.js `>=20.19`。

当前 `package.json` 保留 `private: true`，定位为本机安装和自用，不直接发布到 npm registry。

## 快速开始

```bash
npm install
npm run build
cp qq-email-mcp.example.toml qq-email-mcp.toml
```

把授权码写入本机凭据文件。推荐省略授权码参数，由脚本在终端中无回显地交互读取，避免出现在 shell 历史、进程列表或终端回显中：

```bash
node scripts/set-password.mjs qq-email-mcp your-account@qq.com
```

如果需要非交互执行，可以把授权码作为第三个参数传入，但要注意本机 shell 历史。

也可以只在本机开发时使用环境变量 `QQ_EMAIL_AUTH_CODE`。凭据文件位于用户目录下的 `.qq-email-mcp/credentials.json`，使用主机绑定密钥加密，权限尽量限制为当前用户。它不是操作系统钥匙串；不要把授权码写入 TOML、仓库或日志。

本地凭据文件只保存一份账号凭据；再次执行 `set-password` 会覆盖旧凭据。多账号仍不属于 V1 范围。

启动 stdio 服务：

```bash
node dist/index.js
```

## 接入 MCP 客户端

在客户端中把 `qq-email-mcp` 注册为一个 stdio server，`command` 使用 Node，`args` 指向构建产物，`cwd` 指向项目根目录：

```json
{
  "mcpServers": {
    "qq-email-mcp": {
      "command": "node",
      "args": ["E:/project/web/qq_email_mcp/dist/index.js"],
      "cwd": "E:/project/web/qq_email_mcp",
      "env": {
        "QQ_EMAIL_MCP_CONFIG": "E:/project/web/qq_email_mcp/qq-email-mcp.toml"
      }
    }
  }
}
```

`QQ_EMAIL_MCP_CONFIG` 指向 TOML 配置；授权码不需要放进这里，它会从本地加密凭据文件读取。若客户端不支持 `cwd`，请使用绝对路径，并把 `QQ_EMAIL_MCP_CONFIG` 设为绝对路径。客户端接入后，先调用 `mail_status`，确认 `account` 与 `ready: true` 后再使用其他工具。

完成真实账号联调：

```bash
npm run smoke
```

`npm run smoke` 会读取 TOML、优先使用本地加密凭据，并在没有本地凭据时回退到 `QQ_EMAIL_AUTH_CODE`。随后它会通过真实 stdio 连接启动 MCP，列出工具，并依次执行 `mail_status`、`mail_folders` 和 `mail_list(limit=1)`。整个流程只读，不会发送邮件或修改邮箱内容。

只有 IMAP/SMTP 都连通、标准文件夹存在、收件箱列表可读取时，命令才会返回成功退出码。

配置路径默认是当前目录的 `qq-email-mcp.toml`，可以通过 `QQ_EMAIL_MCP_CONFIG` 覆盖。

## 文档

- [文档索引](docs/README.md)
- [产品需求文档](docs/PRD.md)
- [系统架构](docs/architecture.md)
- [项目结构](docs/project-structure.md)
- [MCP 工具契约](docs/mcp-tools.md)
- [架构决策记录](docs/adr/0001-single-account-imap-smtp.md)
- [实现说明](docs/implementation.md)

## V1 定位

- 单账号 QQ 邮箱
- 本地 stdio MCP
- 官方 IMAP/SMTP
- 默认只读
- 发信、回复、转发和删除前确认
- 对 AI 输出规范化邮件上下文，而不是原始 MIME

## 技术栈

- TypeScript
- `@modelcontextprotocol/sdk`
- `imapflow`
- `mailparser`
- `nodemailer`
- `zod`
- 本地加密凭据文件
- `sanitize-html`
- `mammoth`、`xlsx`、`jszip`、`pdf-parse`

当前依赖版本以 `package-lock.json` 为准。

## 安全原则

邮件正文、发件人名称、链接和附件说明都属于不可信内容，不能直接触发工具调用。授权码只存放在本地加密凭据文件中，不进入仓库、配置样例或日志。

发送支持一次性确认令牌；客户端声明 elicitation 能力时，服务端会直接请求客户端确认。

## 功能范围

- 邮件搜索、列表、分页和正文分段读取
- 近期邮件：支持 `recent_days`（`mail_list` / `mail_search`）与 `mail_digest` 概览
- 标题-only：支持 `include_snippet=false` 的轻量摘要（不抓取正文片段）
- 回复线程聚合、引用历史与签名拆分
- 附件下载、PDF、DOCX、XLSX、PPTX 文本提取
- 新邮件、回复、全部回复和转发
- 转发原附件
- 已读、未读、星标、移动、归档和垃圾箱
- 移动优先使用 `UID MOVE`，不支持 `MOVE` 时使用安全回退
- IMAP 断线重连：只读操作安全重试，写操作不自动重试

## 常用自然语言到工具调用

- “看看近期邮件” → `mail_digest({ folder: "INBOX", recent_days: 30, limit: 20 })`
- “看看近期邮件标题” → `mail_list({ folder: "INBOX", recent_days: 30, limit: 20, include_snippet: false })`
- “看看最近未读” → `mail_list({ folder: "INBOX", recent_days: 30, unread_only: true, limit: 20 })`
- “搜一下近期来自某人的邮件” → `mail_search({ folder: "INBOX", from: "someone@example.com", recent_days: 30, limit: 20 })`

## 目录约定

```text
docs/       产品、架构、协议和决策文档
src/        生产代码
tests/      单元、集成和端到端测试
scripts/    开发、检查和发布脚本
config/     非敏感配置样例
logs/       本地运行日志目录
```

详细职责和依赖规则见 [项目结构](docs/project-structure.md)。

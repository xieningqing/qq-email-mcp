# QQ Email MCP

一个面向 AI 客户端的单账号 QQ 邮箱 MCP。它通过 IMAP/SMTP 提供可靠的邮件搜索、阅读、附件处理、发送、回复和基础管理能力，并把邮件整理成适合模型理解的结构化上下文。

## 当前状态

已经实现 TypeScript MCP Server、IMAP/SMTP 适配、MIME 规范化、附件沙箱、发送确认和 10 个 MCP 工具。项目已通过类型检查、构建和本地自动化测试，并已通过真实 QQ 邮箱只读联调。

运行时要求 Node.js `>=20.19`。

包已发布到 npm：`qq-email-mcp`。终端环境需能访问 `registry.npmjs.org`。

## 快速开始

在任意目录执行一次初始化：

```bash
npx -y qq-email-mcp init
```

`init` 会依次完成：

- 写入配置模板到 `~/.qq-email-mcp/config.toml`
- 交互式询问邮箱地址和授权码，授权码输入不回显
- 将授权码加密写入 `~/.qq-email-mcp/credentials.json`（Windows 使用 DPAPI）
- 输出可直接粘贴到客户端的 MCP 配置

也可以用命名参数跳过交互：

```bash
npx -y qq-email-mcp init --account you@qq.com
```

可用参数：

| 参数 | 说明 |
|---|---|
| `--account <email>` | QQ 邮箱地址，省略则交互询问 |
| `--secret <code>` | 授权码；省略则交互询问（推荐省略，避免进入 shell 历史） |
| `--config <path>` | 自定义配置文件路径 |
| `--credentials <path>` | 自定义凭据文件路径 |

出于安全考虑，`init` 在非交互环境下拒绝写入默认凭据文件，必须显式传入 `--credentials`。

### 授权码说明

授权码在 QQ 邮箱设置中开启 IMAP/SMTP 后生成，**不是 QQ 密码**。

凭据存储方式：

- 位置：`~/.qq-email-mcp/credentials.json`
- Windows：使用 DPAPI 加密，密文绑定当前 Windows 用户账户，换用户或换机器无法解密
- 非 Windows：回退到主机派生密钥的 AES-256-GCM（属于混淆，不是强保护）
- 覆盖已有凭据前会自动备份为 `credentials.json.bak`

本地凭据文件只保存一份账号凭据；多账号不属于 V1 范围。授权码不要写入 TOML、仓库或日志。

### 从源码运行（开发用）

```bash
npm install
npm run build
npm run init
```

开发时也可以用环境变量作为兜底：

```bash
$env:QQ_EMAIL_AUTH_CODE = "你的授权码"
```

优先级低于本地凭据文件。

启动 stdio 服务：

```bash
node dist/index.js
```

## 让 AI 帮你配置

把下面这段整段发给支持执行命令和编辑文件的 AI 客户端（例如 Codex），它会替你完成初始化和客户端配置。

```text
帮我配置 QQ Email MCP，按 README 的说明完成以下步骤：

1. 检查本机是否已安装 Node.js，版本需要 >= 20.19；不满足就告诉我，不要自动升级。
2. 运行 `npx -y qq-email-mcp init` 完成初始化。
   - 这个命令会交互式询问邮箱地址和授权码，授权码输入不回显。
   - 我没有提供授权码时，停下来问我，不要用任何占位值或测试值代替。
   - 不要重复运行 init，也不要手动改写凭据文件。
3. 初始化完成后，读取打印出来的客户端配置，写入当前 MCP 客户端的配置文件。
4. 访问 `mail_status` 验证：确认 `connected` 和 `ready` 都是 true，并确认 `account` 是我的邮箱。
5. 把配置路径、验证结果和 `mail_status` 的 `permissions` 一并告诉我。

约束：
- 只做只读验证，不要发送邮件，不要修改、移动或删除任何邮件。
- 不要读取或打印凭据文件内容，也不要读取 `~/.npmrc` 等包含密钥的文件。
- 任何步骤失败就停下来告诉我原始报错，不要自行改用其他方案。
```

如果你的 AI 客户端不能执行命令，就按下面的步骤手动配置。

## 接入 MCP 客户端

配置查找按以下顺序进行，命中即用：

1. 环境变量 `QQ_EMAIL_MCP_CONFIG` 指定的路径
2. 当前工作目录的 `qq-email-mcp.toml`
3. 包安装目录的 `qq-email-mcp.toml`
4. 用户目录的 `~/.qq-email-mcp/config.toml`

只要用 `init` 写好 `~/.qq-email-mcp/config.toml`，客户端配置就可以精简成：

```json
{
  "mcpServers": {
    "qq-email-mcp": {
      "command": "npx",
      "args": ["-y", "qq-email-mcp"]
    }
  }
}
```

Codex 使用 TOML 配置，等价写法：

```toml
[mcp_servers.qq-email-mcp]
type = "stdio"
command = 'npx.cmd'
args = ['-y', 'qq-email-mcp']
```

如果需要完全显式（例如多份配置并存），可以指定入口和配置文件：

```json
{
  "mcpServers": {
    "qq-email-mcp": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "QQ_EMAIL_MCP_CONFIG": "/path/to/qq-email-mcp.toml"
      }
    }
  }
}
```

授权码不需要放进客户端配置，它会从本地加密凭据文件读取。

客户端接入后，先调用 `mail_status`，确认 `account` 与 `ready: true` 后再使用其他工具。

### 配置文件

`~/.qq-email-mcp/config.toml` 由 `init` 生成，可手动调整：

```toml
[account]
email = "your-account@qq.com"

[permissions]
read = true
draft = false
update = false
send = false

[imap]
host = "imap.qq.com"
port = 993
secure = true

[smtp]
host = "smtp.qq.com"
port = 465
secure = true

[security]
credential_target = "qq-email-mcp"
attachment_dir = "./downloads"
max_attachment_bytes = 26214400
max_total_attachment_bytes = 52428800
allow_remote_images = false

[send]
save_sent = "never"
```

### 权限

权限分为四档，默认只读：

| 权限 | 默认 | 作用 |
|---|---|---|
| `read` | `true` | 读取、搜索、读取附件 |
| `draft` | `false` | 创建/替换草稿（低风险写入，不发送） |
| `update` | `false` | 标记已读、星标、移动、归档、垃圾箱 |
| `send` | `false` | 发送、回复、转发 |

开启 `draft`、`update`、`send` 前必须先开启 `read`。草稿不发送邮件、不需要确认令牌；真正发信必须走 `mail_send` 的一次性确认。

### 只读联调

```bash
npm run smoke
```

`npm run smoke` 优先使用本地加密凭据，并在没有本地凭据时回退到 `QQ_EMAIL_AUTH_CODE`。随后它通过真实 stdio 连接启动 MCP，列出工具，并依次执行 `mail_status`、`mail_folders` 和 `mail_list(limit=1)`。整个流程只读，不会发送邮件或修改邮箱内容。

只有 IMAP/SMTP 都连通、标准文件夹存在、收件箱列表可读取时，命令才会返回成功退出码。

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
- 发信、回复、转发前一次性确认；不提供永久删除
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
- 草稿：创建或替换 Drafts 中的草稿（低风险写入，不触发发送）
- 转发原附件
- 已读、未读、星标、移动、归档和垃圾箱
- 移动优先使用 `UID MOVE`，不支持 `MOVE` 时使用安全回退
- IMAP 断线重连：只读操作安全重试，写操作不自动重试

## 常用自然语言到工具调用

- “看看近期邮件” → `mail_digest({ folder: "INBOX", recent_days: 30, limit: 20 })`
- “看看近期邮件标题” → `mail_list({ folder: "INBOX", recent_days: 30, limit: 20, include_snippet: false })`
- “看看最近未读” → `mail_list({ folder: "INBOX", recent_days: 30, unread_only: true, limit: 20 })`
- “搜一下近期来自某人的邮件” → `mail_search({ folder: "INBOX", from: "someone@example.com", recent_days: 30, limit: 20 })`
- “帮我起草一封回复草稿” → `mail_draft({ mode: "reply", message_ref: "...", text: "..." })`

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

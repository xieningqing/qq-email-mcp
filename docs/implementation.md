# 实现说明

## 1. 当前实现范围

V1 已具备以下能力：

- 单账号 QQ 邮箱登录和连接诊断
- IMAP 文件夹发现
- 邮件列表和游标分页
- 服务端搜索
- IMAP `ESEARCH` 不可用时自动回退到标准 `SEARCH`
- MIME 正文、中文头部和附件解析
- 面向 AI 的规范化上下文，拆分引用历史与签名
- 附件沙箱下载和文本、PDF、DOCX、XLSX、PPTX 提取
- 新邮件、回复、全部回复和转发
- 发送预览、一次性确认令牌、客户端 elicitation 确认和 SMTP 发送
- 已读、未读、星标、移动、归档和移入垃圾箱
- 移动优先使用 `UID MOVE`；服务端不支持 `MOVE` 扩展时，由 IMAP 客户端使用 COPY + `\Deleted` 回退
- 脱敏审计记录

## 2. 运行方式

运行时要求 Node.js `>=20.19`：

配置和授权码分离：

- TOML 保存非敏感配置。
- 授权码优先从用户目录的 `.qq-email-mcp/credentials.json` 读取，并使用主机绑定密钥加密。该方案是本地凭据文件，不是操作系统钥匙串。
- 开发环境可以使用 `QQ_EMAIL_AUTH_CODE`。

写入授权码。推荐省略第三个参数，由脚本无回显地交互读取，避免授权码进入 shell 历史、进程列表或终端回显：

```bash
node scripts/set-password.mjs qq-email-mcp your-account@qq.com
```

本地凭据文件只保存一份账号凭据，再次写入会覆盖旧值；V1 不支持多账号凭据集合。

`npm run smoke` 使用同一套凭据入口：优先读取本地加密凭据，再回退到 `QQ_EMAIL_AUTH_CODE`。缺少凭据时命令以退出码 2 结束。

MCP 使用 stdio，不监听网络端口。

## 3. 关键模块

| 模块 | 位置 | 职责 |
|---|---|---|
| MCP Server | `src/mcp/server.ts` | 工具注册、参数 Schema、结果编码 |
| Mail Service | `src/mail/mail-service.ts` | 权限、确认、分页和业务编排 |
| IMAP Adapter | `src/adapters/imap-adapter.ts` | 文件夹、搜索、FETCH、STORE、移动 |
| SMTP Adapter | `src/adapters/smtp-adapter.ts` | MIME 组装、预览、发送和 Sent 保存 |
| MIME Normalizer | `src/mime/normalize.ts` | 解码、正文清洗、附件和链接提取 |
| Security | `src/security/` | 凭据、确认、沙箱、审计 |

## 4. 安全行为

- 默认只读，修改和发送需要配置显式开启。
- 发送分两步，第一次返回预览和一次性确认令牌。
- 支持 elicitation 的客户端可以在预览后直接完成用户确认。
- 确认令牌只能消费一次。
- SMTP 超时后不自动重放发送，用户需要先核对发送结果再决定是否重发。
- 附件文件名不能逃逸沙箱目录。
- HTML 默认移除脚本并阻止远程图片。
- 邮件内容标记为 `isUntrusted`，不得作为系统指令执行。
- 日志不保存正文、附件内容和授权码。

## 5. 验证命令

```bash
npm run typecheck
npm test
npm run build
```

当前自动化测试覆盖：

- 邮件引用和游标编解码
- 确认令牌一次性消费和过期
- 附件路径逃逸防护
- 中文 MIME、HTML 清洗和远程图片处理
- 服务层分页、只读权限、AI 上下文、发送确认和 UIDVALIDITY 变化
- 回复线程聚合、引用历史拆分和转发原附件
- MCP stdio 握手、工具发现和 elicitation 发送确认
- Office、演示文稿和表格附件文本提取

## 6. 真实邮箱联调

自动化测试不连接真实 QQ 邮箱。上线前需要使用独立测试账号验证：

1. IMAP 和 SMTP 使用授权码登录。
2. 中文文件夹和中文邮件主题。
3. 带附件和嵌套 MIME 的邮件。
4. 回复线程头。
5. Sent 文件夹保存策略。
6. 移动、归档和垃圾箱。
7. 断线后的只读重连和写操作拒绝自动重试。

自动化只读检查可以使用：

```powershell
$env:QQ_EMAIL_MCP_E2E = "1"
$env:QQ_EMAIL_MCP_CONFIG = "E:\project\web\qq_email_mcp\qq-email-mcp.toml"
npm test -- tests/e2e/real-account.test.ts
```

该测试默认跳过，不会进入普通 CI；它只读取状态、文件夹、列表和第一封邮件的 AI 上下文，不发送或修改邮件。

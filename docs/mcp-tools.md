# MCP 工具契约

## 1. 通用约定

- 传输：stdio
- 账号：单账号，不需要 `account_id`
- 时间：ISO 8601 字符串
- 邮件定位：优先使用不透明 `message_ref`
- 列表分页：使用 `mail_list` 或 `mail_search` 返回的 `next_cursor`
- 正文分段：使用 `mail_get` 返回的 `next_cursor`
- 错误：`{ code, message, retryable, details? }`
- 写操作：必须经过权限检查，高影响操作还需要确认令牌

## 2. 工具清单

| 工具 | 类型 | 说明 |
|---|---|---|
| `mail_status` | 只读 | 检查连接、认证、文件夹和权限 |
| `mail_folders` | 只读 | 返回文件夹和标准文件夹映射 |
| `mail_list` | 只读 | 浏览邮件列表 |
| `mail_search` | 只读 | 搜索邮件 |
| `mail_digest` | 只读 | 近期邮件概览（数量与摘要，不返回正文） |
| `mail_get` | 只读 | 读取元数据、正文、线程或 AI 上下文 |
| `mail_attachment` | 只读 | 读取或下载附件 |
| `mail_send` | 写入 | 新邮件、回复、全部回复、转发 |
| `mail_update` | 写入 | 已读、未读、星标、移动、归档、垃圾箱 |

## 3. mail_status

输入：

```json
{}
```

输出：

```json
{
  "account": "me@qq.com",
  "connected": true,
  "ready": true,
  "imap": "ok",
  "smtp": "ok",
  "folders": "ok",
  "permissions": {
    "read": true,
    "update": false,
    "send": false
  },
  "folder_roles": [
    {
      "name": "INBOX",
      "role": "inbox"
    }
  ],
  "capabilities": [
    "IMAP4rev1",
    "MOVE",
    "UIDPLUS"
  ],
  "warnings": []
}
```

`folder_roles` 用于确认真实文件夹和标准角色映射，`capabilities` 来自已建立的 IMAP 会话，可用于判断 QQ 服务端是否支持 `MOVE`、`UIDPLUS` 等扩展。

`account` 是当前配置的单账号邮箱地址。`connected` 表示 IMAP 可读，`ready` 表示 IMAP 和 SMTP 都可用。`mail_status` 声明了 MCP `outputSchema`，成功结果会校验 `account`、`connected`、`ready`、`imap`、`smtp`、`folders`、`folder_roles`、`capabilities`、`permissions` 和 `warnings`。

## 4. mail_folders

输入：

```json
{}
```

输出：

```json
{
  "folders": [
    {
      "name": "INBOX",
      "display_name": "收件箱",
      "role": "inbox",
      "selectable": true
    }
  ]
}
```

`mail_folders` 声明了 MCP `outputSchema`，每个文件夹包含 `name`、`display_name`、`role`、`selectable` 和 `special_use`。

## 5. mail_list

输入：

```json
{
  "folder": "INBOX",
  "limit": 20,
  "unread_only": true,
  "since": "2026-01-01",
  "before": "2026-10-01",
  "recent_days": 30,
  "cursor": null
}
```

`since`/`before` 与 `mail_search` 相同，使用服务端 IMAP 日期筛选；`since` 为包含边界，`before` 为排除边界。传错日期格式或时间范围颠倒会返回 `INVALID_INPUT`。

`recent_days` 用于读取“近 N 天”的邮件（由服务端按当前时间换算为 `since`）。`recent_days` 不能与 `since`/`before` 同时使用；`limit` 仅控制每页大小，翻页使用 `next_cursor`。

`include_snippet=false` 用于“只看标题/不展开正文片段”的轻量列表；返回的 `messages[].snippet` 会为 `null`，并且服务端会尽量避免抓取正文片段。

输出：

```json
{
  "messages": [
    {
      "message_ref": "opaque-ref",
      "subject": "Subject",
      "from": {
        "name": "Sender",
        "address": "sender@example.com"
      },
      "to": [
        {
          "name": null,
          "address": "me@qq.com"
        }
      ],
      "date": "2026-09-21T10:00:00+08:00",
      "unread": true,
      "flagged": false,
      "has_attachments": true,
      "attachment_count": 1,
      "snippet": "Short plain-text preview"
    }
  ],
  "next_cursor": "opaque-cursor"
}
```

`mail_list` 和 `mail_search` 声明了 MCP `outputSchema`。成功结果会按该结构校验；错误结果使用 `isError`，不受输出结构校验影响。

## 6. mail_search

输入：

```json
{
  "query": "invoice",
  "folder": "INBOX",
  "from": "billing@example.com",
  "since": "2026-01-01",
  "before": "2026-10-01",
  "unread_only": false,
  "limit": 20,
  "recent_days": 30,
  "cursor": null
}
```

输出与 `mail_list` 一致，并增加：

```json
{
  "search": {
    "executed_server_side": true,
    "query": "invoice"
  }
}
```

搜索使用 IMAP `UID SEARCH` 在服务端执行。服务端支持 `ESEARCH` 时优先使用其返回结构；不支持时由 IMAP 客户端回退到标准 `SEARCH` 响应。两种情况下 MCP 结果都保持相同字段，`executed_server_side` 均为 `true`。如果服务端拒绝具体搜索条件，工具返回稳定错误，不做本地全量抓取和模糊匹配。

`recent_days` 与 `mail_list` 相同，用于限定“近 N 天”（服务端换算为 `since`）。`recent_days` 不能与 `since`/`before` 同时使用。

## 6.1 mail_digest

输入：

```json
{
  "folder": "INBOX",
  "recent_days": 30,
  "unread_only": false,
  "limit": 20
}
```

输出：

```json
{
  "folder": "INBOX",
  "since": "2026-08-23T00:00:00.000Z",
  "total": 57,
  "unread": 12,
  "with_attachments": 3,
  "messages": []
}
```

`mail_digest` 只返回轻量摘要与统计，不返回正文；`limit` 只限制返回的 `messages` 数量，`total/unread/with_attachments` 仍基于全部匹配结果计算。

`mail_digest` 同样支持 `include_snippet=false` 以返回主题-only 摘要列表。

## 7. mail_get

输入：

```json
{
  "message_ref": "opaque-ref",
  "mode": "agent",
  "max_chars": 20000,
  "include_links": true,
  "include_attachments": true,
  "cursor": null
}
```

`mode` 可选值：

- `metadata`
- `text`
- `thread`
- `agent`

`thread` 模式使用 `Message-ID`、`In-Reply-To` 和 `References`，在当前文件夹内聚合回复链，不使用仅凭主题的模糊匹配；它不会跨文件夹合并收件箱和已发送副本。`thread_ref` 在所有模式下都指向线程根 Message-ID：优先取 `References` 的第一项，其次取 `In-Reply-To`，最后才回退到当前邮件自身。`agent` 模式会把明显引用历史拆分到 `quoted_history`，无法可靠识别时保留完整正文。

`metadata` 模式会在附件清单之外返回 `unread`、`flagged`、`message_id`、`in_reply_to` 和 `references`，便于在不下载正文的情况下做线程判断和状态决策。

`include_links` 和 `include_attachments` 只影响 `agent` 模式；`metadata` 始终返回附件清单，`text` 模式不返回链接或附件。

当正文超过 `max_chars` 时，`text` 和 `agent` 模式会返回 `next_cursor`。把该值原样传回 `mail_get.cursor` 即可继续读取下一段正文；游标已保存原分页预算，不需要再次传 `max_chars`。如果显式传入不同的 `max_chars`，调用会被拒绝。正文游标与邮件及原 `mode` 绑定，不能用于其他邮件，也不能在 `text` 与 `agent` 模式之间混用。

`thread` 模式把 `max_chars` 作为整个线程的总预算，按线程顺序在消息之间共享；单条消息被截断或总预算耗尽时，都会通过 `truncated` 报告。线程模式不提供正文游标，需要更长上下文时应缩小线程范围或改用 `agent` 模式逐封读取。

`quoted_history` 和 `html_clean` 各自独立受 `max_chars` 上限约束，并通过对应的 `*_truncated` 标志报告是否被截断；它们不占用正文分段游标的偏移。

`agent` 模式会识别标准签名分隔符 `-- ` 以及常见中英文签名头，把签名放入 `signature`，正文 `text` 不再包含签名。`signature` 与 `signature_truncated` 的预算规则与 `quoted_history` 相同；`text` 模式仍返回包含签名和引用历史的完整纯文本，不会丢数据。

AI 上下文模式输出：

```json
{
  "message_ref": "opaque-ref",
  "thread_ref": "thread-ref",
  "subject": "Subject",
  "from": [],
  "to": [],
  "cc": [],
  "date": "2026-09-21T10:00:00+08:00",
  "text": "Normalized body",
  "signature": null,
  "signature_truncated": false,
  "quoted_history": null,
  "quoted_history_truncated": false,
  "html_clean": null,
  "html_clean_truncated": false,
  "attachments": [],
  "links": [],
  "warnings": [],
  "truncated": false,
  "next_cursor": null,
  "is_untrusted": true
}
```

## 8. mail_attachment

输入：

```json
{
  "message_ref": "opaque-ref",
  "attachment_id": "attachment-id",
  "action": "extract_text",
  "max_chars": 50000
}
```

`action` 可选值：

- `metadata`
- `download`
- `extract_text`

`extract_text` 支持 TXT、CSV、JSON、XML、HTML、PDF、DOCX、XLSX/XLS、ODS 和 PPTX。压缩包和可执行文件不会自动解压或执行。PPTX 提取会按页输出幻灯片文本，并附带可读取的演讲者备注。

输出：

```json
{
  "attachment_id": "attachment-id",
  "filename": "report.pdf",
  "content_type": "application/pdf",
  "size": 102400,
  "download_path": null,
  "extracted_text": "text content",
  "character_count": 12,
  "truncated": false,
  "extractor": "pdf"
}
```

`mail_attachment` 声明了 MCP `outputSchema`。成功结果会返回 `attachment_id`、`filename`、`content_type`、`size`、`disposition`、`content_id`、`download_path`、`extracted_text`、`character_count`、`truncated` 和 `extractor`；错误结果使用 `isError`。`character_count` 是截断前的完整提取字符数；未执行文本提取时为 `null`。`download` 成功时 `download_path` 是本机沙箱内的绝对路径，只表示文件已落盘，不代表该路径可被远程访问；`metadata` 和 `extract_text` 不写文件。

## 9. mail_send

### 9.1 新邮件

```json
{
  "mode": "new",
  "to": ["recipient@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Subject",
  "text": "Body",
  "attachments": [],
  "preview_only": true
}
```

`text` 和 `html` 至少提供一个。只提供 `html` 时，预览中的 `text` 为空字符串，SMTP 仍按 HTML 邮件组装。显式附件最多 100 个，转发时原附件也计入该上限。

预览输出：

```json
{
  "status": "confirmation_required",
  "confirmation_token": "one-time-token",
  "preview": {
    "mode": "new",
    "to": ["recipient@example.com"],
    "subject": "Subject",
    "text": "Body",
    "html": null,
    "warnings": [],
    "attachment_total_bytes": 0,
    "max_attachment_bytes": 26214400,
    "max_total_attachment_bytes": 52428800,
    "attachments": []
  }
}
```

发送预览中的 `html` 是用户提供的原始 HTML，不会在预览阶段自动改写；如果包含脚本、表单、事件处理器或远程资源，`warnings` 会列出风险。读取邮件时的 `html_clean` 才会执行清洗和远程资源限制。发送前应把这些警告视为需要用户明确确认的内容。

确认发送：

```json
{
  "confirmation_token": "one-time-token"
}
```

### 9.2 回复、全部回复和转发

```json
{
  "mode": "reply",
  "message_ref": "opaque-ref",
  "text": "Reply body",
  "include_original": true,
  "preview_only": true
}
```

`mode` 可选值：

- `new`
- `reply`
- `reply_all`
- `forward`

当 MCP 客户端声明 elicitation 能力时，服务端在返回发送预览后直接请求客户端确认。客户端不支持 elicitation 时，继续使用 `confirmation_token` 两步确认。

客户端拒绝确认或 elicitation 调用失败时，预览生成的令牌会立即失效；取消后的令牌不能再次用于发送。

转发默认携带原邮件附件；设置 `include_original_attachments: false` 可以只发送新正文和显式附件。

`mail_send` 声明了 MCP `outputSchema`。`status` 可能为 `preview`、`confirmation_required`、`cancelled`、`sent`、`partial_failure` 或 `failed`；发送结果使用 `message_id`、`accepted`、`rejected`、`response` 和 `sent_save_error`，预览结果使用 `preview`。

`sent` 表示 SMTP 已接受邮件且至少有一个收件人成功。`sent_save_error` 只表示保存到 Sent 文件夹失败，不代表邮件未发出，不能据此自动重发。`partial_failure` 表示部分收件人成功、部分被拒绝。

发送确认令牌与规范化内容绑定，且只能消费一次。SMTP 超时或连接中断时，服务端不会自动重放发送；`SMTP_SEND_FAILED` 或 `TIMEOUT` 返回后，必须先检查已发送文件夹和收件人状态，再决定是否重新生成预览和确认令牌。该机制不承诺跨进程、跨设备幂等，V1 的定位是单进程本机 MCP。

## 10. mail_update

输入：

```json
{
  "message_refs": ["opaque-ref"],
  "action": "mark_read"
}
```

`action` 可选值：

- `mark_read`
- `mark_unread`
- `flag`
- `unflag`
- `move`
- `archive`
- `trash`

`move` 需要显式 `target_folder`：

```json
{
  "target_folder": "Archive"
}
```

`archive` 和 `trash` 不接受改道：即使请求中带了 `target_folder`，也会分别使用 IMAP 发现的标准 Archive/Trash 角色映射，避免归档或删除语义被重定向到任意文件夹。

输出：

```json
{
  "updated": 1,
  "failed": [
    {
      "message_ref": "opaque-ref",
      "code": "STALE_MESSAGE_REF",
      "message": "Mailbox UIDVALIDITY changed",
      "retryable": true
    }
  ],
  "action": "mark_read"
}
```

`mail_update` 声明了 MCP `outputSchema`。成功结果包含 `updated`、`failed` 和 `action`；失败项包含 `message_ref`、`code`、`message`、`retryable`。错误结果使用 `isError`。

## 11. 错误码

| 错误码 | 含义 | 是否可重试 |
|---|---|---|
| `CONFIG_MISSING` | 配置缺失 | 否 |
| `INVALID_CONFIG` | 配置无效或运行目录不可写 | 否 |
| `AUTH_FAILED` | 认证失败 | 否 |
| `NETWORK_ERROR` | 网络错误，`details.kind` 区分 `dns`、`tls`、`connection` 或 `network` | 是 |
| `TIMEOUT` | 操作超时；只读操作可重试，SMTP 发送超时因状态未知不可自动重试 | 视动作而定 |
| `PERMISSION_DENIED` | 权限未开启 | 否 |
| `CONFIRMATION_REQUIRED` | 缺少确认 | 否 |
| `CONFIRMATION_INVALID` | 确认令牌缺失、过期、已使用或不匹配 | 否，需要重新预览 |
| `INVALID_INPUT` | 工具参数或业务输入无效 | 否 |
| `MAIL_NOT_FOUND` | 邮件不存在或源内容不可用 | 否，建议重新搜索 |
| `STALE_MESSAGE_REF` | UIDVALIDITY 已变化 | 是，需要重新搜索 |
| `FOLDER_NOT_FOUND` | 目标文件夹不存在或无法解析标准角色 | 否 |
| `INVALID_ATTACHMENT_PATH` | 附件路径不安全 | 否 |
| `ATTACHMENT_TOO_LARGE` | 附件超限 | 否 |
| `ATTACHMENT_NOT_FOUND` | 附件不存在 | 否 |
| `UNSUPPORTED_ATTACHMENT` | 附件格式不支持文本提取 | 否 |
| `EXTRACTION_TIMEOUT` | 附件文本提取超时 | 是 |
| `SMTP_SEND_FAILED` | 发送失败 | 需要用户判断 |
| `IMAP_OPERATION_FAILED` | IMAP 操作失败 | 视动作而定，写操作不得自动重放 |
| `PARTIAL_UPDATE_FAILED` | 批量更新全部条目失败（仅出现在审计事件中，工具本身返回逐条 `failed`） | 否 |
| `INTERNAL_ERROR` | 未分类内部错误 | 否 |

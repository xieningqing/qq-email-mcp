# 文档索引

`docs/` 是项目规范的事实来源。产品范围、工具协议、安全边界和架构决策发生变化时，先更新对应文档，再修改实现。

## 核心文档

| 文档 | 内容 | 主要读者 |
|---|---|---|
| [PRD](PRD.md) | 产品目标、范围、需求、验收标准 | 产品、开发、测试 |
| [architecture.md](architecture.md) | 系统边界、模块关系、关键流程 | 开发、维护者 |
| [project-structure.md](project-structure.md) | 目录职责、依赖方向和放置规则 | 所有贡献者 |
| [mcp-tools.md](mcp-tools.md) | MCP 工具、输入输出和错误契约 | MCP 客户端、开发、测试 |

## 决策记录

架构决策记录放在 `docs/adr/`，文件名格式为：

```text
NNNN-short-title.md
```

目前已有：

- [0001 - 单账号 IMAP/SMTP 架构](adr/0001-single-account-imap-smtp.md)

## 文档维护规则

- PRD 只描述用户价值和产品行为，不写具体类名和实现细节。
- 架构文档描述模块职责、边界和依赖，不复制工具字段清单。
- 工具契约放在 `mcp-tools.md`，作为实现和测试的共同接口。
- 重要且难以逆转的技术选择写入 ADR。
- 不在根目录散落产品文档、接口文档或临时设计稿。

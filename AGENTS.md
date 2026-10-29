# az-meme-frontend 文档索引

本文件只做文档入口，不重复规则正文。开始任务先读 [handoff](handoff.md)，再按下面索引打开对应文档。

## 流程与规范文档

| 文档 | 用途 |
|---|---|
| [handoff.md](handoff.md) | 当前状态、未完成事项、运行与检查命令 |
| [README.md](README.md) | 项目介绍与启动方式 |
| [GOALS.md](GOALS.md) | 仓库职责与边界 |
| [ENVIRONMENT.md](ENVIRONMENT.md) | 运行时、包管理器、端口、环境文件 |
| [SETUP.md](SETUP.md) | 从最新 `main` 检出本仓并执行本地检查 |
| [LOCAL-TESTS.md](LOCAL-TESTS.md) | 允许的本地检查；Coder 不运行 E2E |
| [BUILD.md](BUILD.md) | Build Agent 构建规则与证据要求 |
| [PERFORMANCE.md](PERFORMANCE.md) | 本仓性能要求 |
| [SECURITY.md](SECURITY.md) | 密钥管理、数据隔离、敏感信息 |
| [REVIEW.md](REVIEW.md) | Review 轮数、准确 SHA、结论格式 |
| [E2E.md](E2E.md) | E2E 调度、浏览器复用、证据 |
| [CI-CD.md](CI-CD.md) | 当前 GitHub Actions 实际范围 |
| [AGENT-COORDINATION.md](AGENT-COORDINATION.md) | Main、Coder、Reviewer、Build、E2E 分工 |
| [AGENT-APPROVALS.md](AGENT-APPROVALS.md) | 审批签名与 SHA 绑定 |
| [BRANCH-PROTECTION.md](BRANCH-PROTECTION.md) | main 保护与合并门禁 |
| [GITHUB-WEBHOOK.md](GITHUB-WEBHOOK.md) | Webhook 决策（当前不启用） |

## 技术与产品文档

文档总索引：[docs/README.md](docs/README.md)

技术文档（`docs/tech/`）：

- [delivery-limitations.md](docs/tech/delivery-limitations.md)：交付限制与未完成的集成项
- [agent-workflow.md](docs/tech/agent-workflow.md)：Agent 工作流说明

产品文档：`docs/product/` 目前没有文件；新增产品说明时按 `docs/product/<主题>.md` 放置。

本文档索引由 `AGENTS.md` 统一入口维护；新增文档时同步更新本文件。

## 硬性规则（摘要）

- Coder 每次开发先 fetch，从本仓最新 `main` 创建开发分支和 worktree；不在旧分支上继续改。
- Reviewer checkout 待审的准确 commit SHA，不审查会移动的 `main`。
- 所有 Agent worktree 用完即删：成果已 commit、推送、证据已保存后才删；不删他人或仍活动的 worktree。
- Coder 不运行 E2E；真实服务、浏览器、钱包、RPC 由 Main 调度。
- 提交前缀用 `feature:`、`fix:`、`refactor:`、`chore:`；禁止直接 push `main`。
- 敏感信息只放 ignored env，不打印、不提交。
- 文档只保留与当前实现一致的内容，不写历史状态。

## CI 当前范围

本仓当前没有云端 CI/CD，也没有 GitHub Actions workflow。PR 的检查和构建由 Main 在本机按需执行并记录。

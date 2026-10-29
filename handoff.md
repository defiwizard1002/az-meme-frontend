# 当前上下文

本仓负责行情、K线、钱包登录与交易确认页面。本次 PR 交付独立构建与 workflow 配置；本次只整理文档，保留既有 Dockerfile/workflow，不修改业务代码。

运行入口见 [README](README.md)，命令见 [BUILD](BUILD.md) 和 [本地检查](LOCAL-TESTS.md)。Node.js 24，包管理器为 `corepack pnpm`；实际已运行工具为 Git、Python、gh，未验证当前 Node/Docker 环境。未配置新密钥，不记录真实环境值。

现有 `.github/workflows/ci.yml` 在 PR 事件执行检查；`build-agent.yml` 在 main push 后于 GitHub-hosted `ubuntu-latest` 按 `github.sha` 构建。它是云端 workflow，不是本地 Build Agent 自动调度。尚未实现本地 Build Agent 自动触发、签名审批验证或自动 E2E 交接；不能声称这些已形成门禁。

本次未运行测试、Docker build、E2E、部署或合并。已知限制见 [构建限制](docs/tech/delivery-limitations.md)。文档依据已 fetch 的父仓 main `28c0d5728d3a9e7737205fb206a7657a465e56c3`；本仓任务分支从本仓已核对的最新 main 继续，未更改业务源码。

交付使用 `chore/independent-repo-workflow` 的 draft PR，实际 commit、远端 SHA 和 checks 以 PR 读回记录为准。后续处理构建限制与审批/调度缺口需单独明确范围。本次 worktree 交给 Main 确认成果保存后清理。文档索引见 [docs](docs/README.md)。

# CI/CD

现有 `.github/workflows/ci.yml` 在 PR 事件执行检查；`build-agent.yml` 在 main push 后于 GitHub-hosted `ubuntu-latest` 按 `github.sha` 构建。它是云端 workflow，不是本地 Build Agent 自动调度。尚未实现本地 Build Agent 自动触发、签名审批验证或自动 E2E 交接；不能声称这些已形成门禁。

PR CI 使用 checkout action 的默认 PR checkout；这不等同 Reviewer 已审准确 head SHA。Build workflow 显式 checkout `github.sha`。审批记录必须明确对应 SHA，云端构建成功也不能替代 E2E 或生产验证。

Coder 从 fetch 后最新 main 开发；Reviewer checkout 准确待审 SHA，见 [开发规则](AGENTS.md)。本仓 workflow 不引用父仓或其他 submodule，不使用 self-hosted runner、Webhook、轮询或常驻 bot。

所有 agent worktree 用完即删，但必须先将成果保存到 commit、远端 PR 和证据，确认没有遗漏未提交改动；不得删除他人或仍活动的 worktree。当前 cwd 交由 Main 在确认三仓已 push、证据和父仓 patch 已保存后清理，本次不自行删除。

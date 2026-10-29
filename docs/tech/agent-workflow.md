# 独立工作流

输入为本仓代码、准确 commit SHA、任务范围及所需公开配置；输出为 commit/PR、构建产物及带 SHA 的检查证据。真实服务与私有 env 由 Main 按任务单独提供，不由父仓隐式注入。

Coder 每次开始任务先 fetch 本仓完整分支引用，核对远端最新 main，并从该 main 创建开发分支；不能从过时本地 main 或父仓 gitlink 开发。已有未提交任务先保存，不得覆盖。本次交付继续已有 `chore/independent-repo-workflow` 分支，只用当前父 worktree，不另建分支或 worktree。

Reviewer 必须 fetch 并 checkout 待 review 的准确 commit SHA，核对 `git rev-parse HEAD` 后再审；不能 review 会移动的 main。PR head 更新后旧结论不覆盖新 SHA。

现有 `.github/workflows/ci.yml` 在 PR 事件执行检查；`build-agent.yml` 在 main push 后于 GitHub-hosted `ubuntu-latest` 按 `github.sha` 构建。它是云端 workflow，不是本地 Build Agent 自动调度。尚未实现本地 Build Agent 自动触发、签名审批验证或自动 E2E 交接；不能声称这些已形成门禁。

Build 使用 [构建命令](../../BUILD.md)，Main 手动交接 [E2E](../../E2E.md)。具体约束见 [协作](../../AGENT-COORDINATION.md) 与 [审批](../../AGENT-APPROVALS.md)。

所有 agent worktree 用完即删，但必须先将成果保存到 commit、远端 PR 和证据，确认没有遗漏未提交改动；不得删除他人或仍活动的 worktree。当前 cwd 交由 Main 在确认三仓已 push、证据和父仓 patch 已保存后清理，本次不自行删除。

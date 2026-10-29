# Agent 协作

Coder 每次开始任务先 fetch 本仓完整分支引用，核对远端最新 main，并从该 main 创建开发分支；不能从过时本地 main 或父仓 gitlink 开发。已有未提交任务先保存，不得覆盖。本次交付继续已有 `chore/independent-repo-workflow` 分支，只用当前父 worktree，不另建分支或 worktree。

Reviewer 必须 fetch 并 checkout 待 review 的准确 commit SHA，核对 `git rev-parse HEAD` 后再审；不能 review 会移动的 main。PR head 更新后旧结论不覆盖新 SHA。

Main 传递仓库、准确 SHA、命令、证据位置和下一步。Build 完成后才交 E2E，Coder 不执行 E2E。

本仓当前没有云端 CI/CD，也没有 GitHub Actions workflow。PR 的检查和构建由 Main 在本机按需执行并记录，不产生云端费用。尚未实现本地 Build Agent 自动触发、签名审批验证或自动 E2E 交接；不能声称这些已形成门禁。

所有 agent worktree 用完即删，但必须先将成果保存到 commit、远端 PR 和证据，确认没有遗漏未提交改动；不得删除他人或仍活动的 worktree。当前 cwd 交由 Main 在确认三仓已 push、证据和父仓 patch 已保存后清理，本次不自行删除。

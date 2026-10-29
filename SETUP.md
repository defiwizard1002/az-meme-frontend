# 设置

Coder 每次开始任务先 fetch 本仓完整分支引用，核对远端最新 main，并从该 main 创建开发分支；不能从过时本地 main 或父仓 gitlink 开发。已有未提交任务先保存，不得覆盖。本次交付继续已有 `chore/independent-repo-workflow` 分支，只用当前父 worktree，不另建分支或 worktree。

在本仓根目录按 [环境](ENVIRONMENT.md) 准备，再按 [构建](BUILD.md) 执行。本仓不依赖父仓文件；联调需要可达的外部服务。已有任务未提交时先保存，不能直接切 main 丢弃工作。

所有 agent worktree 用完即删，但必须先将成果保存到 commit、远端 PR 和证据，确认没有遗漏未提交改动；不得删除他人或仍活动的 worktree。当前 cwd 交由 Main 在确认三仓已 push、证据和父仓 patch 已保存后清理，本次不自行删除。

# Review

Reviewer 必须 fetch 并 checkout 待 review 的准确 commit SHA，核对 `git rev-parse HEAD` 后再审；不能 review 会移动的 main。PR head 更新后旧结论不覆盖新 SHA。

Reviewer 最多三轮，第三轮仍未通过等待人工意见。Risk 单独给 PASS、BLOCK 或 NO VERDICT，记录准确 SHA、命令、日志和未覆盖项，没有证据不写 PASS。Main 手动协调，GitHub comment/status 保存记录；签名审批尚未实现。

所有 agent worktree 用完即删，但必须先将成果保存到 commit、远端 PR 和证据，确认没有遗漏未提交改动；不得删除他人或仍活动的 worktree。当前 cwd 交由 Main 在确认三仓已 push、证据和父仓 patch 已保存后清理，本次不自行删除。

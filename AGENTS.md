# az-meme-frontend 开发规则

开始先读 [handoff](handoff.md) 和 [本地检查](LOCAL-TESTS.md)。本仓负责行情、K线、钱包登录与交易确认页面，独立管理源码、依赖、构建和协作文档。父仓提供可选聚合编排，不是本仓构建前提。

- 最小必要改动，保持边界清晰；错误显式暴露，不吞异常。
- 外部数据只在入口校验；不增加无需求的抽象或保护机制。
- 技术文档放 `docs/tech/`，产品文档放 `docs/product/`；只写当前事实，不复制父仓历史。README 只写介绍与运行入口。
- Coder 不运行 E2E；Main 按明确范围调度真实服务、浏览器和钱包。测试少且快，常规不超过 50 个、2 分钟；本次文档交付明确不新增/运行测试。
- 私密配置只放 ignored env，不打印或提交；用户数据隔离。
- 提交使用 feature/fix/refactor/chore 前缀；禁止直接 push main。

## Checkout 与清理

Coder 每次开始任务先 fetch 本仓完整分支引用，核对远端最新 main，并从该 main 创建开发分支；不能从过时本地 main 或父仓 gitlink 开发。已有未提交任务先保存，不得覆盖。本次交付继续已有 `chore/independent-repo-workflow` 分支，只用当前父 worktree，不另建分支或 worktree。

Reviewer 必须 fetch 并 checkout 待 review 的准确 commit SHA，核对 `git rev-parse HEAD` 后再审；不能 review 会移动的 main。PR head 更新后旧结论不覆盖新 SHA。

所有 agent worktree 用完即删，但必须先将成果保存到 commit、远端 PR 和证据，确认没有遗漏未提交改动；不得删除他人或仍活动的 worktree。当前 cwd 交由 Main 在确认三仓已 push、证据和父仓 patch 已保存后清理，本次不自行删除。

## 性能

仅关注首屏加载：减少阻塞资源和重复请求、控制 bundle 体积、按需加载、减少无效渲染；不承担后端 worker 吞吐目标。

## 交付状态

现有 `.github/workflows/ci.yml` 在 PR 事件执行检查；`build-agent.yml` 在 main push 后于 GitHub-hosted `ubuntu-latest` 按 `github.sha` 构建。它是云端 workflow，不是本地 Build Agent 自动调度。尚未实现本地 Build Agent 自动触发、签名审批验证或自动 E2E 交接；不能声称这些已形成门禁。

`/handoff` 更新本仓上下文：当前改动、问题、脱敏环境键、运行/检查命令、工具、文档索引和待办。

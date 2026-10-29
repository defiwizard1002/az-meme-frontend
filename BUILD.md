# 构建

Build 必须 checkout 要构建的准确 commit SHA，并读取该 SHA 的本文件；不能临时切换到移动的 main。Coder 开分支规则见 [开发规则](AGENTS.md)，Reviewer checkout 规则见 [Review](REVIEW.md)。只使用本仓依赖和 Dockerfile。

现有 `.github/workflows/ci.yml` 在 PR 事件执行检查；`build-agent.yml` 在 main push 后于 GitHub-hosted `ubuntu-latest` 按 `github.sha` 构建。它是云端 workflow，不是本地 Build Agent 自动调度。尚未实现本地 Build Agent 自动触发、签名审批验证或自动 E2E 交接；不能声称这些已形成门禁。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
docker build -t az-meme-frontend .
```

以上为后续构建命令，本次交付未执行，不沿用旧 Docker build 结果。证据记录 SHA、命令、退出码、产物和未覆盖项，不部署。

所有 agent worktree 用完即删，但必须先将成果保存到 commit、远端 PR 和证据，确认没有遗漏未提交改动；不得删除他人或仍活动的 worktree。当前 cwd 交由 Main 在确认三仓已 push、证据和父仓 patch 已保存后清理，本次不自行删除。

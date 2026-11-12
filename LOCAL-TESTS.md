# 本地检查

本次 workflow 文档改动不新增测试。以下命令仅供后续按需使用，Coder 不运行 E2E：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

需要外部服务、钱包、历史数据或浏览器的检查属于条件项，由本机 Main 按准确 SHA 调度；Vite build、自己的 Dockerfile 和 workflow 由 frontend repo 自己维护，合并后使用 GitHub-hosted `ubuntu-latest` runner，Coder 不运行 E2E。

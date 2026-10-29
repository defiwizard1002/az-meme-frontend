# CI/CD

本仓使用自己的 `.github/workflows/ci.yml`，运行在 GitHub-hosted `ubuntu-latest`，只 checkout 和处理本仓。

## CI 做什么

- `format:check`（recorder 无此脚本，跳过）
- `lint`（recorder 无此脚本，跳过）
- 单测

## CI 不做什么

- 不执行生产 build；
- 不执行 `docker build`；
- 不运行 E2E、真实服务、数据库、RPC 或真实钱包。

GitHub Actions 只做静态检查和单测。生产构建、镜像构建和部署由 Main 在本机调度 Build Agent 完成，规则见 [BUILD.md](BUILD.md)。

不使用 `self-hosted` runner，不使用 Webhook、轮询服务或常驻 bot。

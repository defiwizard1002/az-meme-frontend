# CI/CD

本仓当前没有云端 CI/CD，也没有 GitHub Actions workflow。

- 不执行生产 build、不执行 `docker build`；
- 不运行 E2E、真实服务、数据库、RPC 或真实钱包；
- 不使用 `self-hosted` runner，不使用 Webhook、轮询服务或常驻 bot。

PR 的检查和构建由 Main 在本机按需执行并记录；本仓不依赖任何云端流水线。需要重新引入 CI 时，先明确 Runner、费用和检查范围，再单独添加。

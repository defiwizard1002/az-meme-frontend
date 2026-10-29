# 设置

从本仓最新 `main` 检出并创建开发分支后，在仓库根目录执行：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm test
```

本仓的 `.github/workflows/ci.yml` 只跑 format check、lint 和单测，不做 build、不做 `docker build`。生产构建由 Main 在本机调度，见 [BUILD.md](BUILD.md)。

不要引用父仓路径、其他 submodule 或明文密钥。

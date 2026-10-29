# Build Agent

Build Agent 由 Main 在本机调度，不在 GitHub Actions 里执行。

- 使用准确的 commit SHA（合并后为 merge commit）检出本仓；
- 读取该 SHA 下的本文件和相关项目文档；
- 只在本仓执行构建，不修改代码、不部署、不运行 E2E；
- 记录 SHA、命令、退出码和产物位置，结果由 Main 写回 GitHub。

## 构建命令

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

构建失败或依赖缺失时报告 `BLOCKED`，不自行发明命令。构建完成后由 Main 决定是否进入 E2E。

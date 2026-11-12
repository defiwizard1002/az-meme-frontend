# 环境

Node.js 24；corepack pnpm 11.0.9，锁文件 `pnpm-lock.yaml`；公开配置见 [.env.example](.env.example)。浏览器不接收服务端密钥，前端需要可达 API。

私有环境使用 Git ignored 的 `.env.local.runtime` 等文件，不提交真实值。独立构建不依赖父仓目录；父仓仅是可选的聚合运行方式。

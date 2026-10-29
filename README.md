# az-meme-frontend

Node.js 24 + TypeScript + React/Vite 前端，通过 REST/WS 展示行情、K线和成交，并提供钱包签名登录和交易确认。后端需独立运行，本仓安装与构建不依赖父工作区。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
# 构建静态产物
corepack pnpm build
```

开发地址默认 `http://127.0.0.1:5173`；Vite 开发代理默认后端为 `http://127.0.0.1:3000`，通过 ignored env 的 `MEME_API_UPSTREAM` 指定可达上游。公开浏览器配置见 [.env.example](.env.example)，服务端凭据不能放入 `VITE_*`。独立 Docker 静态服务器不包含 Vite 代理，限制见 [交付说明](docs/tech/delivery-limitations.md)。

钱包登录使用 nonce/personal_sign/verify，Privy 授权签名由后端完成。交易按估计、准备、单独确认提交执行；PREPARE 不提交交易。公共行情不应等待登录，私有账户和交易按用户隔离。接口见 [API client](src/api.ts)。

[设置](SETUP.md) · [构建](BUILD.md) · [文档](docs/README.md) · [当前上下文](handoff.md)

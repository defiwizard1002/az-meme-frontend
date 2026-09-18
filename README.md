# az-meme-frontend

AZ MEME BOT PoC 前端。当前页面通过 Meme REST/WS 获取 Mock 数据，不在页面内写死业务 fixture。

推荐从父工作区启动完整本地拓扑：

```text
pnpm dev:mock
```

单独验证本仓：

```text
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

开发地址默认为 `http://127.0.0.1:5173`。只允许暴露 `VITE_MEME_API_BASE_URL`、`VITE_MEME_WS_URL` 和 AZ 登录公共 URL。

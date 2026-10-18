# az-meme-frontend

AZ MEME BOT PoC 前端，使用 Node.js 24 + TypeScript。当前页面通过 Meme REST/WS 获取榜单、Token、K 线和成交数据，可连接 Local Mock 或真实后端，不在页面内写死业务 fixture。

主账户 PoC 按 ESTIMATE → PREPARE_EXECUTION → 单独确认提交交互；PREPARE 本身不提交交易，实际签名和广播由后端执行。数据与交易请求见 [API client](src/api.ts)，准备和确认流程见 [页面](src/App.tsx) 与 [报价校验](src/quote-flow.ts)。

从父工作区启动完整本地 Mock 拓扑（在父仓目录执行，env 准备见父仓 README）：

```text
pnpm dev:mock
```

真实后端联调使用父仓 `pnpm dev:real:app`；后台行情使用父仓默认 unified 的 `pnpm dev:real:workers`，或用 `pnpm dev:real:all` 合并启动。

单独验证本仓：

```text
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

开发地址默认为 `http://127.0.0.1:5173`。客户端公共配置为 `VITE_MEME_API_BASE_URL`、`VITE_MEME_WS_URL` 和 `VITE_AZ_API_BASE_URL`；未配置时使用同源 REST/WS。真实连接配置放在 Git ignored 的本地 env 文件；密钥和服务端凭据不得进入前端环境变量。

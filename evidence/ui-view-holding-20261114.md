# View 与钱包 Holding 验收记录

验证时间：2026-11-13 18:34–18:42 PST（2026-11-14 02:34–02:42 UTC）。

## 页面和真实数据

- 本次带 `View` 按钮的是 Smart money 活动列表；代币详情中的 `Views` 面板是喊单列表，没有该按钮。
- 同一活动列表：[修改前](views-before.png)、[部署后](views-after.png)。
- 同一钱包 `0x018c7f05328a7b83eebaf70c8aa32e4181faa7f1`：[修改前](holding-before.png)、[部署后](holding-after.png)。
- 该钱包的接口数据中，SPCX 的 `observedNetAtomic` 为 `10000000000000000000`、USDG 为 `5000000000000000000`，二者 `decimals` 均为 18；部署后分别显示 `10`、`5`，并标注 `On-chain net (attribution incomplete)`。
- ABYSS 的净额为负，页面显示 `-23.0711M`，保留负号。链上净额不一定等于当前余额。
- 上述不完整持仓的 `valueUsd`、`unrealizedPnlUsd` 为 null，页面仍显示 `—`，分别提示价格或完整数量、成本依据或价值缺失。WETH 的价值显示正常，缺少成本时盈亏仍为 `—`。
- FABLES 的 `View` 在新标签打开交易 `0x0303a05b11696081c28667cd2a91adac1387c1891b63b551b8ab34a053607820`，实际页面显示该哈希的交易详情：[截图](explorer-after.png)。同一个交易也对应下一行 ABYSS。
- 链浏览器基础地址来自现有公共配置 `explorerBaseUrl`；该配置不可用时使用 `VITE_EXPLORER_BASE_URL`，默认 `https://robinhoodchain.blockscout.com`。交易路径沿用项目现有的 `/tx/<txHash>`；[Robinhood 官方网络文档](https://docs.robinhood.com/chain/connecting/)列明 chain ID 4663 和该浏览器。

## 检查

- `pnpm exec vitest run src/wallet-phase-d.test.tsx`：6 项通过，包括有效、缺失和无效交易哈希，正负净额，不同小数位及 null/零值显示。
- `pnpm run format:check`、`pnpm run lint`：通过；推送时的现有检查也通过。
- `pnpm run build`：通过；Vite 提示生成的 JS 大于 500 kB。
- 首次构建失败是因为独立克隆缺少 `src/display.test.ts` 所引用的父仓共享数据 `../../../tests/display-price.fixtures.json`。从本机已有父仓复制原文件到 `/private/tmp/tests/` 后构建通过；该文件的 SHA-256 为 `db9fccfc817513647afa3c58f59bb7f84f82cce6f489ec113a66152b4a7dba23`，与本机三个父仓副本一致。独立克隆仍需要这份父仓数据。
- 按任务要求只运行相关组件测试，没有运行全量测试。

## 部署和公网读回

Caddy 3300 实际静态目录为 `/Users/dope/services/az-meme/submodules/az-meme-frontend/dist`。部署新资源后更新 `index.html`，未更改 Caddy 配置或重启服务。

从 `https://dopemac-mini.tailc44fad.ts.net:10000/` 读取的三个文件，其 SHA-256 与本地构建产物及 Caddy 静态目录完全一致：

| 文件 | SHA-256 |
| --- | --- |
| `index.html` | `d07f27a56cb9297f355d5e957316be2a61ee9c11ebe3c0120d6f0f44bf980929` |
| `assets/index-BjdXpIRK.js` | `111ee046e07b10e75fd4ea3bcc82ed84fed380f74990ffea7700ae1f3306d505` |
| `assets/index-B61UXgxv.css` | `e5f4db2f0cc7e3208148150ca6466d9df6eae3c1886268ef53a7a193867cdfea` |

## Git

部署所用代码提交 `e1b2d9c07dfd3d4b16b8ade4a37c96926b9fd818` 已推送到 `main`；`git ls-remote origin refs/heads/main` 随后读回同一 SHA。本报告作为后续的纯文档提交推送，不改变已部署的前端代码。

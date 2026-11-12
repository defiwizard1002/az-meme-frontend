# 本次交付限制

workflow 在启用 Corepack/pnpm 之前请求 setup-node 的 pnpm cache，runner 上 pnpm 是否可用尚未验证；可能在安装依赖前失败。现有 Docker 静态服务器未设置 MIME 类型，也不提供 Vite 的 REST/WS 代理；默认同源 API 不能假定可用，浏览器模块加载尚未验证。

本次保留既有 Dockerfile/workflow，不修业务代码或扩建实现；未运行测试、Docker、E2E 或服务，不声明生产可用。审批签名与本地 Build Agent 自动触发尚未实现。PR 的 head SHA 和 checks 需分别读回核验；没有检查结果不能声称 CI 通过。

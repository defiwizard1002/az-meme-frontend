# 目标与边界

本仓负责行情、K 线、交易确认和钱包连接页面，并独立管理自己的源码、依赖、Vite 构建、检查和发布输入。

前端使用自己的 Vite build、Dockerfile 和 workflow；合并后由 GitHub-hosted `ubuntu-latest` runner 按准确 merge SHA 执行，本机 Main 负责真实页面流程，Coder 不运行 E2E。父仓提供可选编排，本仓独立构建。

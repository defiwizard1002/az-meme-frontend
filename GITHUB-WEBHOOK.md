# GitHub Webhook

不启用 Webhook、self-hosted runner、轮询或常驻 bot。本地 agent 由 Main 手动协调，GitHub comment/status 用于记录；GitHub Actions 仍按 PR/main push 事件运行云端检查，见 [CI/CD](CI-CD.md)。本地 Build Agent 自动触发尚未实现。

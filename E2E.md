# E2E

E2E 由本机 Main 在 Build handoff 后按准确 SHA、独立 worktree、端口和证据目录调度；Coder 不运行 E2E。Build 完成后才能进入 E2E。

需要浏览器时复用已有浏览器实例和持久 profile；GitHub 只保留过程记录，不使用 self-hosted runner。

# Security

aircontrol runs as hooks inside Claude Code and Codex, and its `guard` hook can deny tool
calls, so a bug here can affect every agent session on a machine.

Report a vulnerability privately via GitHub: **Security → Report a vulnerability** on
https://github.com/ahavasi/aircontrol. Please do not open a public issue for it.

aircontrol keeps all state under `~/.claude/agents` and sends nothing off the machine
unless you configure cross-machine `peers` (see the README), which use your own ssh.

# Security

aircontrol runs as hooks inside Claude Code and Codex, and its `guard` hook can deny tool
calls, so a bug here can affect every agent session on a machine.

Report a vulnerability privately via GitHub: **Security → Report a vulnerability** on
https://github.com/ahavasi/aircontrol. Please do not open a public issue for it.

aircontrol keeps all state under `~/.claude/agents` and sends nothing off the machine
unless you configure cross-machine `peers` (see the README), which use your own ssh, or a
relay.

## The relay

The relay is a Cloudflare Worker that `relay deploy` puts on **your own** Cloudflare
account. Nobody else runs it or sees its data. It holds session names, intents, branch names,
claimed paths and the text of messages between your sessions.

- **Tokens.** Anyone holding a relay token can read your roster, hold claims (which the guard
  then enforces on your machines) and post messages into your sessions. A message is read by
  an agent, so treat a leaked token like a prompt-injection channel into your sessions, and
  revoke it: `aircontrol relay token revoke <name>`. Mint one token per machine or cloud
  environment so each can be revoked alone. The relay stores only SHA-256 hashes of tokens.
- **The admin token** (`~/.claude/agents/relay-admin-token`, mode 600, and the Worker's
  `ADMIN_TOKEN` secret) can do everything a token can, and also mint and revoke tokens. Keep it on one machine.
- **In cloud environments**, the token is the `AIRCONTROL_RELAY_TOKEN` environment variable,
  which the agent can read. Give each environment its own token so a leak is revoked alone. A
  credential store that attaches the header to outbound requests would hide it from the agent,
  but that route is untested. Codex Cloud removes secrets before the agent runs, so there the
  variable is the only option.
- **Failure mode.** If the relay is down or unreachable, aircontrol fails open: claims are
  recorded locally, and cross-machine claims simply are not enforced until it returns.

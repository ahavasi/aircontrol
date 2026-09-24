# Contributing

aircontrol is plain Node (>= 18) with one dependency (`ws`). No build step.

```bash
git clone https://github.com/ahavasi/aircontrol.git
cd aircontrol && npm install
npm test               # node --test; every test sandboxes HOME via AIRCONTROL_HOME
node install.js        # install your working copy into ~/.claude and ~/.codex
```

- `coord.js` is the whole runtime: hooks, CLI, guard. `install.js` wires it into both
  harnesses. The installed copies under `~/.claude/hooks` and `~/.codex/hooks` are
  overwritten on every install, so change the repo and re-run `node install.js`.
- Installing from a clone symlinks `skills/` into `~/.claude/skills`, so skill edits land
  in the repo.
- Hooks must never break a session: they swallow errors and exit 0. Keep new hook code
  fail-open.
- Add a test for every behaviour change. Tests must not touch the real home directory.

## Releasing

1. Bump `version` in `package.json` and commit.
2. `git tag v<version> && git push origin v<version>`.
3. The `publish` workflow runs the tests and stages the version on npm with provenance.
4. A maintainer approves it with 2FA: `npm stage list aircontrol`, then
   `npm stage approve <stage-id>`, or approve it on npmjs.com.

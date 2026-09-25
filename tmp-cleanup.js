'use strict';
// Tests create hundreds of mkdtemp dirs per run (git repos, fake homes); without this they
// pile up in $TMPDIR forever and count against the disk as System Data.
const fs = require('fs');
const path = require('path');

const made = [];
const mkdtemp = fs.mkdtempSync;
fs.mkdtempSync = (...args) => {
  const d = mkdtemp(...args);
  made.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of made) {
    // Worktree tests put `git worktree add` targets beside the temp dir as `<dir>-wt`.
    let siblings = [];
    try {
      const base = path.basename(d) + '-';
      siblings = fs.readdirSync(path.dirname(d)).filter((n) => n.startsWith(base)).map((n) => path.join(path.dirname(d), n));
    } catch {}
    for (const p of [d, ...siblings]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  }
});

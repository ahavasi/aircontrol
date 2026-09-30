'use strict';
// `relay deploy` and `relay token …`: stand up and manage the user's own relay
// on their Cloudflare account. Ships with the npm package only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const WRANGLER = ['-y', 'wrangler@4'];

function writeSecretFile(file, value) {
  fs.writeFileSync(file, value + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function readSecretFile(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

function adminTokenFile(dataDir) { return path.join(dataDir(), 'relay-admin-token'); }

function wrangler(args, opts = {}) {
  return spawnSync('npx', [...WRANGLER, ...args], { encoding: 'utf8', ...opts });
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function mergeConfig(configFile, patch) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch {}
  cfg.relay = { ...(cfg.relay || {}), ...patch };
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 1));
}

function renderWorkerDir(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['room.js', 'worker.mjs']) fs.copyFileSync(path.join(__dirname, 'relay', f), path.join(dir, f));
  const toml = fs.readFileSync(path.join(__dirname, 'relay', 'wrangler.toml.tmpl'), 'utf8').replace('{{NAME}}', name);
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), toml);
}

function cmdDeploy(args, ctx) {
  const { dataDir, configFile, relayRequest, relayMachine } = ctx;
  const name = typeof args.name === 'string' ? args.name : 'aircontrol-relay';
  if (!/^[a-z0-9-]{1,63}$/.test(name)) throw new Error('--name must be lowercase letters, digits and dashes');
  fs.mkdirSync(dataDir(), { recursive: true });
  const dir = path.join(dataDir(), 'relay-deploy');
  renderWorkerDir(dir, name);

  if (wrangler(['whoami'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] }).status !== 0) {
    throw new Error('wrangler is not logged in to Cloudflare: run `npx wrangler login`, then `relay deploy` again');
  }
  console.log(`deploying ${name} to your Cloudflare account…`);
  const dep = wrangler(['deploy'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  if (dep.status !== 0) throw new Error('wrangler deploy failed (output above)');
  const url = (String(dep.stdout).match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0] || args.url;
  if (!url) throw new Error('deployed, but could not find the workers.dev URL in wrangler output; re-run with --url <url>');

  // The admin token is generated here and handed to wrangler over stdin, so it
  // never appears in argv, output, or the transcript.
  let admin = readSecretFile(adminTokenFile(dataDir));
  if (!admin) {
    admin = 'acr_admin_' + crypto.randomBytes(32).toString('hex');
    writeSecretFile(adminTokenFile(dataDir), admin);
  }
  const sec = wrangler(['secret', 'put', 'ADMIN_TOKEN'], { cwd: dir, input: admin, stdio: ['pipe', 'ignore', 'inherit'] });
  if (sec.status !== 0) throw new Error('could not set the ADMIN_TOKEN secret (output above)');
  mergeConfig(configFile, { url });

  // A fresh secret takes a few seconds to reach the edge.
  const machine = relayMachine();
  let minted = null;
  let lastErr = null;
  for (let i = 0; i < 10 && !minted; i++) {
    try { minted = relayRequest('POST', '/v1/tokens', { name: machine }, { token: admin, config: { url } }); } catch (e) { lastErr = e; sleep(3000); }
  }
  if (!minted) throw new Error(`relay deployed at ${url}, but minting this machine's token failed: ${lastErr && lastErr.message}`);
  writeSecretFile(path.join(dataDir(), 'relay-token'), minted.token);
  console.log(`relay live at ${url}; this machine joined as "${machine}".`);
  console.log('Next: other machines run `npx aircontrol relay token add <name> --out <file>` here and put that token in their');
  console.log('~/.claude/agents/relay-token; cloud repos run `npx aircontrol cloud init`.');
}

function cmdToken(args, ctx) {
  const { dataDir, relayRequest } = ctx;
  const request = (ctx.deps && ctx.deps.request) || relayRequest;
  const sub = args._[2];
  const name = args._[3];
  const admin = process.env.AIRCONTROL_RELAY_ADMIN_TOKEN || readSecretFile(adminTokenFile(dataDir));
  if (!admin) throw new Error('no admin token on this machine (it lives where `relay deploy` ran)');
  if (sub === 'list') {
    for (const t of request('GET', '/v1/tokens', undefined, { token: admin })) console.log(`${t.name}  (created ${t.created})`);
    return;
  }
  if (!name) throw new Error('usage: relay token <add|revoke> <name> [--out file]');
  if (sub === 'revoke') {
    const r = request('DELETE', `/v1/tokens/${encodeURIComponent(name)}`, undefined, { token: admin });
    console.log(r.revoked ? `revoked ${name}` : `no token named ${name}`);
    return;
  }
  if (sub === 'add') {
    const r = request('POST', '/v1/tokens', { name }, { token: admin });
    if (typeof args.out === 'string') {
      writeSecretFile(args.out, r.token);
      console.log(`token for ${name} written to ${args.out} (mode 600). Adding the same name again replaces it.`);
    } else {
      console.log(r.token);
      process.stderr.write(`token for ${name}: shown once. Paste it into the environment, then clear your scrollback. Adding the same name again replaces it.\n`);
    }
    return;
  }
  throw new Error('usage: relay token <add|revoke|list> [name]');
}

module.exports = { cmdDeploy, cmdToken, renderWorkerDir };

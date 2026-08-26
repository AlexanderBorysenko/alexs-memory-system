#!/usr/bin/env node
// Version + release helper for the alex-makoto-plugins monorepo.
//
// The single source of truth for a plugin's version is its own
// <plugin>/.claude-plugin/plugin.json "version". Two things must mirror it:
//   1. the matching entry in root .claude-plugin/marketplace.json (plugins[].version)
//   2. every sibling's dependencies[].version caret range that points at it
// This script keeps those consistent so nobody resolves it by hand, and
// automates the push→update-on-machine dance after changes.
//
//   node scripts/plugins.mjs check              validate all invariants (exit 1 on drift)
//   node scripts/plugins.mjs sync               fix marketplace mirror + dep ranges in place
//   node scripts/plugins.mjs bump <name> <major|minor|patch>
//                                               bump one plugin then cascade-sync
//   node scripts/plugins.mjs release ["msg"]    check → git commit+push → update on this machine
//
// No dependencies — Node built-ins only.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKETPLACE = join(ROOT, '.claude-plugin', 'marketplace.json');
const MARKET_NAME = 'alex-makoto-plugins'; // marketplace id as installed on the machine

// ---- tiny semver (caret only; no external dep) --------------------------------

const parse = (v) => v.replace(/^[v^~]/, '').split('.').map(Number);
const cmp = (a, b) => { a = parse(a); b = parse(b); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; };

// Does version `v` satisfy caret range `range` (e.g. "^0.6.0")? Plain "1.2.3" = exact.
function satisfies(v, range) {
  if (!range.startsWith('^')) return cmp(v, range) === 0;
  const [maj, min, pat] = parse(range);
  if (cmp(v, range) < 0) return false; // must be >= base
  const [vmaj, vmin, vpat] = parse(v);
  if (maj > 0) return vmaj === maj;                 // ^1.2.3 → <2.0.0
  if (min > 0) return vmaj === 0 && vmin === min;   // ^0.6.0 → <0.7.0
  return vmaj === 0 && vmin === 0 && vpat === pat;  // ^0.0.3 → exactly 0.0.3
}

function inc(v, level) {
  const [maj, min, pat] = parse(v);
  if (level === 'major') return `${maj + 1}.0.0`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  if (level === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`bump level must be major|minor|patch, got "${level}"`);
}

// ---- model --------------------------------------------------------------------

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');

// Returns { market, plugins: { name: { path, json } } } — plugin.json is the truth.
function load() {
  const market = readJson(MARKETPLACE);
  const plugins = {};
  for (const entry of market.plugins) {
    const path = join(ROOT, entry.source, '.claude-plugin', 'plugin.json');
    plugins[entry.name] = { path, json: readJson(path), source: entry.source };
  }
  return { market, plugins };
}

// Compute drift without mutating; returns list of {kind, msg, fix()}.
function audit({ market, plugins }) {
  const drift = [];
  for (const entry of market.plugins) {
    const p = plugins[entry.name];
    if (!p) { drift.push({ msg: `marketplace lists "${entry.name}" but ${entry.source} has no plugin.json` }); continue; }
    // INV1: marketplace mirror == plugin.json version
    if (entry.version !== p.json.version) {
      drift.push({
        msg: `marketplace ${entry.name}@${entry.version} != plugin.json ${p.json.version}`,
        path: MARKETPLACE,
        fix: () => { entry.version = p.json.version; },
      });
    }
    // INV2: dep ranges satisfied by the referenced plugin's current version
    for (const dep of p.json.dependencies || []) {
      const target = plugins[dep.name];
      if (!target) continue; // cross-marketplace dep (see allowCrossMarketplaceDependenciesOn) — not ours to version
      if (!satisfies(target.json.version, dep.version)) {
        const want = `^${target.json.version}`;
        drift.push({
          msg: `${entry.name} requires ${dep.name}@${dep.version} but ${dep.name} is ${target.json.version} → ${want}`,
          path: p.path,
          fix: () => { dep.version = want; },
        });
      }
    }
  }
  return drift;
}

// Write only the files in `dirty` (a Set of paths), so untouched plugin.json
// files keep their existing formatting instead of getting reserialized.
function persist(model, dirty) {
  const byPath = { [MARKETPLACE]: model.market };
  for (const p of Object.values(model.plugins)) byPath[p.path] = p.json;
  for (const path of dirty) writeJson(path, byPath[path]);
}

// ---- commands -----------------------------------------------------------------

function check() {
  const drift = audit(load());
  if (drift.length === 0) { console.log('✓ versions consistent across marketplace.json and all plugin.json'); return 0; }
  console.error('✗ version drift:');
  for (const d of drift) console.error('  - ' + d.msg);
  console.error(`\nRun: node scripts/plugins.mjs sync`);
  return 1;
}

function sync() {
  const model = load();
  const drift = audit(model);
  const fixable = drift.filter((d) => d.fix);
  const stuck = drift.filter((d) => !d.fix);
  fixable.forEach((d) => d.fix());
  if (fixable.length) persist(model, new Set(fixable.map((d) => d.path)));
  fixable.forEach((d) => console.log('  fixed: ' + d.msg));
  stuck.forEach((d) => console.error('  UNRESOLVABLE: ' + d.msg));
  if (!drift.length) console.log('✓ already consistent');
  return stuck.length ? 1 : 0;
}

function bump(name, level) {
  const model = load();
  const p = model.plugins[name];
  if (!p) { console.error(`no such plugin: ${name}`); return 1; }
  const from = p.json.version;
  p.json.version = inc(from, level);
  console.log(`${name}: ${from} → ${p.json.version}`);
  writeJson(p.path, p.json);
  return sync(); // cascade: marketplace mirror + any sibling dep range that now falls out of caret
}

function sh(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
}

function release(msg) {
  if (check()) { console.error('\nfix drift before releasing.'); return 1; }
  // manifest schema check via the CLI (catches things beyond version invariants)
  try { sh('claude', ['plugin', 'validate', '.']); } catch { console.error('manifest validation failed.'); return 1; }

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT }).toString().trim();
  if (status) {
    sh('git', ['add', '-A']);
    sh('git', ['commit', '-m', msg || 'release: sync plugin versions']);
  } else {
    console.log('nothing to commit — releasing current HEAD.');
  }
  sh('git', ['push']);

  // update-on-machine: marketplace source is the GitHub repo, so pull it then bump installs
  sh('claude', ['plugin', 'marketplace', 'update', MARKET_NAME]);
  for (const entry of readJson(MARKETPLACE).plugins) {
    try { sh('claude', ['plugin', 'update', `${entry.name}@${MARKET_NAME}`]); }
    catch { console.error(`  (skip ${entry.name} — not installed on this machine)`); }
  }
  console.log('\n✓ released. Restart Claude Code to apply updated plugins.');
  return 0;
}

// ---- dispatch -----------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const table = {
  check: () => check(),
  sync: () => sync(),
  bump: () => bump(rest[0], rest[1]),
  release: () => release(rest.join(' ') || undefined),
};
if (!table[cmd]) {
  console.error('usage: node scripts/plugins.mjs <check|sync|bump <name> <major|minor|patch>|release ["msg"]>');
  process.exit(2);
}
process.exit(table[cmd]());

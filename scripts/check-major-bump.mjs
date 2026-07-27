#!/usr/bin/env node
// GATE — a MAJOR version bump requires explicit approval. Minor and patch are free.
//
// WHY
// A major is irreversible on npm and PyPI and it re-frames the product for every reader. It is the
// one release decision that is never an implementation detail. Written-down rules get missed at 2am;
// this makes the build fail instead.
//
// It also catches the accident that started this: @cendor/contextkit took an UNINTENDED major years
// ago because a peer range widened past ^0.2.x and changesets classes that as breaking. Nobody
// approved it, nobody noticed, and the number could never be walked back — npm versions only move
// forward. That single accident is why the npm family's majors had to be realigned.
//
// HOW TO APPROVE
//   JS      add a line `Approved-Major: <who> <yyyy-mm-dd>` inside the changeset that declares major
//   Python  create `APPROVED-MAJOR` in the repo root containing the target version, e.g. `2.0.0`
//
// Both are deliberately in-band and reviewable: the approval travels with the change, in the diff,
// rather than living in a CI variable or someone's memory.
//
// USAGE  node scripts/check-major-bump.mjs [repoDir ...]      (default: every publishing repo)
// EXIT   0 = no unapproved major; 1 = an unapproved major bump

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPROVAL_RE = /^\s*Approved-Major:\s*\S+/im;

// This script is VENDORED into the JS repos so their CI can run it without the workspace root (CI
// checks out one repo). So it must work in two places, and must never silently check nothing —
// resolving workspace-relative paths from inside a repo would find no repos and "pass", which is the
// worst possible outcome for a gate. Detect which context we are in, explicitly.
const SELF_IS_REPO =
  existsSync(join(HERE, '.changeset')) || existsSync(join(HERE, 'pyproject.toml'));
const WS = SELF_IS_REPO ? resolve(HERE, '..') : HERE;
const ONLY = SELF_IS_REPO ? HERE.split(/[\\/]/).pop() : null;

const keep = (r) => ONLY === null || r === ONLY;
const JS_REPOS = ['cendor-libs-js', 'cendor-sdk-js'].filter(keep);
const PY_REPOS = [
  ['cendor-libs', 'packages'], // a uv workspace: every packages/*/pyproject.toml
  ['cendor-sdk', null], // single package at the root
].filter(([r]) => keep(r));

if (ONLY && JS_REPOS.length === 0 && PY_REPOS.length === 0) {
  console.error(
    `check-major-bump: running inside "${ONLY}", which is not a known publishing repo.`,
  );
  console.error(
    'Add it to JS_REPOS/PY_REPOS or run from the workspace root. Refusing to pass silently.',
  );
  process.exit(1);
}

const problems = [];
const notes = [];
let checked = 0;

const major = (v) => Number(String(v).split('.')[0]);

// ─────────────────────────────────────────────────────────── JS: scan pending changesets
for (const repo of JS_REPOS) {
  const dir = join(WS, repo, '.changeset');
  if (!existsSync(dir)) continue;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md') || file === 'README.md') continue;
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');

    // Front matter: lines like `'@cendor/core': major`
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;
    const majors = [...fm[1].matchAll(/['"]([^'"]+)['"]\s*:\s*major/g)].map((m) => m[1]);
    if (majors.length === 0) continue;

    checked++;
    if (APPROVAL_RE.test(text)) {
      notes.push(`approved major in ${repo}/.changeset/${file}: ${majors.join(', ')}`);
    } else {
      problems.push(
        `${repo}/.changeset/${file} declares a MAJOR for ${majors.join(', ')} with no approval.\n      Add a line inside the changeset body:  Approved-Major: <who> <yyyy-mm-dd>`,
      );
    }
  }
}

// ───────────────────── JS: also compare package.json against the last published tag
// A changeset is not the only way a major lands. `changeset version` can only step ONE major at a
// time, so a target it cannot express (e.g. aligning a family onto a shared major) is hand-set in
// package.json with NO changeset present — and `changeset publish` will happily ship that. Scanning
// changesets alone would leave the gate wide open on exactly the path a human takes when changesets
// gets in the way. Tags are the release record: changesets tags each publish `@cendor/<x>@<version>`.
for (const repo of JS_REPOS) {
  const root = join(WS, repo);
  const pkgsDir = join(root, 'packages');
  if (!existsSync(pkgsDir)) continue;

  const approvalFile = join(root, 'APPROVED-MAJOR');
  const approved = existsSync(approvalFile)
    ? readFileSync(approvalFile, 'utf8').trim().split(/\s+/).filter(Boolean)
    : [];

  let tags = [];
  try {
    tags = execFileSync('git', ['tag'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    continue;
  }

  for (const name of readdirSync(pkgsDir)) {
    const file = join(pkgsDir, name, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    if (!pkg.name || pkg.private) continue;
    checked++;

    const majors = tags
      .map((t) => (t.startsWith(`${pkg.name}@`) ? t.slice(pkg.name.length + 1) : null))
      .filter(Boolean)
      .map(major)
      .filter((n) => Number.isFinite(n));
    if (majors.length === 0) continue; // never released — the first release sets the major

    const highest = Math.max(...majors);
    if (major(pkg.version) > highest) {
      const token = `${pkg.name}@${pkg.version}`;
      if (approved.includes(token)) {
        notes.push(`approved major in ${repo}: ${token} (APPROVED-MAJOR lists it)`);
      } else {
        problems.push(
          `${repo}: ${pkg.name} is at ${pkg.version} but has only ever published major ${highest},\n      and no changeset declares it. Hand-set majors need approval too.\n      Add this exact token to ${repo}/APPROVED-MAJOR:  ${token}`,
        );
      }
    }
  }
}

// ────────────────────────────────────────── Python: compare pyproject major against the last tag
// Nothing declares intent up front the way a changeset does, so the signal is the working version
// vs. what the repo last released. `git tag` is the release record for these repos.
function pyVersion(file) {
  const t = readFileSync(file, 'utf8');
  return t.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

for (const [repo, pkgDir] of PY_REPOS) {
  const root = join(WS, repo);
  if (!existsSync(root)) continue;

  const approvalFile = join(root, 'APPROVED-MAJOR');
  const approved = existsSync(approvalFile) ? readFileSync(approvalFile, 'utf8').trim() : null;

  let tags = [];
  try {
    tags = execFileSync('git', ['tag'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    continue; // not a git repo / no tags yet — nothing to compare against
  }

  const targets = pkgDir
    ? readdirSync(join(root, pkgDir))
        .map((p) => [p, join(root, pkgDir, p, 'pyproject.toml')])
        .filter(([, f]) => existsSync(f))
    : [[repo, join(root, 'pyproject.toml')]];

  for (const [name, file] of targets) {
    const v = pyVersion(file);
    if (!v) continue;
    checked++;

    // Highest major this package has ever tagged. Tags are `<tool>-vX.Y.Z` in cendor-libs and
    // `vX.Y.Z` in cendor-sdk.
    const tool = name.replace(/^cendor-?/, '') || 'cendor';
    const re = pkgDir ? new RegExp(`^${tool}-v(\\d+)\\.`) : /^v(\d+)\./;
    const majors = tags
      .map((t) => t.match(re)?.[1])
      .filter(Boolean)
      .map(Number);
    if (majors.length === 0) continue; // never released — first release sets the major

    const highest = Math.max(...majors);
    if (major(v) > highest) {
      if (approved === v) {
        notes.push(`approved major in ${repo}: ${name} ${v} (APPROVED-MAJOR matches)`);
      } else {
        problems.push(
          `${repo}: ${name} is at ${v} but has only ever released major ${highest}.\n` +
            `      A major needs approval. Create ${repo}/APPROVED-MAJOR containing exactly: ${v}`,
        );
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────── report
for (const n of notes) console.log(`  ok     ${n}`);
console.log(`\ncheck-major-bump: ${checked} version declaration(s) checked`);

if (problems.length) {
  console.error(`\n${problems.length} UNAPPROVED MAJOR BUMP(S):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    '\nA major is irreversible on a registry and re-frames the product for every reader.' +
      '\nIt is never an autonomous decision — propose it, say what breaks, and get approval.\n',
  );
  process.exit(1);
}
console.log('check-major-bump: PASS');

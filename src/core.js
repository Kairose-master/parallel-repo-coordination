/**
 * pairwarn core: git discovery, note-file IO, acknowledgement state, hook text.
 *
 * Zero runtime dependencies on purpose. This tool sits in every contributor's
 * pre-push path, so it must not be a supply-chain liability itself. Node
 * built-ins only.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

export const BIN_NAME = 'pairwarn';
export const DEFAULT_NOTE_FILE = 'conversation.md';
export const ACK_DIR_NAME = 'pairwarn';
export const HOOK_MARKER_START = `# >>> ${BIN_NAME} >>>`;
export const HOOK_MARKER_END = `# <<< ${BIN_NAME} <<<`;
export const MAX_PRINTED_LINES = 200;

/** Header written into a brand new note file by `init` / first `note`. */
export const NOTE_HEADER = `# Shared working notes

Every session that touches this repository appends a short, dated,
branch-stamped section to the bottom of this file before it pushes: anything
another session could trip over. Files being rewritten wholesale, migrations in
flight, assumptions that are about to stop being true.

    npx ${BIN_NAME} check           # refuses until this file has been read here
    npx ${BIN_NAME} ack             # records that you have read it
    npx ${BIN_NAME} note "..."      # append a section (writing is also reading)

The acknowledgement is stored in .git/ and is never committed, so a fresh clone
is a fresh reader. Append at the bottom; do not rewrite history above.
`;

/* ------------------------------------------------------------------ git --- */

async function git(args, cwd) {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

/**
 * Locate the working copy. Returns null when we are not inside a git work
 * tree at all (a tarball, a Docker COPY, a git-less machine) — there is
 * nothing to gate in that case.
 */
export async function findRepo(cwd = process.cwd()) {
  try {
    const root = await git(['rev-parse', '--show-toplevel'], cwd);
    if (!root) return null;
    // --absolute-git-dir is per working copy: a linked worktree gets its own
    // acknowledgement, which is exactly the semantics we want.
    const gitDir = await git(['rev-parse', '--absolute-git-dir'], cwd);
    return { root, gitDir };
  } catch {
    return null;
  }
}

/** Best-effort branch label for note stamps. Survives unborn/detached HEAD. */
export async function currentBranch(cwd) {
  try {
    const name = await git(['branch', '--show-current'], cwd);
    if (name) return name;
  } catch { /* fall through */ }
  try {
    const sha = await git(['rev-parse', '--short', 'HEAD'], cwd);
    if (sha) return `detached@${sha}`;
  } catch { /* fall through */ }
  return 'no-branch';
}

/** Hook directory, honouring core.hooksPath and linked worktrees. */
export async function hooksDir(cwd) {
  const p = await git(['rev-parse', '--git-path', 'hooks'], cwd);
  return path.resolve(cwd, p);
}

/* ------------------------------------------------------------- note file --- */

export function noteFileName(env = process.env, override) {
  if (override && override.trim()) return override.trim();
  const fromEnv = env.NOTE_FILE && String(env.NOTE_FILE).trim();
  return fromEnv || DEFAULT_NOTE_FILE;
}

export function notePath(root, name) {
  return path.isAbsolute(name) ? name : path.join(root, name);
}

/** Stable, filesystem-safe key so several note files can coexist. */
export function ackKey(root, name) {
  const rel = path.isAbsolute(name) ? path.relative(root, name) : name;
  const slug = rel.split(/[\\/]/).join('__').replace(/[^A-Za-z0-9._-]/g, '_');
  return slug || 'note';
}

export function ackPaths(gitDir, key) {
  const dir = path.join(gitDir, ACK_DIR_NAME);
  return {
    dir,
    snapshot: path.join(dir, `${key}.snapshot`),
    meta: path.join(dir, `${key}.json`),
  };
}

export async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export function splitLines(text) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Lines present in `current` after the longest common prefix it shares with
 * `previous`. For an append-only file this is exactly what was appended; for
 * an edited file it is everything from the first divergence, which is the
 * honest conservative answer.
 */
export function newLines(previous, current) {
  const prev = splitLines(previous);
  const cur = splitLines(current);
  let i = 0;
  while (i < prev.length && i < cur.length && prev[i] === cur[i]) i += 1;
  return cur.slice(i);
}

/** Record the current note content as read, in this working copy only. */
export async function writeAck(gitDir, key, content, extra = {}) {
  const { dir, snapshot, meta } = ackPaths(gitDir, key);
  await mkdir(dir, { recursive: true });
  await writeFile(snapshot, content, 'utf8');
  await writeFile(
    meta,
    `${JSON.stringify({ v: 1, ackedAt: new Date().toISOString(), lines: splitLines(content).length, ...extra }, null, 2)}\n`,
    'utf8',
  );
  return { snapshot, meta };
}

export async function readAck(gitDir, key) {
  const { snapshot, meta } = ackPaths(gitDir, key);
  const content = await readText(snapshot);
  let info = null;
  const rawMeta = await readText(meta);
  if (rawMeta) {
    try { info = JSON.parse(rawMeta); } catch { info = null; }
  }
  return { content, info };
}

/* ----------------------------------------------------------- note append --- */

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function formatSection(text, branch, date = today()) {
  const body = String(text).replace(/\r\n/g, '\n').trim();
  return `## ${date} — ${branch}\n\n${body}\n`;
}

/** Append a dated, branch-stamped section; returns the full new file content. */
export function appendSection(existing, section) {
  let base = existing ?? '';
  if (base.trim() === '') base = NOTE_HEADER;
  if (!base.endsWith('\n')) base += '\n';
  return `${base}\n${section}`;
}

/* ----------------------------------------------------------------- hook --- */

export function hookBlock() {
  return [
    HOOK_MARKER_START,
    `# Managed by \`${BIN_NAME} install-hook\`. Delete this block to remove the gate.`,
    `# Refuses the push until the shared note file has been read in THIS working copy.`,
    `${BIN_NAME}_gate() {`,
    `  root=$(git rev-parse --show-toplevel 2>/dev/null) || return 0`,
    `  if [ -n "$PAIRWARN_BIN" ]; then`,
    `    "$PAIRWARN_BIN" check`,
    `  elif [ -x "$root/node_modules/.bin/${BIN_NAME}" ]; then`,
    `    "$root/node_modules/.bin/${BIN_NAME}" check`,
    `  elif command -v ${BIN_NAME} >/dev/null 2>&1; then`,
    `    ${BIN_NAME} check`,
    `  elif command -v npx >/dev/null 2>&1; then`,
    `    npx --yes ${BIN_NAME} check`,
    `  else`,
    `    echo "${BIN_NAME}: not installed; skipping the shared-note gate" >&2`,
    `    return 0`,
    `  fi`,
    `}`,
    `${BIN_NAME}_gate || exit 1`,
    HOOK_MARKER_END,
    '',
  ].join('\n');
}

/** Idempotent: returns {action, file}. Never double-appends the block. */
export async function installHook(dir, hookName = 'pre-push') {
  const file = path.join(dir, hookName);
  await mkdir(dir, { recursive: true });
  const current = await readText(file);
  if (current !== null && current.includes(HOOK_MARKER_START)) {
    await chmod(file, 0o755).catch(() => {});
    return { action: 'already-installed', file };
  }
  if (current === null) {
    await writeFile(file, `#!/bin/sh\n# git ${hookName} hook\n\n${hookBlock()}`, 'utf8');
    await chmod(file, 0o755);
    return { action: 'created', file };
  }
  const sep = current.endsWith('\n') ? '\n' : '\n\n';
  await writeFile(file, `${current}${sep}${hookBlock()}`, 'utf8');
  await chmod(file, 0o755).catch(() => {});
  return { action: 'appended', file };
}

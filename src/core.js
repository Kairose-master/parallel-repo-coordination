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
import { createHash } from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);

export const BIN_NAME = 'pairwarn';
export const DEFAULT_NOTE_FILE = 'conversation.md';
export const ACK_DIR_NAME = 'pairwarn';
export const HOOK_MARKER_START = `# >>> ${BIN_NAME} >>>`;
export const HOOK_MARKER_END = `# <<< ${BIN_NAME} <<<`;
export const MAX_PRINTED_LINES = 200;
export const TRAILER_KEY = 'Note-Ack';
export const DIGEST_LENGTH = 12;

/** Header written into a brand new note file by `init` / first `note`. */
export const NOTE_HEADER = `# Shared working notes

Every session that touches this repository appends a short, dated,
branch-stamped section to the bottom of this file before it pushes: anything
another session could trip over. Files being rewritten wholesale, migrations in
flight, assumptions that are about to stop being true.

    npx ${BIN_NAME} check           # refuses until this file has been read here
    npx ${BIN_NAME} ack <token>     # the token comes from check, so you cannot
                                    # clear text you were never shown
    npx ${BIN_NAME} note "..."      # append a section (writing is also reading)

The acknowledgement is stored in .git/ and is never committed, so a fresh clone
is a fresh reader. Append at the bottom; do not rewrite history above — the
gate treats a rewrite of acknowledged text as unread. Use \`${BIN_NAME} archive\`
to retire old sections instead.
`;

/* ------------------------------------------------------------------ git --- */

async function git(args, cwd) {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

/** Run git and return stdout, untrimmed on request. Throws on non-zero exit. */
export async function gitOutput(args, cwd, { trim = true } = {}) {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return trim ? stdout.trim() : stdout;
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
 * `previous`. Used as the fallback when the file is not section-structured.
 */
export function newLines(previous, current) {
  const prev = splitLines(previous);
  const cur = splitLines(current);
  let i = 0;
  while (i < prev.length && i < cur.length && prev[i] === cur[i]) i += 1;
  return cur.slice(i);
}

/** Short content digest. Drives the ack token and the commit trailer. */
export function digest(content) {
  return createHash('sha256').update(content ?? '', 'utf8').digest('hex').slice(0, DIGEST_LENGTH);
}

/** Drop trailing blank lines so a section compares equal whether or not it is
 *  the last one in the file — appending below a section must not "change" it. */
function trimTrailingBlanks(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(0, end);
}

/** Split a note file into its leading header and its `## ` sections. */
export function splitSections(text) {
  const lines = splitLines(text);
  const starts = [];
  lines.forEach((line, i) => { if (/^## /.test(line)) starts.push(i); });
  if (starts.length === 0) return { header: trimTrailingBlanks(lines), sections: [] };
  const sections = starts.map((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : lines.length;
    return trimTrailingBlanks(lines.slice(start, end));
  });
  return { header: trimTrailingBlanks(lines.slice(0, starts[0])), sections };
}

const sameLines = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * Classify how `current` differs from the acknowledged snapshot:
 *
 *   first      — never acknowledged here; everything is new
 *   clean      — byte-identical
 *   archived   — only already-read sections were removed from the top; the
 *                reader has seen everything that remains, so this passes
 *   appended   — sections were added (and possibly old ones archived)
 *   rewritten  — acknowledged content was changed or removed mid-file
 */
export function classifyChange(acked, current) {
  if (acked === null || acked === undefined) {
    return { kind: 'first', added: splitLines(current) };
  }
  if (acked === current) return { kind: 'clean', added: [] };

  const a = splitSections(acked);
  const c = splitSections(current);

  if (sameLines(a.header, c.header)) {
    // Find the smallest k where the current sections begin with acked[k..]:
    // k old sections were archived off the top and every survivor still matches
    // byte for byte. The tail must be non-empty — an empty one matches anything,
    // which would let a rewritten section pass as "archived, then appended".
    for (let k = 0; k < a.sections.length; k += 1) {
      const tail = a.sections.slice(k);
      if (tail.length > c.sections.length) continue;
      const overlaps = tail.every((section, i) => sameLines(section, c.sections[i]));
      if (!overlaps) continue;
      const fresh = c.sections.slice(tail.length);
      if (fresh.length === 0) return { kind: 'archived', added: [] };
      return { kind: 'appended', added: fresh.flat(), archived: k };
    }
    // Everything acknowledged was archived away and nothing took its place.
    if (a.sections.length > 0 && c.sections.length === 0) {
      return { kind: 'archived', added: [] };
    }
  }

  const added = newLines(acked, current);
  return { kind: added.length ? 'appended' : 'rewritten', added };
}

/* -------------------------------------------------------------- trailer --- */

/** Read the `Note-Ack:` trailer out of a commit message. */
export function readTrailer(message) {
  const re = new RegExp(`^${TRAILER_KEY}:[ \\t]*([0-9a-f]+)[ \\t]*$`, 'im');
  const match = re.exec(message ?? '');
  return match ? match[1] : null;
}

export function trailerLine(value) {
  return `${TRAILER_KEY}: ${value}`;
}

/**
 * Append the trailer to a commit message body, after the last non-comment,
 * non-blank line. Idempotent: an existing trailer is replaced.
 */
export function applyTrailer(message, value) {
  const lines = (message ?? '').split('\n');
  const kept = [];
  let replaced = false;
  for (const line of lines) {
    if (new RegExp(`^${TRAILER_KEY}:`, 'i').test(line)) {
      if (!replaced) { kept.push(trailerLine(value)); replaced = true; }
      continue;
    }
    kept.push(line);
  }
  if (replaced) return kept.join('\n');

  let last = kept.length - 1;
  while (last >= 0 && (kept[last].trim() === '' || kept[last].startsWith('#'))) last -= 1;
  const body = kept.slice(0, last + 1);
  const rest = kept.slice(last + 1);
  const needsBlank = body.length > 0 && body[body.length - 1].trim() !== '';
  return [...body, ...(needsBlank ? [''] : []), trailerLine(value), ...rest].join('\n');
}

/* -------------------------------------------------------------- archive --- */

export function archiveFileName(noteName) {
  const ext = path.extname(noteName);
  const base = ext ? noteName.slice(0, -ext.length) : noteName;
  return `${base}.archive${ext || '.md'}`;
}

export function sectionDate(section) {
  const match = /^## (\d{4}-\d{2}-\d{2})\b/.exec(section[0] ?? '');
  return match ? match[1] : null;
}

/**
 * Split sections into those older than `cutoff` (YYYY-MM-DD) and those kept.
 * Sections without a parseable date are always kept — never guess.
 */
export function partitionByAge(content, cutoff) {
  const { header, sections } = splitSections(content);
  const old = [];
  const keep = [];
  for (const section of sections) {
    const date = sectionDate(section);
    if (date && date < cutoff) old.push(section);
    else keep.push(section);
  }
  return { header, old, keep };
}

export function joinNote(header, sections) {
  const parts = [header.join('\n').replace(/\s+$/, '')];
  for (const section of sections) parts.push(section.join('\n').replace(/\s+$/, ''));
  return `${parts.filter((p) => p !== '').join('\n\n')}\n`;
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

/** What each supported hook should invoke. */
export function hookCommand(hookName) {
  if (hookName === 'prepare-commit-msg') return `stamp --commit-msg "$1"`;
  return 'check';
}

export function hookBlock(hookName = 'pre-push') {
  const invocation = hookCommand(hookName);
  return [
    HOOK_MARKER_START,
    `# Managed by \`${BIN_NAME} install-hook\`. Delete this block to remove the gate.`,
    `# A local hook lives in .git/ and anyone can delete it, so it is a courtesy,`,
    `# not enforcement. \`${BIN_NAME} verify\` in CI is what actually enforces this.`,
    `${BIN_NAME}_gate() {`,
    `  root=$(git rev-parse --show-toplevel 2>/dev/null) || return 0`,
    `  if [ -n "$PAIRWARN_BIN" ]; then`,
    `    "$PAIRWARN_BIN" "$@"`,
    `  elif [ -x "$root/node_modules/.bin/${BIN_NAME}" ]; then`,
    `    "$root/node_modules/.bin/${BIN_NAME}" "$@"`,
    `  elif command -v ${BIN_NAME} >/dev/null 2>&1; then`,
    `    ${BIN_NAME} "$@"`,
    `  elif command -v npx >/dev/null 2>&1; then`,
    `    npx --yes ${BIN_NAME} "$@"`,
    `  else`,
    `    echo "${BIN_NAME}: not installed; skipping the shared-note gate" >&2`,
    `    return 0`,
    `  fi`,
    `}`,
    `${BIN_NAME}_gate ${invocation} || exit 1`,
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
    await writeFile(file, `#!/bin/sh\n# git ${hookName} hook\n\n${hookBlock(hookName)}`, 'utf8');
    await chmod(file, 0o755);
    return { action: 'created', file };
  }
  const sep = current.endsWith('\n') ? '\n' : '\n\n';
  await writeFile(file, `${current}${sep}${hookBlock(hookName)}`, 'utf8');
  await chmod(file, 0o755).catch(() => {});
  return { action: 'appended', file };
}

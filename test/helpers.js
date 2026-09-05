import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, realpath, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'bin', 'cli.js');

const made = [];

/** Run the CLI as a real subprocess. Never throws; returns {code, stdout, stderr}. */
export async function run(cwd, args, { env = {}, input } = {}) {
  const child = exec(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  // Commands that may read stdin must not block on an inherited TTY.
  if (child.child.stdin) {
    child.child.stdin.end(input ?? '');
  }
  try {
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

export async function git(cwd, args) {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

export async function tempDir(prefix = 'pairwarn-') {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** A throwaway git working copy with an identity configured. */
export async function tempRepo() {
  const dir = await tempDir();
  await git(dir, ['init', '-q', '-b', 'main', '.']);
  await git(dir, ['config', 'user.email', 'test@example.invalid']);
  await git(dir, ['config', 'user.name', 'pairwarn tests']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

export async function commitAll(dir, message = 'work') {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
}

/**
 * A shell shim the installed hook can find via $PAIRWARN_BIN, so the hook can
 * be exercised without a global install.
 */
export async function binShim(dir) {
  const file = path.join(dir, 'pairwarn-shim.sh');
  await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, 'utf8');
  await chmod(file, 0o755);
  return file;
}

/** The token `check` prints, or null when there is nothing to acknowledge. */
export async function ackToken(cwd, opts = {}) {
  const { stderr } = await run(cwd, ['check'], opts);
  const match = /ack ([0-9a-f]{12})/.exec(stderr);
  return match ? match[1] : null;
}

/** Read the note the way a person would, then acknowledge it. */
export async function readAndAck(cwd, opts = {}) {
  const token = await ackToken(cwd, opts);
  return run(cwd, token ? ['ack', token] : ['ack'], opts);
}

export async function cleanup() {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export { mkdir, writeFile, rm };

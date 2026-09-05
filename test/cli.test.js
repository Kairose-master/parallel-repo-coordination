import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { binShim, cleanup, commitAll, git, readAndAck, run, tempDir, tempRepo } from './helpers.js';

after(cleanup);

const NOTE = 'conversation.md';
const OTHER_SESSION = '## 2026-01-02 — feat/payments\n\nMigration 0042 is half-applied on staging.\n';

async function seedNote(dir, body = OTHER_SESSION, file = NOTE) {
  await writeFile(path.join(dir, file), body, 'utf8');
}

describe('check — the gate', () => {
  it('refuses the first read and prints the whole note', async () => {
    const dir = await tempRepo();
    await seedNote(dir);

    const { code, stdout, stderr } = await run(dir, ['check']);

    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /refusing/);
    assert.match(stderr, /Migration 0042 is half-applied on staging\./);
    assert.match(stderr, /pairwarn ack/);
  });

  it('passes silently once acknowledged', async () => {
    const dir = await tempRepo();
    await seedNote(dir);

    assert.equal((await readAndAck(dir)).code, 0);

    const { code, stdout, stderr } = await run(dir, ['check']);
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  });

  it('re-triggers on a change and prints only the new lines', async () => {
    const dir = await tempRepo();
    await seedNote(dir);
    await readAndAck(dir);

    await appendFile(
      path.join(dir, NOTE),
      '\n## 2026-01-03 — chore/deps\n\nBumped the lockfile; rerun install before building.\n',
      'utf8',
    );

    const { code, stderr } = await run(dir, ['check']);
    assert.equal(code, 1);
    assert.match(stderr, /Bumped the lockfile/);
    // The already-read section must not be reprinted.
    assert.doesNotMatch(stderr, /Migration 0042/);
    assert.match(stderr, /3 new lines/);
  });

  it('refuses when acknowledged content is rewritten rather than appended', async () => {
    const dir = await tempRepo();
    await seedNote(dir);
    await readAndAck(dir);
    await writeFile(path.join(dir, NOTE), '## 2026-01-02 — feat/payments\n', 'utf8');

    const { code, stderr } = await run(dir, ['check']);
    assert.equal(code, 1);
    assert.match(stderr, /changed or removed/);
  });

  it('exits 0 silently when there is no git working copy', async () => {
    const dir = await tempDir();
    await seedNote(dir);

    const { code, stdout, stderr } = await run(dir, ['check']);
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  });

  it('exits 0 when the note file is missing or empty', async () => {
    const dir = await tempRepo();
    assert.equal((await run(dir, ['check'])).code, 0);

    await seedNote(dir, '\n   \n');
    assert.equal((await run(dir, ['check'])).code, 0);
  });

  it('is per working copy: a fresh clone must read again', async () => {
    const origin = await tempRepo();
    await seedNote(origin);
    await commitAll(origin, 'add note');
    assert.equal((await readAndAck(origin)).code, 0);
    assert.equal((await run(origin, ['check'])).code, 0);

    const clones = await tempDir();
    const clone = path.join(clones, 'clone');
    await git(clones, ['clone', '-q', origin, clone]);

    const { code, stderr } = await run(clone, ['check']);
    assert.equal(code, 1, 'a fresh clone is a fresh reader');
    assert.match(stderr, /Migration 0042/);
  });

  it('never writes the acknowledgement into the working tree', async () => {
    const dir = await tempRepo();
    await seedNote(dir);
    await readAndAck(dir);

    const tracked = await git(dir, ['status', '--porcelain']);
    assert.equal(tracked, `?? ${NOTE}`);
    await stat(path.join(dir, '.git', 'pairwarn', `${NOTE}.snapshot`));
  });
});

describe('note', () => {
  it('appends a dated, branch-stamped section and acknowledges it', async () => {
    const dir = await tempRepo();

    const { code, stdout } = await run(dir, ['note', 'Do not hand-edit src/db/schema.ts.']);
    assert.equal(code, 0);
    assert.match(stdout, /appended to conversation\.md and acknowledged/);

    const content = await readFile(path.join(dir, NOTE), 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    assert.match(content, new RegExp(`^## ${today} — main$`, 'm'));
    assert.match(content, /Do not hand-edit src\/db\/schema\.ts\./);

    // Writing a note is reading it.
    assert.equal((await run(dir, ['check'])).code, 0);
  });

  it('appends below an existing note without disturbing it', async () => {
    const dir = await tempRepo();
    await seedNote(dir);
    await run(dir, ['note', 'Second entry.']);

    const content = await readFile(path.join(dir, NOTE), 'utf8');
    assert.ok(content.startsWith(OTHER_SESSION), 'existing content is preserved verbatim');
    assert.ok(content.indexOf('Migration 0042') < content.indexOf('Second entry.'));
  });

  it('accepts --note as an alias and reads stdin when given no text', async () => {
    const dir = await tempRepo();
    assert.equal((await run(dir, ['--note', 'Via the alias.'])).code, 0);
    assert.equal((await run(dir, ['note'], { input: 'Via stdin.\n' })).code, 0);

    const content = await readFile(path.join(dir, NOTE), 'utf8');
    assert.match(content, /Via the alias\./);
    assert.match(content, /Via stdin\./);
  });

  it('rejects an empty note', async () => {
    const dir = await tempRepo();
    const { code, stderr } = await run(dir, ['note', '   ']);
    assert.equal(code, 2);
    assert.match(stderr, /nothing to write/);
  });
});

describe('install-hook', () => {
  it('writes an executable pre-push hook and is idempotent', async () => {
    const dir = await tempRepo();
    const hook = path.join(dir, '.git', 'hooks', 'pre-push');

    const first = await run(dir, ['install-hook']);
    assert.equal(first.code, 0);
    assert.match(first.stdout, /wrote pre-push hook/);

    const info = await stat(hook);
    assert.ok(info.mode & 0o111, 'hook is executable');

    const second = await run(dir, ['install-hook']);
    assert.equal(second.code, 0);
    assert.match(second.stdout, /already installed/);

    const body = await readFile(hook, 'utf8');
    assert.equal(body.split('# >>> pairwarn >>>').length - 1, 1, 'block appears exactly once');
  });

  it('appends to an existing hook instead of clobbering it', async () => {
    const dir = await tempRepo();
    const hooks = path.join(dir, '.git', 'hooks');
    await mkdir(hooks, { recursive: true });
    const hook = path.join(hooks, 'pre-push');
    await writeFile(hook, '#!/bin/sh\necho "existing hook"\n', 'utf8');

    const { stdout } = await run(dir, ['install-hook']);
    assert.match(stdout, /appended the gate/);

    const body = await readFile(hook, 'utf8');
    assert.match(body, /echo "existing hook"/);
    assert.match(body, /# >>> pairwarn >>>/);

    await run(dir, ['install-hook']);
    const again = await readFile(hook, 'utf8');
    assert.equal(again.split('# >>> pairwarn >>>').length - 1, 1);
  });

  it('can install a different hook, e.g. pre-commit', async () => {
    const dir = await tempRepo();
    const { code } = await run(dir, ['install-hook', '--hook', 'pre-commit']);
    assert.equal(code, 0);
    const body = await readFile(path.join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.match(body, /pairwarn_gate check \|\| exit 1/);
  });

  it('actually refuses a real git push until the note is acknowledged', async () => {
    const scratch = await tempDir();
    const origin = path.join(scratch, 'origin.git');
    await git(scratch, ['init', '-q', '--bare', origin]);

    const work = await tempRepo();
    await git(work, ['remote', 'add', 'origin', origin]);
    await writeFile(path.join(work, 'README.md'), '# demo\n', 'utf8');
    await commitAll(work, 'initial');
    await run(work, ['install-hook']);

    // Another session's warning lands in this working copy, unread.
    await writeFile(path.join(work, NOTE), OTHER_SESSION, 'utf8');
    await commitAll(work, 'add note');

    const env = { PAIRWARN_BIN: await binShim(scratch) };
    const push = () =>
      run(work, ['--version'], { env }).then(() =>
        import('node:child_process').then(({ execFile }) =>
          new Promise((resolve) => {
            execFile(
              'git',
              ['push', '-q', 'origin', 'main'],
              { cwd: work, encoding: 'utf8', env: { ...process.env, ...env } },
              (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }),
            );
          }),
        ),
      );

    const blocked = await push();
    assert.notEqual(blocked.code, 0, 'push is refused while the note is unread');
    assert.match(blocked.stderr, /Migration 0042/);

    assert.equal((await readAndAck(work)).code, 0);

    const allowed = await push();
    assert.equal(allowed.code, 0, `push should succeed after ack: ${allowed.stderr}`);
  });
});

describe('init', () => {
  it('creates the note file, acknowledges it, and prints the wiring', async () => {
    const dir = await tempRepo();

    const { code, stdout } = await run(dir, ['init', '--no-hook']);
    assert.equal(code, 0);
    assert.match(stdout, /created conversation\.md/);
    assert.match(stdout, /"test": "pairwarn check && /);
    assert.match(stdout, /AGENTS\.md, CLAUDE\.md, CONTRIBUTING\.md/);
    assert.match(stdout, /Skipping the hooks/);

    assert.equal((await run(dir, ['check'])).code, 0, 'init acknowledges what it wrote');
  });

  it('installs the hook with --yes and leaves an existing note file alone', async () => {
    const dir = await tempRepo();
    await seedNote(dir, '# my own header\n');

    const { stdout } = await run(dir, ['init', '--yes']);
    assert.match(stdout, /already exists — left untouched/);
    assert.match(stdout, /wrote pre-push hook/);
    assert.match(stdout, /wrote prepare-commit-msg hook/);
    assert.equal(await readFile(path.join(dir, NOTE), 'utf8'), '# my own header\n');
  });
});

describe('note file selection', () => {
  it('honours NOTE_FILE and --file', async () => {
    const dir = await tempRepo();
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await seedNote(dir, OTHER_SESSION, path.join('docs', 'handoff.md'));

    assert.equal((await run(dir, ['check'])).code, 0, 'default file is absent');

    const env = { NOTE_FILE: 'docs/handoff.md' };
    assert.equal((await run(dir, ['check'], { env })).code, 1);
    assert.equal((await readAndAck(dir, { env })).code, 0);
    assert.equal((await run(dir, ['check'], { env })).code, 0);

    assert.equal((await run(dir, ['check', '--file', 'docs/handoff.md'])).code, 0);

    // Each note file gets its own acknowledgement.
    await seedNote(dir, OTHER_SESSION);
    assert.equal((await run(dir, ['check'])).code, 1);
    assert.equal((await run(dir, ['check'], { env })).code, 0);
  });
});

describe('cli surface', () => {
  it('prints help and version, and rejects nonsense', async () => {
    const dir = await tempRepo();

    const help = await run(dir, ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /usage: npx pairwarn/);

    const version = await run(dir, ['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    assert.equal((await run(dir, ['frobnicate'])).code, 2);
    assert.equal((await run(dir, ['--wat'])).code, 2);
    assert.equal((await run(dir, [])).code, 2);
  });

  it('reports clearly when ack is run outside a git working copy', async () => {
    const dir = await tempDir();
    const { code, stderr } = await run(dir, ['ack']);
    assert.equal(code, 2);
    assert.match(stderr, /not inside a git working copy/);
  });
});

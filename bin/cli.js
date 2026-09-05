#!/usr/bin/env node
/**
 * pairwarn — a refusal gate for repositories worked on by more than one
 * session at a time.
 *
 * Exit codes: 0 = clean, 1 = refused (unread notes), 2 = usage error.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BIN_NAME, DEFAULT_NOTE_FILE, TRAILER_KEY } from '../src/core.js';
import { ack, archive, check, init, installHookCommand, note, stamp, verify } from '../src/commands.js';

// A CLI gets piped into `head`, `grep -q`, and git hooks that stop reading.
// Swallow the closed pipe so writes become no-ops — but never exit here: a
// gate whose refusal is truncated must still refuse, not fail open.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (!error || error.code !== 'EPIPE') throw error;
  });
}

const HELP = `${BIN_NAME} — nobody pushes until they have read the shared note.

usage: npx ${BIN_NAME} <command> [options]

commands:
  check                 Refuse (exit 1) until the note file has been read in
                        this working copy, printing only what is new since
                        your last read plus the token that clears it. Exits 0
                        when clean, and exits 0 silently when there is no git
                        working copy at all.
  ack <token>           Record the note file as read. The token comes from
                        \`check\`, so content you were never shown cannot be
                        acknowledged blind.
  note "<text>"         Append a dated, branch-stamped section to the note
                        file and acknowledge it. Reads stdin if no text given.
  stamp                 Print the ${TRAILER_KEY} trailer for the current note,
                        or write it into a commit message with --commit-msg.
  verify                Audit commits: every commit must carry the digest of
                        the note file as it stood in that commit. This is the
                        enforceable check — run it in CI. A local hook is a
                        courtesy that --no-verify skips and anyone can delete.
  archive               Move sections older than --older-than days into a
                        sibling archive file, so the active note stays short
                        enough that people finish reading it.
  install-hook          Write or extend a git hook. Idempotent. Defaults to
                        pre-push; --hook prepare-commit-msg adds the trailer.
  init                  Create the note file, print the wiring you need, and
                        offer to install the hook.

options:
  --file <path>         Note file to use (default: ${DEFAULT_NOTE_FILE};
                        also settable with the NOTE_FILE env var).
  --hook <name>         install-hook: which hook to write (default pre-push).
  --commit-msg <file>   stamp: write the trailer into this commit message file.
  --base <ref>          verify: audit <ref>..HEAD (default HEAD~1). In CI use
                        the base branch, e.g. --base origin/main.
  --older-than <days>   archive: age cutoff in days (default 30).
  -y, --yes             init: install the hooks without asking.
  --no-hook             init: do not install any hook.
  -h, --help            Show this help.
  -v, --version         Show the version.

The acknowledgement lives in .git/ and is never committed: a fresh clone is a
fresh reader, and nobody can acknowledge on another session's behalf.
`;

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 2 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq > 2 ? arg.slice(eq + 1) : null;
    const value = () => (inline !== null ? inline : argv[++i]);

    switch (flag) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '--file': case '--note-file': opts.file = value(); break;
      case '--hook': opts.hookName = value(); break;
      case '--commit-msg': case '--commit-msg-file': opts.commitMsg = value(); break;
      case '--base': opts.base = value(); break;
      case '--older-than': case '--days': opts.days = Number(value()); break;
      case '-y': case '--yes': opts.yes = true; break;
      case '--no-hook': opts.noHook = true; break;
      default:
        if (arg.startsWith('-') && arg !== '-') { opts.unknown = arg; break; }
        opts._.push(arg);
    }
  }
  return opts;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function version() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8'));
  return pkg.version;
}

async function main(argv) {
  // `--note "..."` is accepted as an alias for the `note` subcommand.
  const noteFlag = argv.indexOf('--note');
  if (noteFlag !== -1) argv.splice(noteFlag, 1, 'note');

  const opts = parse(argv);
  if (opts.unknown) {
    process.stderr.write(`${BIN_NAME}: unknown option ${opts.unknown}\n\n${HELP}`);
    return 2;
  }
  if (opts.version) { process.stdout.write(`${await version()}\n`); return 0; }

  const command = opts._[0];
  if (opts.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return command || opts.help ? 0 : 2;
  }

  const base = { file: opts.file, cwd: process.cwd() };

  switch (command) {
    case 'check':
      return check(base);
    case 'ack':
      return ack(opts._[1], base);
    case 'note': {
      const text = opts._.slice(1).join(' ') || (await readStdin());
      return note(text, base);
    }
    case 'stamp':
      return stamp({ ...base, commitMsg: opts.commitMsg });
    case 'verify':
      return verify({ ...base, base: opts.base });
    case 'archive':
      return archive({ ...base, days: opts.days });
    case 'install-hook':
      return installHookCommand({ ...base, hook: opts.hookName || 'pre-push' });
    case 'init':
      return init({ ...base, hook: opts.yes ? true : opts.noHook ? false : undefined });
    default:
      process.stderr.write(`${BIN_NAME}: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((error) => {
    process.stderr.write(`${BIN_NAME}: ${error && error.message ? error.message : error}\n`);
    process.exitCode = 2;
  });

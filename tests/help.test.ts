import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { HELP_COMMANDS, renderHelp } from '../src/cli/help.ts';

/**
 * Help text is a contract, not a comment.
 *
 * The failure mode these tests exist for is silent drift: a new script lands in
 * package.json, `--help` never learns about it, and the command that documents the
 * pipeline starts lying by omission. Cheaper to fail here than in front of an auditor.
 */
describe('--help', () => {
  test('every runnable command in package.json is documented', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const internal = new Set(['test', 'typecheck']);
    const scripts = Object.keys(pkg.scripts).filter((s) => !internal.has(s));

    for (const script of scripts) {
      assert.ok(HELP_COMMANDS.includes(script), `pnpm ${script} has no --help entry`);
    }
  });

  test('each entry states how it is invoked and where the docs are', () => {
    for (const command of HELP_COMMANDS) {
      const text = renderHelp(command);
      assert.match(text, new RegExp(`pnpm ${command.replace(':', ':')}`), `${command} omits its usage line`);
      assert.match(text, /docs\/decisions/, `${command} omits the pointer to the ADRs`);
    }
  });

  test('--help is not an error: it prints and says nothing about failing', () => {
    const text = renderHelp('start');
    assert.match(text, /Tres etapas/, 'the pipeline map belongs on the entry command');
    assert.doesNotMatch(text, /usage:/, 'the usage: prefix is for the error path, not for --help');
  });

  test('an unknown command does not throw', () => {
    assert.match(renderHelp('nope'), /sin ayuda/);
  });
});

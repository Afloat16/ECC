'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { buildSessionSnapshot, listTmuxPanes } = require('../../scripts/lib/orchestration-session');
const { normalizeDmuxSnapshot } = require('../../scripts/lib/session-adapters/canonical-session');

const binary = process.env.ECC_TEST_TMUX_BINARY || 'tmux';
const probe = spawnSync(binary, ['-V'], { encoding: 'utf8', timeout: 10000 });
if (probe.error?.code === 'ENOENT') {
  console.log('SKIP native tmux window tests: tmux is not installed');
  process.exit(0);
}
assert.ifError(probe.error);
assert.strictEqual(probe.status, 0, probe.stderr);
console.log(`Native integration: ${probe.stdout.trim()}`);

let passed = 0;
let failed = 0;

function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-tmux-'));
  const socket = path.join(root, 'server.sock');
  const env = { ...process.env, TMUX: '', TERM: 'xterm-256color' };
  const command = args => execFileSync(binary, ['-S', socket, '-f', '/dev/null', ...args], {
    env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  const options = {
    spawnSyncImpl(_command, args, spawnOptions) {
      return spawnSync(binary, ['-S', socket, ...args], { ...spawnOptions, env, timeout: 10000 });
    }
  };
  const newSession = (session, label) => {
    const pane = command(['new-session', '-d', '-s', session, '-n', 'first', '-P', '-F', '#{pane_id}', 'sleep 120']);
    command(['select-pane', '-t', pane, '-T', label]);
    return pane;
  };
  const newWindow = (session, window, label) => {
    const pane = command(['new-window', '-d', '-t', session, '-n', window, '-P', '-F', '#{pane_id}', 'sleep 120']);
    command(['select-pane', '-t', pane, '-T', label]);
    return pane;
  };
  try {
    fn({ root, command, options, newSession, newWindow });
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.stack}`);
    failed++;
  } finally {
    spawnSync(binary, ['-S', socket, 'kill-server'], { env, stdio: 'ignore', timeout: 5000 });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function paneIds(panes) {
  return panes.map(pane => pane.paneId).sort();
}

test('collects worker panes in every window while a separate console is selected', context => {
  const alpha = context.newSession('workers', 'alpha');
  const beta = context.newWindow('workers', 'second', 'beta');
  const consolePane = context.newWindow('workers', 'console', 'console');
  context.command(['select-window', '-t', 'workers:console']);
  assert.deepStrictEqual(paneIds(listTmuxPanes('workers', context.options)), [alpha, beta, consolePane].sort());
});

test('switching selected windows does not change the observed session inventory', context => {
  const alpha = context.newSession('workers', 'alpha');
  const beta = context.newWindow('workers', 'second', 'beta');
  context.command(['select-window', '-t', 'workers:first']);
  const first = paneIds(listTmuxPanes('workers', context.options));
  context.command(['select-window', '-t', 'workers:second']);
  const second = paneIds(listTmuxPanes('workers', context.options));
  assert.deepStrictEqual(first, [alpha, beta].sort());
  assert.deepStrictEqual(second, first);
});

test('excludes windows belonging to a different tmux session', context => {
  const alpha = context.newSession('workers', 'alpha');
  const beta = context.newWindow('workers', 'second', 'beta');
  context.newSession('unrelated', 'foreign');
  assert.deepStrictEqual(paneIds(listTmuxPanes('workers', context.options)), [alpha, beta].sort());
});

test('real coordination files retain both worker runtimes across windows', context => {
  context.newSession('workers', 'alpha');
  context.newWindow('workers', 'second', 'beta');
  const coordinationDir = path.join(context.root, 'coordination');
  for (const name of ['alpha', 'beta']) {
    const directory = path.join(coordinationDir, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'status.md'), `- State: running\n- Updated: ${new Date().toISOString()}\n`);
    fs.writeFileSync(path.join(directory, 'task.md'), `## Objective\nComplete ${name}\n`);
    fs.writeFileSync(path.join(directory, 'handoff.md'), '## Summary\n- Work in progress\n');
  }
  const observed = buildSessionSnapshot({
    sessionName: 'workers', coordinationDir, panes: listTmuxPanes('workers', context.options)
  });
  assert.strictEqual(observed.paneCount, 2);
  assert.ok(observed.workers.every(worker => worker.pane !== null));
  const canonical = normalizeDmuxSnapshot(observed, { type: 'tmux-session', value: 'workers' });
  assert.ok(canonical.workers.every(worker => worker.runtime.pid > 0 && worker.health === 'healthy'));
});

test('single-window split panes retain their existing fields', context => {
  const alpha = context.newSession('workers', 'alpha');
  const beta = context.command(['split-window', '-d', '-t', 'workers', '-P', '-F', '#{pane_id}', 'sleep 120']);
  context.command(['select-pane', '-t', beta, '-T', 'beta']);
  const panes = listTmuxPanes('workers', context.options);
  assert.deepStrictEqual(paneIds(panes), [alpha, beta].sort());
  assert.deepStrictEqual(panes.map(pane => pane.title).sort(), ['alpha', 'beta']);
  assert.ok(panes.every(pane => pane.windowIndex === 0 && pane.pid > 0 && !pane.dead));
});

test('a missing target session still returns an empty inventory', context => {
  context.newSession('workers', 'alpha');
  assert.deepStrictEqual(listTmuxPanes('missing', context.options), []);
});

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;

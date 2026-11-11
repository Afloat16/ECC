'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../../.pi/extensions/index.ts');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-pi-rules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rulesDir = path.join(root, 'rules', 'common');
  const hookDir = path.join(root, 'scripts', 'hooks');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'run-with-flags.js'),
    'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{}"));');

  let reads = 0;
  const measuredFs = {
    ...fs,
    readFileSync(file, ...args) {
      if (typeof file === 'string' && path.dirname(file) === rulesDir) reads++;
      return fs.readFileSync(file, ...args);
    }
  };
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: false,
      inlineSourceMap: true, inlineSources: true, sourceRoot: path.dirname(sourcePath)
    }
  });
  const adapterModule = { exports: {} };
  const sourceRequire = Module.createRequire(sourcePath);
  const localRequire = name => name === 'node:fs' ? measuredFs : sourceRequire(name);
  const wrapper = vm.runInThisContext(Module.wrap(compiled.outputText), { filename: sourcePath });
  wrapper(adapterModule.exports, localRequire, adapterModule, sourcePath, path.join(root, '.pi', 'extensions'));

  const isolatedEnv = {
    HOME: root, USERPROFILE: root, ECC_AGENT_DATA_HOME: path.join(root, '.claude'),
    CLAUDE_CONFIG_DIR: path.join(root, '.claude'), PI_CODING_AGENT_DIR: path.join(root, '.pi', 'agent'),
    ECC_PI_RULES: '1', ECC_HOOK_NODE: process.execPath
  };
  const savedEnv = Object.fromEntries(Object.keys(isolatedEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, isolatedEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  return {
    root,
    get reads() { return reads; },
    writeRule: text => fs.writeFileSync(path.join(rulesDir, 'coding-style.md'), text),
    writeHook: text => fs.writeFileSync(path.join(hookDir, 'run-with-flags.js'), text),
    createSession(id) {
      const handlers = new Map();
      const commands = new Map();
      const messages = [];
      const notifications = [];
      adapterModule.exports.default({
        on: (name, handler) => handlers.set(name, handler),
        registerCommand: (name, command) => commands.set(name, command),
        sendMessage: message => messages.push(message)
      });
      const context = {
        cwd: root, ui: { notify: message => notifications.push(message) },
        sessionManager: { getSessionId: () => id, getSessionFile: () => undefined }
      };
      return {
        notifications, messages,
        start: reason => handlers.get('session_start')({ reason }, context),
        shutdown: reason => handlers.get('session_shutdown')({ reason }, context),
        prompt: () => handlers.get('before_agent_start')({ systemPrompt: 'Base prompt' }, context),
        doctor: () => commands.get('ecc-doctor').handler('', context)
      };
    }
  };
}

test('cached extension factories read changed rules for each new session', async t => {
  const fixture = createFixture(t);
  fixture.writeRule('Original policy');
  const first = fixture.createSession('first');
  await first.start('startup');
  assert.match(first.prompt().systemPrompt, /Original policy/);
  const readsAfterFirstTurn = fixture.reads;
  fixture.writeRule('Updated policy');
  assert.match(first.prompt().systemPrompt, /Original policy/);
  assert.equal(fixture.reads, readsAfterFirstTurn, 'Repeated turns should keep the session cache');
  await first.shutdown('new');
  const second = fixture.createSession('second');
  await second.start('new');
  assert.match(second.prompt().systemPrompt, /Updated policy/);
  assert.ok(fixture.reads > readsAfterFirstTurn, 'A new session must read its own rule snapshot');
  const readsAfterSecondTurn = fixture.reads;
  second.prompt();
  assert.equal(fixture.reads, readsAfterSecondTurn);
  assert.deepEqual([...first.notifications, ...second.notifications], []);
});

test('a missing-rule result does not hide a repaired install in the next session', async t => {
  const fixture = createFixture(t);
  const first = fixture.createSession('missing');
  await first.start('startup');
  assert.equal(first.prompt(), undefined);
  await first.doctor();
  assert.match(first.messages[0].content, /Engineering rules.*\n {2}NOT FOUND/s);
  fixture.writeRule('Restored policy');
  const second = fixture.createSession('repaired');
  await second.start('resume');
  assert.match(second.prompt()?.systemPrompt || '', /Restored policy/);
  await second.doctor();
  assert.match(second.messages[0].content, /1\/7 rule file\(s\)/);
});

test('session-start refreshes the cache when a host reuses its handlers', async t => {
  const fixture = createFixture(t);
  fixture.writeRule('Before fork');
  const session = fixture.createSession('reused');
  await session.start('startup');
  assert.match(session.prompt().systemPrompt, /Before fork/);
  fixture.writeRule('After fork');
  await session.start('fork');
  assert.match(session.prompt().systemPrompt, /After fork/);
});

test('a disabled-rule result is refreshed when rules are enabled for the next session', async t => {
  const fixture = createFixture(t);
  fixture.writeRule('Enabled policy');
  process.env.ECC_PI_RULES = 'off';
  const first = fixture.createSession('disabled');
  await first.start('startup');
  assert.equal(first.prompt(), undefined);
  assert.equal(fixture.reads, 0);
  await first.doctor();
  assert.match(first.messages[0].content, /disabled via ECC_PI_RULES/);
  process.env.ECC_PI_RULES = '1';
  const second = fixture.createSession('enabled');
  await second.start('new');
  assert.match(second.prompt()?.systemPrompt || '', /Enabled policy/);
});

test('a size-capped rule can be repaired before the next session', async t => {
  const fixture = createFixture(t);
  fixture.writeRule('x'.repeat(33 * 1024));
  const first = fixture.createSession('oversized');
  await first.start('startup');
  assert.equal(first.prompt(), undefined);
  fixture.writeRule('Repaired policy');
  const second = fixture.createSession('smaller');
  await second.start('new');
  assert.match(second.prompt()?.systemPrompt || '', /Repaired policy/);
});

test('hook failures do not prevent the next session from refreshing rules', async t => {
  const failures = {
    'missing runner': fixture => fs.unlinkSync(path.join(fixture.root, 'scripts/hooks/run-with-flags.js')),
    'invalid runtime': () => { process.env.ECC_HOOK_NODE = 'relative-node'; },
    'nonzero exit': fixture => fixture.writeHook(
      'process.stdin.resume(); process.stdin.on("end", () => process.exit(1));'),
    'spawn failure': fixture => { process.env.ECC_HOOK_NODE = path.join(fixture.root, 'missing-node'); }
  };
  for (const [name, breakHook] of Object.entries(failures)) {
    await t.test(name, async child => {
      const fixture = createFixture(child);
      fixture.writeRule('Before hook failure');
      const first = fixture.createSession('working');
      await first.start('startup');
      assert.match(first.prompt().systemPrompt, /Before hook failure/);
      fixture.writeRule('After hook failure');
      breakHook(fixture);
      const second = fixture.createSession('degraded');
      await second.start('new');
      assert.match(second.notifications[0], /session-start hook skipped/);
      assert.match(second.prompt().systemPrompt, /After hook failure/);
      const readCount = fixture.reads;
      second.prompt();
      assert.equal(fixture.reads, readCount);
      await second.shutdown('quit');
      assert.match(second.notifications[1], /session-end hook skipped/);
    });
  }
});

test('fresh rules persist after the one-shot session context is consumed', async t => {
  const fixture = createFixture(t);
  fixture.writeRule('Before handoff');
  const first = fixture.createSession('before-handoff');
  await first.start('startup');
  first.prompt();
  fixture.writeRule('Current handoff policy');
  const stdout = JSON.stringify({ hookSpecificOutput: { additionalContext: 'Resume the pending task' } });
  fixture.writeHook(`process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(stdout)}));`);
  const second = fixture.createSession('with-handoff');
  await second.start('resume');
  const initialPrompt = second.prompt().systemPrompt;
  assert.match(initialPrompt, /Current handoff policy/);
  assert.match(initialPrompt, /<ecc-session-context>\nResume the pending task/);
  const readCount = fixture.reads;
  const laterPrompt = second.prompt().systemPrompt;
  assert.match(laterPrompt, /Current handoff policy/);
  assert.doesNotMatch(laterPrompt, /ecc-session-context/);
  assert.equal(fixture.reads, readCount);
});

test('ignored hook output does not interfere with the refreshed rule snapshot', async t => {
  const outputs = ['profile disabled', '{invalid json',
    JSON.stringify({ hookSpecificOutput: { additionalContext: 42 } }),
    JSON.stringify({ hookSpecificOutput: { additionalContext: '  ' } })];
  for (const stdout of outputs) {
    await t.test(stdout, async child => {
      const fixture = createFixture(child);
      fixture.writeRule('Previous snapshot');
      const first = fixture.createSession('old-snapshot');
      await first.start('startup');
      first.prompt();
      fixture.writeRule('New snapshot');
      fixture.writeHook(`process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(stdout)}));`);
      const second = fixture.createSession('new-snapshot');
      await second.start('new');
      const prompt = second.prompt().systemPrompt;
      assert.match(prompt, /New snapshot/);
      assert.doesNotMatch(prompt, /ecc-session-context/);
      assert.deepEqual(second.notifications, []);
    });
  }
});

test('doctor refreshes the included rule count after an install changes', async t => {
  const fixture = createFixture(t);
  const write = (relative, text) => {
    const file = path.join(fixture.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const name of ['coding-style', 'testing', 'security', 'git-workflow', 'patterns',
    'development-workflow', 'code-review']) {
    write(`rules/common/${name}.md`, `${name} policy`);
  }
  write('package.json', JSON.stringify({ version: '1.2.3' }));
  write('skills/example/SKILL.md', '# Example');
  write('commands/example.md', '# Example');
  write('agents/example.md', '# Example');
  write('scripts/agent-convert.js', 'console.log("OK: 1 agents parsed and validated");');
  write('.pi/agent/settings.json', JSON.stringify({ packages: [
    null, 42, { source: 'npm:@tintinweb/pi-subagents@1.0.0' },
    'npm:@juicesharp/rpiv-ask-user-question', 'git:example/repo'
  ] }));
  write('.pi/settings.json', JSON.stringify({ packages: ['npm:@juicesharp/rpiv-todo@2.0.0'] }));

  const first = fixture.createSession('complete-install');
  await first.start('startup');
  await first.doctor();
  const initial = first.messages[0].content;
  assert.match(initial, /7\/7 rule file\(s\)/);
  assert.doesNotMatch(initial, /unreadable, empty, or past the size cap/);
  assert.match(initial, /1 agent\(s\) source schema validated/);
  assert.match(initial, /1 skill\(s\)/);
  assert.match(initial, /1 command\(s\)/);
  assert.match(initial, /ECC version:\s+1\.2\.3/);
  assert.match(initial, /satisfied by: @tintinweb\/pi-subagents/);
  assert.doesNotMatch(initial, /^ {2}not installed/m);

  write('rules/common/security.md', '  ');
  const second = fixture.createSession('partial-install');
  await second.start('new');
  await second.doctor();
  const updated = second.messages[0].content;
  assert.match(updated, /6\/7 rule file\(s\)/);
  assert.match(updated, /1 unreadable, empty, or past the size cap/);
  assert.doesNotMatch(second.prompt().systemPrompt, /security policy/);
  const readCount = fixture.reads;
  await second.doctor();
  assert.equal(fixture.reads, readCount, 'Doctor should reuse the current session snapshot');
});

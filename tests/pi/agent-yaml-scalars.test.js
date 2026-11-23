'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const yaml = require('js-yaml');
const { parseAgentFile } = require('../../scripts/lib/agent-ir');
const { emitPiAgent, yamlScalar } = require('../../scripts/lib/agent-emit-pi');

const root = path.resolve(__dirname, '../..');
const body = 'Keep the complete prompt.\n\n```text\nname: false\n```';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-pi-scalars-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quoted(value) {
  // Explicit source escapes keep line separators inside the YAML string.
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function source(name, description) {
  return `---\nname: ${quoted(name)}\ndescription: ${quoted(description)}\ntools: Read\nmodel: sonnet\n---\n\n${body}\n`;
}

function parseEmitted(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  assert.ok(match, 'frontmatter boundaries must remain intact');
  return { frontmatter: yaml.load(match[1]), body: match[2] };
}

function checkStrings(values) {
  for (const value of values) {
    const { markdown } = emitPiAgent({
      id: 'scalar-fixture', name: value, description: value,
      tools: ['Read'], body,
    });
    const parsed = parseEmitted(markdown);
    assert.equal(parsed.frontmatter.name, value, `name: ${JSON.stringify(value)}`);
    assert.equal(parsed.frontmatter.description, value, `description: ${JSON.stringify(value)}`);
    assert.equal(parsed.body, `${body}\n`);
    assert.equal(yamlScalar(value).includes('\n'), false, 'each field must stay on one physical line');
    assert.equal(parsed.frontmatter.tools, 'read');
    assert.equal(parsed.frontmatter.isolated, true);
    assert.equal(parsed.frontmatter.extensions, false);
    assert.equal(parsed.frontmatter.skills, false);
  }
}

test('boolean, null and empty agent fields remain strings', () => {
  checkStrings(['true', 'false', 'True', 'FALSE', 'null', 'Null', '~', '']);
});

test('numeric-looking agent fields retain their exact spelling and type', () => {
  checkStrings(['0', '42', '012', '0x10', '0b11', '1e3', '.inf', '.NaN', '-1', '+2']);
});

test('YAML punctuation and control characters cannot alter the emitted mapping', () => {
  checkStrings(['key:\tvalue', 'line\rbreak', 'a\0b', 'a\x01b', 'tabs\tinside',
    ':', '%directive', '# comment', 'plain # comment', '[item]', '{key: value}',
    '---', '...', "single'quote", 'double"quote', 'two\nlines\n', ' surrounding ']);
});

test('Unicode separators and text survive quoted and plain scalar contexts', () => {
  checkStrings(['নিরাপদ পরীক্ষা', '中文 description', 'a\u0085b', 'a\u2028b', 'a\u2029b',
    'a\uFEFFb', 'a\uFFFEb', 'a\uFFFFb', 'quoted: a\u0085b', 'quoted: a\u2028b']);
});

test('accepted Claude frontmatter keeps the declared Pi identity and description', t => {
  const dir = temporary(t);
  for (const [name, description] of [['false', '1e3'], ['42', 'Review:\tall changes'], ['null', 'first\rsecond']]) {
    const file = path.join(dir, 'filename-fallback.md');
    fs.writeFileSync(file, source(name, description));
    const ir = parseAgentFile(file);
    assert.equal(ir.name, name);
    assert.equal(ir.description, description);
    const parsed = parseEmitted(emitPiAgent(ir).markdown);
    assert.equal(parsed.frontmatter.name, name);
    assert.equal(parsed.frontmatter.description, description);
  }
});

test('the real converter writes and repeats valid custom-agent files after --check', t => {
  const dir = temporary(t);
  const files = ['scripts/agent-convert.js', 'scripts/lib/agent-ir.js',
    'scripts/lib/agent-emit-pi.js', 'scripts/lib/agent-tool-map.js', 'schemas/agent.schema.json'];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.mkdirSync(path.join(dir, 'agents'));
  const agents = [['identity', 'false', '1e3'], ['description', 'reviewer', 'Review:\tall changes'],
    ['line-break', 'line-reviewer', 'first\rsecond']];
  for (const [id, name, description] of agents) fs.writeFileSync(path.join(dir, 'agents', `${id}.md`), source(name, description));
  const env = { ...process.env, NODE_PATH: path.join(root, 'node_modules') };
  const cli = path.join(dir, 'scripts/agent-convert.js');
  const run = args => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'],
    { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }));
  assert.equal(run(['--check']).checked, agents.length);
  const out = path.join(dir, 'out');
  assert.equal(run(['--out', out]).converted, agents.length);
  const before = agents.map(([id]) => fs.readFileSync(path.join(out, `${id}.md`), 'utf8'));
  for (let index = 0; index < agents.length; index++) {
    const [, name, description] = agents[index];
    const parsed = parseEmitted(before[index]);
    assert.equal(parsed.frontmatter.name, name);
    assert.equal(parsed.frontmatter.description, description);
    assert.equal(parsed.body, `${body}\n`);
  }
  assert.equal(run(['--out', out]).converted, agents.length);
  assert.deepEqual(agents.map(([id]) => fs.readFileSync(path.join(out, `${id}.md`), 'utf8')), before);
});

test('ordinary single-line fields preserve their existing plain representation', () => {
  for (const value of ['planner', 'code-reviewer', 'Explain the implementation.', 'নিরাপদ পরীক্ষা']) {
    assert.equal(yamlScalar(value), value);
  }
});

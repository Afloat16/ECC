'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { detectProjectType } = require('../../scripts/lib/project-detect');

test('scans directory entries once while detecting all source extensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-project-scan-'));
  const originalRead = fs.readdirSync;
  let reads = 0;
  try {
    for (const name of ['main.py', 'main.ts', 'main.js', 'main.go', 'main.rs']) {
      fs.writeFileSync(path.join(dir, name), '');
    }
    fs.mkdirSync(path.join(dir, 'directory.java'));
    fs.readdirSync = function (target, ...args) {
      if (target === dir) reads += 1;
      return originalRead.call(this, target, ...args);
    };
    assert.deepEqual(detectProjectType(dir).languages, ['python', 'typescript', 'golang', 'rust']);
    assert.equal(reads, 1, 'one filesystem listing should serve every language rule');
  } finally {
    fs.readdirSync = originalRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshes the directory snapshot for each detection request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-project-refresh-'));
  try {
    assert.deepEqual(detectProjectType(dir).languages, []);
    fs.writeFileSync(path.join(dir, 'main.go'), '');
    assert.deepEqual(detectProjectType(dir).languages, ['golang']);
    fs.rmSync(path.join(dir, 'main.go'));
    assert.deepEqual(detectProjectType(dir).languages, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retains marker detection when a directory listing is unavailable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-project-unreadable-'));
  const originalRead = fs.readdirSync;
  try {
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app');
    fs.readdirSync = function (target, ...args) {
      if (target === dir) throw Object.assign(new Error('not readable'), { code: 'EACCES' });
      return originalRead.call(this, target, ...args);
    };
    assert.deepEqual(detectProjectType(dir).languages, ['golang']);
  } finally {
    fs.readdirSync = originalRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

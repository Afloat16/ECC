'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { detectProjectType, getPythonDeps } = require('../../scripts/lib/project-detect');

function withPyproject(contents, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-python-deps-'));
  try {
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), contents);
    check(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('extras brackets do not truncate the dependency array', () => {
  withPyproject('[project]\ndependencies = ["requests[socks]>=2", "fastapi>=0.115", "flask~=3.0"]', dir => {
    assert.deepEqual(getPythonDeps(dir), ['requests', 'fastapi', 'flask']);
    assert.deepEqual(detectProjectType(dir).frameworks, ['fastapi', 'flask']);
  });
});

test('reads TOML literal strings, escapes, and comments structurally', () => {
  withPyproject('[project]\ndependencies = [\n  \'fastapi>=0.115\', # "django" is only a comment\n  "fl\\u0061sk>=3",\n]', dir => {
    assert.deepEqual(getPythonDeps(dir), ['fastapi', 'flask']);
  });
});

test('selects project dependencies instead of similarly named tool settings', () => {
  withPyproject('[tool.example]\ndependencies = ["django"]\n[project]\ndependencies = ["fastapi"]', dir => {
    assert.deepEqual(getPythonDeps(dir), ['fastapi']);
    assert.deepEqual(detectProjectType(dir).frameworks, ['fastapi']);
  });
});

test('supports dotted TOML project dependency keys', () => {
  withPyproject('project.dependencies = [\'flask\']', dir => {
    assert.deepEqual(getPythonDeps(dir), ['flask']);
  });
});

test('does not fall back to regex claims for malformed TOML', () => {
  withPyproject('[project]\ndependencies = ["fastapi"]\nbroken =', dir => {
    assert.deepEqual(getPythonDeps(dir), []);
  });
});

test('ignores non-array or non-string project dependency values', () => {
  for (const value of ['42', '[42, true]', '{ fastapi = "*" }']) {
    withPyproject(`[project]\ndependencies = ${value}`, dir => {
      assert.deepEqual(getPythonDeps(dir), []);
    });
  }
});

test('retains requirements.txt dependencies when project TOML is unusable', () => {
  withPyproject('[project]\ndependencies =', dir => {
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask>=3');
    assert.deepEqual(getPythonDeps(dir), ['flask']);
  });
});

test('clone installations without the optional parser keep their legacy fallback', () => {
  const originalLoad = Module._load;
  try {
    Module._load = function (name, ...args) {
      if (name === '@iarna/toml') {
        throw Object.assign(new Error("Cannot find module '@iarna/toml'"), { code: 'MODULE_NOT_FOUND' });
      }
      return originalLoad.call(this, name, ...args);
    };
    withPyproject('[project]\ndependencies = ["fastapi>=0.115"]', dir => {
      assert.deepEqual(getPythonDeps(dir), ['fastapi']);
      assert.equal(detectProjectType(dir).primary, 'fastapi');
    });
  } finally {
    Module._load = originalLoad;
  }
});

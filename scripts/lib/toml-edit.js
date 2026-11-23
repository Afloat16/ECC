'use strict';

const TOML = require('@iarna/toml');
const { isDeepStrictEqual } = require('util');

function endOfString(raw, start) {
  const quote = raw[start];
  const multiline = raw.slice(start, start + 3) === quote.repeat(3);
  for (let index = start + (multiline ? 3 : 1); index < raw.length; index += 1) {
    if (quote === '"' && raw[index] === '\\') {
      index += 1;
    } else if (raw[index] === quote
      && (!multiline || raw.slice(index, index + 3) === quote.repeat(3))) {
      if (multiline) {
        while (raw[index + 1] === quote) index += 1;
      }
      return index;
    }
  }
  throw new Error('Cannot locate the end of a TOML string');
}

// Frame statements in already-validated TOML. Newlines inside strings, arrays,
// or inline tables do not end a statement; comments cannot open strings/tables.
function* statementRanges(raw) {
  let start = 0;
  let depth = 0;
  let assignment = -1;
  let inlineTableEnd = -1;

  for (let index = 0; index < raw.length; index += 1) {
    let char = raw[index];
    if (char === '#') {
      const newline = raw.indexOf('\n', index);
      if (newline === -1) break;
      index = newline;
      char = '\n';
    } else if (char === '"' || char === "'") {
      index = endOfString(raw, index);
    } else if (char === '[' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      if (char === '}' && depth === 0 && assignment !== -1) inlineTableEnd = index;
    } else if (char === '=' && depth === 0 && assignment === -1) {
      assignment = index;
    }

    if (char === '\n' && depth === 0) {
      yield { start, end: index + 1, assignment, inlineTableEnd };
      start = index + 1;
      assignment = -1;
      inlineTableEnd = -1;
    }
  }

  if (start < raw.length) yield { start, end: raw.length, assignment, inlineTableEnd };
}

// Let the TOML parser decode quoted, escaped, and dotted keys. A standalone
// header produces a single chain of table keys.
function parsePath(source) {
  let current = TOML.parse(source);
  const parts = [];
  while (current && typeof current === 'object') {
    if (Array.isArray(current)) {
      current = current[0];
      continue;
    }
    const keys = Object.keys(current);
    if (keys.length === 0) break;
    parts.push(keys[0]);
    current = current[keys[0]];
  }
  return parts;
}

/** Return source ranges with semantic paths, without reformatting any bytes. */
function findTomlStatements(raw) {
  let tablePath = [];
  return Array.from(statementRanges(raw), range => {
    const text = raw.slice(range.start, range.end).trimStart();
    if (text.startsWith('[')) {
      tablePath = parsePath(text);
      return { ...range, kind: text.startsWith('[[') ? 'array-table' : 'table', path: tablePath };
    }
    if (range.assignment !== -1) {
      const key = raw.slice(range.start, range.assignment);
      return { ...range, kind: 'assignment', path: [...tablePath, ...parsePath(`[${key}]`)] };
    }
    return { ...range, kind: 'trivia', path: [] };
  });
}

function preservesExistingValues(before, after) {
  if (before && Object.getPrototypeOf(before) === Object.prototype) {
    return after !== null && typeof after === 'object' && !Array.isArray(after)
      && Object.keys(before).every(key => Object.prototype.hasOwnProperty.call(after, key)
        && preservesExistingValues(before[key], after[key]));
  }
  return isDeepStrictEqual(before, after);
}

module.exports = { findTomlStatements, preservesExistingValues };

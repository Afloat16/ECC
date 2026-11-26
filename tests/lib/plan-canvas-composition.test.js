'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const { canvasClientJs } = require('../../scripts/lib/plan-canvas/ui');
const { artifactSdkJs } = require('../../scripts/lib/plan-canvas/sdk');

// Execute the complete browser scripts with event-capable DOM nodes. Only the
// browser boundary is replaced; the installed handlers and send logic are real.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.selectors = new Map();
    this.value = '';
    this.textContent = '';
    this.scrollHeight = this.scrollTop = this.clientHeight = 0;
    this.classList = { add() {}, toggle() {} };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }

  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name); }
  focus() { this.focused = true; }
  attachShadow() { this.shadowRoot = new Element(); return this.shadowRoot; }

  querySelector(selector) {
    if (!this.selectors.has(selector)) {
      this.selectors.set(selector, new Element(selector === 'textarea' ? 'textarea' : 'div'));
    }
    return this.selectors.get(selector);
  }
}

function environment() {
  const document = new Element();
  document.body = new Element('body');
  document.documentElement = new Element('html');
  const ids = new Map();
  document.createElement = tag => new Element(tag);
  document.getElementById = id => {
    if (!ids.has(id)) ids.set(id, new Element());
    return ids.get(id);
  };
  const window = new Element();
  window.innerWidth = 1000;
  window.scrollX = window.scrollY = 0;
  window.getSelection = () => ({ isCollapsed: true });
  const storage = { getItem: () => null, setItem() {} };
  return { document, window, sessionStorage: storage, localStorage: storage,
    EventSource: Element, setTimeout, clearTimeout };
}

function press(document, target, options = {}) {
  const event = { key: 'Enter', isComposing: false, keyCode: 13,
    shiftKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...options };
  // Both clients use a capturing document listener before the textarea handler.
  document.dispatch('keydown', event);
  target.dispatch('keydown', event);
  return event;
}

function chatClient() {
  const context = environment();
  const requests = [];
  context.document.getElementById('pc-session').textContent = JSON.stringify({ key: 'review', chat: [] });
  context.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({}) };
  };
  runInNewContext(canvasClientJs(), context);
  return { ...context, requests, input: context.document.getElementById('chatInput') };
}

function annotationClient() {
  const context = environment();
  const messages = [];
  context.window.parent = { postMessage: message => messages.push(message) };
  runInNewContext(artifactSdkJs(), context);
  const host = context.document.body.children[0];
  const card = host.shadowRoot.querySelector('.card');
  const input = card.querySelector('textarea');
  const target = new Element('p');
  target.id = 'proposal';
  target.textContent = 'Review this paragraph';
  context.document.body.appendChild(target);
  context.document.dispatch('click', { target, clientX: 40, clientY: 40,
    composedPath: () => [target], preventDefault() {}, stopPropagation() {} });
  assert.equal(card.style.display, 'block');
  return { ...context, card, input, messages,
    queued: () => messages.filter(msg => msg.type.startsWith('pc:queue')) };
}

const composedEvents = [
  ['active composition', { isComposing: true }],
  ['legacy composition key code', { keyCode: 229 }]
];

for (const [name, options] of composedEvents) {
  test(`chat preserves the draft during ${name}`, async () => {
    const client = chatClient();
    client.input.value = '请保留这个修改';
    const event = press(client.document, client.input, options);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.requests.length, 0);
    assert.equal(event.defaultPrevented, false);
    assert.equal(client.input.value, '请保留这个修改');

    press(client.document, client.input);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0].url, '/api/session/review/feedback');
    assert.equal(client.requests[0].body.items[0].text, '请保留这个修改');
    assert.equal(client.input.value, '');
  });

  for (const ctrlKey of [false, true]) {
    test(`annotation does not ${ctrlKey ? 'send' : 'queue'} during ${name}`, () => {
      const client = annotationClient();
      client.input.value = '日本語の注釈';
      const event = press(client.document, client.input, { ...options, ctrlKey });
      assert.equal(client.queued().length, 0);
      assert.equal(event.defaultPrevented, false);
      assert.equal(client.card.style.display, 'block');

      press(client.document, client.input, { ctrlKey });
      assert.equal(client.queued().length, 1);
      assert.equal(client.queued()[0].type, ctrlKey ? 'pc:queue-and-send' : 'pc:queue');
      assert.equal(client.queued()[0].item.text, '日本語の注釈');
      assert.equal(client.queued()[0].item.anchor.selector, '#proposal');
      assert.equal(client.card.style.display, 'none');
    });
  }

  test(`composition Escape keeps the annotation card open during ${name}`, () => {
    const client = annotationClient();
    client.input.value = '한글 주석';
    press(client.document, client.input, { ...options, key: 'Escape' });
    assert.equal(client.card.style.display, 'block');
    assert.equal(client.input.value, '한글 주석');
    press(client.document, client.input, { key: 'Escape', keyCode: 27 });
    assert.equal(client.card.style.display, 'none');
  });

  test(`mode shortcuts leave ${name} to the input method`, () => {
    const chat = chatClient();
    const annotation = annotationClient();
    const shortcut = { key: 'i', keyCode: 73, ctrlKey: true };
    press(chat.document, chat.input, { ...shortcut, ...options });
    press(annotation.document, annotation.input, { ...shortcut, ...options });
    assert.equal(chat.document.getElementById('annotate').getAttribute('aria-pressed'), undefined);
    assert.equal(annotation.messages.some(msg => msg.type === 'pc:toggle-mode'), false);
    press(chat.document, chat.input, shortcut);
    press(annotation.document, annotation.input, shortcut);
    assert.equal(chat.document.getElementById('annotate').getAttribute('aria-pressed'), 'false');
    assert.equal(annotation.messages.some(msg => msg.type === 'pc:toggle-mode'), true);
  });
}

test('Shift+Enter remains a newline in both feedback editors', () => {
  const chat = chatClient();
  chat.input.value = 'More detail';
  assert.equal(press(chat.document, chat.input, { shiftKey: true }).defaultPrevented, false);
  assert.equal(chat.requests.length, 0);
  const annotation = annotationClient();
  annotation.input.value = 'More context';
  assert.equal(press(annotation.document, annotation.input, { shiftKey: true }).defaultPrevented, false);
  assert.equal(annotation.queued().length, 0);
  assert.equal(annotation.card.style.display, 'block');
});

test('Cmd+Enter still sends a completed annotation', () => {
  const client = annotationClient();
  client.input.value = 'Ready';
  assert.equal(press(client.document, client.input, { metaKey: true }).defaultPrevented, true);
  assert.equal(client.queued()[0].type, 'pc:queue-and-send');
});

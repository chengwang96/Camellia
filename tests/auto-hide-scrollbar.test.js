'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'src/renderer/shared/auto-hide-scrollbar.js'), 'utf8');
const delay = 30;
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

function load() {
  const document = { readyState: 'complete', querySelectorAll: () => [] };
  const window = {};
  vm.runInNewContext(source, { window, document, setTimeout, clearTimeout });
  return window.CamelliaAutoHideScrollbar;
}

function scrollList() {
  const classes = new Set();
  const listeners = new Map();
  return {
    classes,
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    removeEventListener(type, callback) {
      const registered = listeners.get(type) || [];
      const index = registered.indexOf(callback);
      if (index >= 0) registered.splice(index, 1);
    },
    listenerCount: type => (listeners.get(type) || []).length,
    getBoundingClientRect: () => ({ right: 260 }),
    dispatch(type, event = {}) {
      for (const callback of listeners.get(type) || []) callback(event);
    },
  };
}

test('the sidebar starts with its scrollbar thumb out of the way', () => {
  const element = scrollList();
  load().attach(element, { delay });
  assert.equal(element.classes.has('is-scroll-idle'), true);
});

test('scrolling shows the thumb and idling hides it again', async () => {
  const element = scrollList();
  load().attach(element, { delay });
  element.dispatch('scroll');
  assert.equal(element.classes.has('is-scroll-idle'), false);
  await settle(delay * 2);
  assert.equal(element.classes.has('is-scroll-idle'), true);
});

test('reaching for the scroll gutter keeps the thumb visible until the pointer leaves it', async () => {
  const element = scrollList();
  load().attach(element, { delay });
  element.dispatch('pointermove', { clientX: 250 });
  assert.equal(element.classes.has('is-scroll-idle'), false);
  await settle(delay * 2);
  assert.equal(element.classes.has('is-scroll-idle'), false);
  element.dispatch('pointermove', { clientX: 120 });
  await settle(delay * 2);
  assert.equal(element.classes.has('is-scroll-idle'), true);
});

test('leaving the list hides a visible thumb after the idle delay', async () => {
  const element = scrollList();
  load().attach(element, { delay });
  element.dispatch('scroll');
  element.dispatch('pointermove', { clientX: 250 });
  element.dispatch('pointerleave');
  await settle(delay * 2);
  assert.equal(element.classes.has('is-scroll-idle'), true);
});

test('destroy restores the always-on thumb and drops every listener', () => {
  const element = scrollList();
  const control = load().attach(element, { delay });
  control.destroy();
  assert.equal(element.classes.has('is-scroll-idle'), false);
  for (const type of ['scroll', 'pointermove', 'pointerleave']) assert.equal(element.listenerCount(type), 0);
});

test('the stylesheet hides the idle thumb but keeps the drag hover visible', () => {
  const css = fs.readFileSync(path.join(repo, 'src/renderer/chat/workbench.css'), 'utf8');
  assert.match(css, /\.session-list\.is-scroll-idle::-webkit-scrollbar-thumb\s*\{\s*background:\s*transparent;?\s*\}/);
  assert.match(css, /\.session-list\.is-scroll-idle::-webkit-scrollbar-thumb:hover\s*\{\s*background:\s*var\(--dsw-alias-label-caption\);?\s*\}/);
});

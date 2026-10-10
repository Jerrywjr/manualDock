import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBind, loginURL } from '../extension/bind-check.js';

// Pure pre-flight binding checks (panel.checkBind runs these before any
// chrome.scripting call). These are the rejection branches the review brief §3
// asks for: foreign origin, login page, invalid/out-of-scope rule.
const PROFILE = { origin: 'https://manual.example.com', entry: 'https://manual.example.com/', pathPrefix: '/docs', queryKeys: [], tocSelector: '', contentSelector: '' };

test('a foreign-origin tab is rejected before any page-side check', () => {
  const r = classifyBind(PROFILE, 'https://evil.example.org/docs/ch1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /manual\.example\.com/);
});

test('a login page is rejected', () => {
  assert.equal(loginURL('https://manual.example.com/login'), true);
  const r = classifyBind(PROFILE, 'https://manual.example.com/login?next=/docs');
  assert.equal(r.ok, false);
  assert.match(r.reason, /登录页/);
});

test('a same-origin URL outside the path prefix is rejected (invalid rule / scope)', () => {
  const r = classifyBind(PROFILE, 'https://manual.example.com/elsewhere/ch1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /手册范围/);
});

test('a URL carrying a non-whitelisted query parameter is rejected', () => {
  const r = classifyBind(PROFILE, 'https://manual.example.com/docs/ch1?token=ABC123');
  assert.equal(r.ok, false);
});

test('an allowed query parameter is accepted', () => {
  const p = { ...PROFILE, queryKeys: ['p'] };
  const r = classifyBind(p, 'https://manual.example.com/docs/ch1?p=42');
  assert.equal(r.ok, true);
});

test('a valid in-scope, non-login page passes the pre-flight', () => {
  const r = classifyBind(PROFILE, 'https://manual.example.com/docs/ch1');
  assert.equal(r.ok, true);
});

test('a missing profile or unreadable URL is rejected', () => {
  assert.equal(classifyBind(null, 'https://manual.example.com/docs/ch1').ok, false);
  assert.equal(classifyBind(PROFILE, '').ok, false);
  assert.equal(classifyBind(PROFILE, 'not a url').ok, false);
});

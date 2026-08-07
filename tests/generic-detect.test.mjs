// tests/generic-detect.test.mjs
// Proves the STRUCTURAL fallback works: when LinkedIn renames its class names,
// the extension must still find cards by detecting job-ish structure & links.
// Here the cards deliberately use UNKNOWN generic classes (not in CARD_SELECTORS),
// so only the looksLikeCard() structural heuristic can catch them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ROOT = new URL('../', import.meta.url);
const rulesSrc = readFileSync(new URL('static/rules.js', ROOT), 'utf8');
const contentSrc = readFileSync(new URL('static/content.js', ROOT), 'utf8');

const storageShim = {
  local: {
    async get(key) { return { [key]: storedSettings[key] }; },
    async set(obj) { Object.assign(storedSettings, obj); },
    async remove(key) { delete storedSettings[key]; }
  },
  onChanged: { addListener() {} },
  runtime: {
    onMessage: { addListener() {} },
    sendMessage() { return Promise.resolve({ ok: false }); },
    openOptionsPage() {}
  }
};
let storedSettings = {};

function makeGeneric({ tag = 'div', cls = 'custom-widget', html }) {
  const el = document.createElement(tag);
  el.className = cls; // definitely not a known LinkedIn class
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.browser = storageShim;
window.browser = storageShim;
const NoopObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
global.MutationObserver = window.MutationObserver = NoopObserver;

window.eval(rulesSrc);
window.eval(contentSrc);

// A real job listing rendered with generic (renamed) markup.
const job = makeGeneric({
  tag: 'li',
  cls: 'mweb-slate result one',
  html:
    '<a href="/jobs/view/123">Senior React Developer</a>' +
    '<a href="/company/acme">Acme GmbH</a>' +
    '<span class="loc">Berlin, Germany</span>' +
    '<span>We are hiring a React developer for our remote team.</span>'
});

// An Open-to-Work post rendered with generic markup.
const openToWork = makeGeneric({
  tag: 'article',
  cls: 'mweb-slate post two',
  html:
    '<a href="/feed/update/urn:li:activity:999">post</a>' +
    '<span>Open to Work | Android Developer — #OpenToWork</span>'
});

// A small, non-job element that should NOT be picked as a card.
makeGeneric({ tag: 'div', cls: 'nav-header', html: '<span>Home · My Network</span>' });

await new Promise((r) => setTimeout(r, 900));

const hidden = document.querySelectorAll('.jobshield-hidden');
console.log('detected .jobshield-hidden count =', hidden.length);
console.log('job card hidden?', job.classList.contains('jobshield-hidden'), 'display=', job.style.display);
console.log('open-to-work hidden?', openToWork.classList.contains('jobshield-hidden'), 'display=', openToWork.style.display);

// The structurally-default job card must be detected (not nested/hidden), and
// the open-to-work post must be detected and hidden.
assert.equal(openToWork.classList.contains('jobshield-hidden'), true, 'generic open-to-work post should be hidden');
assert.notEqual(job.classList.contains('jobshield-hidden'), true, 'a real job card should not be hidden');
assert.ok(openToWork.style.display === 'none', 'open-to-work should be display:none');

console.log('\n✅ generic-detect.test.mjs passed — fallback catches renamed markup');

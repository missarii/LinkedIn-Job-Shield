// tests/filter.test.mjs
// Functional test: loads content.js (with rules.js) inside jsdom, injects
// sample LinkedIn-like job cards, and asserts the filter hides/recommends
// the right ones. AI is disabled so only the rule engine is exercised.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ROOT = new URL('../', import.meta.url);
const rulesSrc = readFileSync(new URL('static/rules.js', ROOT), 'utf8');
const contentSrc = readFileSync(new URL('static/content.js', ROOT), 'utf8');

// --- Build a tiny in-memory storage mirror ----------------------
let storedSettings = {}; // keep defaults -> content.js merges with rules.js defaults
const storageShim = {
  local: {
    async get(key) {
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (k in storedSettings) out[k] = storedSettings[k];
        return out;
      }
      return { [key]: storedSettings[key] };
    },
    async set(obj) { Object.assign(storedSettings, obj); },
    async remove(key) { delete storedSettings[key]; }
  },
  onChanged: { addListener() {} },
  runtime: {
    onMessage: {
      addListener() {}, // content's bindMsg registers a listener; harmless
      // NOTE: api.onMessage.addListener is the registration side; fine.
    },
    sendMessage() { return Promise.resolve({ ok: false }); }, // AI off -> ignored
    openOptionsPage() {}
  }
};

function makeCard({ company, title, location, description, text, isFeed }) {
  const li = document.createElement('li');
  li.className = 'jobs-search-results__list-item';
  if (isFeed) li.classList.add('feed-shared-update-v2');
  const inner = document.createElement('div');
  inner.innerHTML = [
    company ? `<div class="job-card-container__primary-description">${company}</div>` : '',
    title ? `<a class="job-card-container__link">${title}</a>` : '',
    location ? `<div class="job-card-container__metadata-wrapper">${location}</div>` : '',
    description ? `<div class="feed-shared-inline-show-more-text">${description}</div>` : ''
  ].join('');
  li.appendChild(inner);
  // Provide the visible "text" via textContent so innerText fallback works.
  if (text) { inner.insertAdjacentHTML('beforeend', `<div class="post-text">${text}</div>`); }
  document.body.appendChild(li);
  return li;
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

// Make MutationObserver a no-op so content.js's observer never re-fires on the
// test mutations we inject afterwards (prevents unbounded timer churn).
const NoopObserver = class {
  observe() {} disconnect() {} takeRecords() { return []; }
};
global.MutationObserver = NoopObserver;
window.MutationObserver = NoopObserver;

// Run the extension scripts inside the jsdom window.
window.eval(rulesSrc);
window.eval(contentSrc);

// --- Build sample cards -----------------------------------------
makeCard({ company: 'Acme GmbH', title: 'Senior React Developer (Remote)', location: 'Berlin, Germany' }); // whitelist -> recommend
const blocked = makeCard({ company: 'XYZ Recruitment', title: 'Apply Now', location: 'Remote' });   // blocked company -> hide
const fake = makeCard({
  company: 'Some Startup',
  title: 'Hiring!',
  description: '',
  text: 'We are hiring! Follow our company page and comment Interested to apply.',
  isFeed: false
}); // high score -> hide
const normal = makeCard({ company: 'Delta Corp', title: 'Remote Accountant', location: 'London, UK' });      // show (matches "remote" whitelist)
const opentowork = makeCard({
  company: 'Dhruta Gabani',
  title: 'Open to Work | Android Developer',
  location: '',
  text: 'Hi everyone! I’m currently looking for Android Developer opportunities. #OpenToWork',
  isFeed: false
}); // open-to-work -> hide
const mismatch = makeCard({ company: 'Foo Ltd', title: 'Sales Manager', location: 'Chicago, US' }); // no whitelist term -> hidden (required)
// Your two examples: on-site engineering jobs with NO "remote" — must be hidden.
const layup = makeCard({ company: 'Layup Parts', title: 'Software Engineer, Controls & Automation', location: 'Huntington Beach, CA (On-site)' });
const sok = makeCard({ company: 'SOK', title: 'Software Engineer, S-ID', location: 'Helsinki Metropolitan Area' });

// Wait for the debounced initial scan (content.js init runs async + 250ms debounce).
await new Promise((r) => setTimeout(r, 900));

const cls = (el) => Array.from(el.classList);
console.log('blocked  display=%s hidden=%j', blocked.style.display, cls(blocked).includes('jobshield-hidden'));
console.log('fake     display=%s hidden=%j', fake.style.display, cls(fake).includes('jobshield-hidden'));
console.log('normal   display=%s hidden=%j', normal.style.display, cls(normal).includes('jobshield-hidden'));
console.log('acme     display=%s recommended=%j', document.querySelectorAll('.job-card-container__primary-description')[0].closest('li').style.display, cls(document.querySelectorAll('li')[0]).includes('jobshield-recommended'));

console.log('opentowork display=%s hidden=%j', opentowork.style.display, cls(opentowork).includes('jobshield-hidden'));
console.log('mismatch  display=%s hidden=%j', mismatch.style.display, cls(mismatch).includes('jobshield-hidden'));
console.log('layup(SWE, on-site) hidden=%j', cls(layup).includes('jobshield-hidden'));
console.log('sok(SWE, on-site)   hidden=%j', cls(sok).includes('jobshield-hidden'));

// collect cards in DOM order
const cards = Array.from(document.querySelectorAll('li.jobs-search-results__list-item'));
const acme = cards[0];

assert.equal(blocked.style.display, 'none', 'blocked company should be hidden');
assert.equal(fake.style.display, 'none', 'fake post should be hidden by score');
assert.equal(opentowork.style.display, 'none', 'open-to-work post should be hidden');
assert.equal(mismatch.style.display, 'none', 'non-matching (no whitelist term) post should be hidden in required mode');
assert.equal(layup.style.display, 'none', 'on-site SWE job with no "remote" should be hidden');
assert.equal(sok.style.display, 'none', 'on-site SWE job with no "remote" should be hidden');
assert.equal(normal.style.display, '', 'normal job matching whitelist should stay visible');
assert.equal(document.querySelectorAll('.jobshield-hidden').length, 6, 'exactly six hidden');
assert.ok(acme.classList.contains('jobshield-recommended'), 'whitelisted React job should be recommended');
assert.notEqual(acme.style.display, 'none', 'recommended job stays visible');

console.log('\n✅ filter.test.mjs passed');

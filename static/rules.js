/*
 * rules.js
 * ---------
 * Default rules & scoring for LinkedIn Job Shield.
 *
 * This file is intentionally dependency-free and is loaded in TWO contexts:
 *   1. The content-script isolated world (declared in manifest content_scripts,
 *      before content.js, so it runs first and exposes window.JobShieldDefaults).
 *   2. The options page (as a plain <script> tag) so the UI can show defaults.
 *
 * Users normally override these values through the options page. The values
 * below are simply sane starting points that get deep-merged with stored
 * settings (stored settings win).
 */
'use strict';

var JobShieldDefaults = {
  // Master switch for the whole extension.
  enable: true,

  // Hide LinkedIn "Open to Work" / #OpenToWork job-seeker self-promotion posts.
  hideOpenToWork: true,

  // ----- 1. Blocked companies -------------------------------
  // Any post whose company name contains one of these is hidden immediately.
  blockedCompanies: [
    'XYZ Recruitment',
    'ABC Staffing',
    'Ultimate Staffing',
    'Creative Circle',
    'Talent Finderz',
    'HireMeNow Group',
    'Scam Recruiters Inc.'
  ],

  // ----- 2. Blocked keywords / text patterns -----------------
  // Any post whose visible text (or company name) contains one of these
  // contributes to the "suspicion score".
  blockedKeywords: [
    'follow our page',
    'follow our company',
    'follow us on linkedin',
    'like and share',
    'comment interested',
    'type interested',
    'dm me',
    'pm me',
    'direct message me',
    'urgent hiring',
    'urgently hiring',
    'mass hiring',
    'bulk hiring',
    'recruitment drive',
    'training + job',
    'training and job',
    'guaranteed job',
    'guaranteed selection',
    'make money online',
    'earn from home',
    'instant cash',
    'no experience needed',
    'work from home quickly'
  ],

  // ----- 3. Whitelist / required criteria ----------------------
  // When whitelistRequired is ON, a post MUST contain at least one of these
  // terms to be shown; everything else is hidden as "doesn't match criteria".
  // NOTE: keep this list to ONLY what you truly require. The aim here is to
  // require "remote", so the default list is remote-focused. Any generic role
  // word (e.g. "software engineer", "developer") would let on-site jobs through.
  whitelistRequired: true,
  whitelistKeywords: [
    'remote',
    'remote-first',
    'remote friendly',
    'fully remote',
    '100% remote',
    'work from home',
    'remote job'
  ],

  // ----- 4. Suspicion score threshold ------------------------
  // A post is hidden when its accumulated score is >= this value.
  scoreThreshold: 40,

  // ----- 5. Scoring weights ----------------------------------
  scoring: {
    // Feed-type post with no real job description text.
    noDescription: 20,
    // Asks you to follow the company page.
    asksFollow: 15,
    // Asks you to comment "Interested" (classic fake-hiring bait).
    commentInterested: 10,
    // Job card has no location.
    noLocation: 10,
    // Company name looks like a recruitment / staffing agency.
    recruitmentAgency: 20,
    // Asks you to DM / PM them.
    dmMe: 10,
    // "mass hiring", "urgent hiring", "recruitment drive" ...
    massHiring: 10,
    // "guaranteed job", "no experience needed", "make money" ...
    noExperienceGuarantee: 15,
    // Baseline points added for each blocked keyword that matched.
    perKeyword: 5
  },

  // ----- 6. On-device AI classifier --------------------------
  // When enabled, text is sent to the background worker which runs a free
  // Hugging Face zero-shot classification model locally (Transformers.js).
  // Model weights + ONNX runtime are downloaded on first use and cached.
  aiEnabled: false,
  aiModel: 'Xenova/distilbert-base-multilingual-cased-nli-stsb',
  // Minimum confidence (0..1) required before the AI may hide a post.
  aiConfidence: 0.6,
  // Also hide posts the AI labels as recruitment-agency ads.
  aiBlockAgencies: true,

  // Highlight recommended posts with a star badge and green border.
  highlightRecommended: true,

  // Some internal notes shown in the options UI (not part of filtering).
  _modelOptions: [
    { value: 'Xenova/nli-deberta-v3-xsmall', label: 'nli-deberta-v3-xsmall (English, fast & small)' },
    { value: 'Xenova/distilbert-base-multilingual-cased-nli-stsb', label: 'distilbert multilingual NLI (50+ languages)' }
  ]
};

// Attach to the global so content.js (and the options page) can read it.
if (typeof window !== 'undefined') {
  window.JobShieldDefaults = JobShieldDefaults;
}
// Also support CommonJS (used by Node tooling if ever imported).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = JobShieldDefaults;
}

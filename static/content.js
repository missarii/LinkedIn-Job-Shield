/*
 * content.js
 * ----------
 * Runs on every linkedin.com page in an isolated world.
 *
 * Responsibilities:
 *   - Find job cards, feed posts and "job listing" elements on the page.
 *   - Extract company name, title, location and visible text from each card.
 *   - Apply the rule-based filter (blocked companies, blocked keywords,
 *     suspicion scoring, whitelist highlighting).
 *   - Optionally ask the background worker to run the on-device AI classifier
 *     on a card's text and combine the result with the rule verdict.
 *   - Hide / highlight cards, and show a small floating control panel (HUD).
 *   - Re-scan as the user scrolls (LinkedIn loads cards lazily via a SPA).
 */
(function () {
  'use strict';
  if (window.__jobShieldInjected) return;
  window.__jobShieldInjected = true;

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function cloneSettings(obj) {
    return JSON.parse(JSON.stringify(obj || {}));
  }

  // Deep-merge user settings over defaults (user wins).
  function mergeSettings(defaults, user) {
    const out = cloneSettings(defaults);
    if (!user || typeof user !== 'object') return out;
    for (const k of Object.keys(user)) {
      if (user[k] && typeof user[k] === 'object' && !Array.isArray(user[k]) && out[k]) {
        out[k] = mergeSettings(out[k], user[k]);
      } else {
        out[k] = user[k];
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let settings = cloneSettings(window.JobShieldDefaults || {});
  const state = {
    showHidden: false, // when true, hidden cards are shown with a reason chip
    aiDone: new WeakSet(), // cards already sent to the AI worker
    allCards: [] // cards detected on the last scan
  };

  // ------------------------------------------------------------------
  // DOM selectors (LinkedIn markup changes often; keep several fallbacks).
  // ------------------------------------------------------------------
  const CARD_SELECTORS = [
    'li.jobs-search-results__list-item',
    'li[data-occludable-job-id]',
    '.job-card-container',
    '.job-card-list',
    '.job-card-list__entity',
    '.scaffold-layout__list-container > li',
    '.scaffold-layout__list-container > div',
    '.jobs-search__results-list > li',
    '.jobs-search-results__list > li',
    '[data-test-jobs-search-results-list] > li',
    '[data-test-jobs-search-results-list] .job-card-container',
    'article.feed-shared-update-v2',
    '.feed-shared-update-v2',
    '.feed-shared-mini-update-v2',
    '.entity-result',
    '.search-entity-result',
    '.reusable-search__result-container',
    'li[data-results-list-builder-result-card]',
    '.search-result__occluded-item',
    'div[data-entity-result]',
    'li[data-entity-result]',
    '.job-card-square__list',
    'li[data-recirculation-id]',
    'section[data-view-name="job-search-result"]'
  ];

  // Cheap check: does this element look like a job / feed card?
  function looksLikeCard(el) {
    const raw = el.className;
    const cls = String(raw && raw.baseVal !== undefined ? raw.baseVal : raw || '');
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'html' || tag === 'body' || tag === 'ul' || tag === 'ol' ||
        tag === 'main' || tag === 'nav' || tag === 'header' || tag === 'form' ||
        tag === 'script' || tag === 'style') {
      return false;
    }
    const c = ' ' + cls.toLowerCase() + ' ';
    if (/\b(job-card|job-card-container|feed-shared-update|entity-result|search-result|result-card|update-v2|job-listing)\b/.test(c)) {
      return true;
    }
    // A real clickable link to a job posting / company / feed update is strong evidence.
    if (el.querySelector('a[href*="/jobs/view"], a[href*="/jobs/applylex/"], a[data-control-name="job_card"], a[href*="jobPosting"]')) {
      return true;
    }
    if (el.querySelector('a[href*="/feed/update/"], a[data-control-name="feed_main"]')) {
      return true;
    }
    // Structural heuristic: counts signals inside the element.
    let signals = 0;
    if (el.querySelector('a[href*="/company/"]')) signals++;
    if (el.querySelector('a[href*="/jobs"]')) signals++;
    if (el.querySelector('time')) signals++;
    const text = norm(el.textContent || '');
    if (/open to work|#opentowork|hiring|we are hiring|looking for/i.test(text)) signals++;
    if (/developer|engineer|intern|remote|salary|apply|location|experience/i.test(text)) signals++;
    return signals >= 2;
  }

  // Keep only outermost matching elements (drop ones nested inside another match).
  function dedupNested(list) {
    const arr = Array.from(list);
    const out = [];
    for (const el of arr) {
      let nested = false;
      for (const other of arr) {
        if (other !== el && other.contains(el)) { nested = true; break; }
      }
      if (!nested) out.push(el);
    }
    return out;
  }

  function getCards() {
    // Strategy 1: specific known selectors.
    const specific = dedupNested($$(CARD_SELECTORS.join(',')));

    // Strategy 2: structural fallback used when the specific pass finds nothing
    // (LinkedIn frequently renames its classes).
    if (specific.length === 0) {
      const candidates = dedupNested(
        $$('li, article, div, section').filter((el) => looksLikeCard(el))
      );
      return candidates;
    }

    // If specific found something, also keep extra candidates that clearly look
    // like cards but weren't matched (covers layouts we haven't seen).
    const extra = dedupNested(
      $$('li[data-occludable-job-id], article.feed-shared-update-v2, [class*="job-card"], [class*="feed-shared-update"], [class*="entity-result"]')
    );
    const merged = new Set(specific);
    extra.forEach((el) => merged.add(el));
    return dedupNested(merged);
  }

  function qText(el, selectors) {
    for (const s of selectors) {
      try {
        const n = el.querySelector(s);
        if (n && norm(n.textContent)) return norm(n.textContent);
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  function extractCardInfo(el) {
    const isFeed = (el.classList && el.classList.contains('feed-shared-update-v2')) || false;
    const company =
      qText(el, [
        '.job-card-container__primary-description',
        '.artdeco-entity-lockup__subtitle',
        '.job-card-container__company-name',
        '.job-card-list__company-name',
        '.entity-result__company-name',
        '.update-components-actor__company-name',
        '.update-components-actor__meta-link'
      ]);
    const title =
      qText(el, [
        '.job-card-container__link',
        '.job-card-container__title',
        '.job-card-list__title',
        '.entity-result__title-text',
        '.update-components-actor__title'
      ]);
    const location =
      qText(el, [
        '.job-card-container__metadata-wrapper',
        '.job-card-container__metadata-item',
        '.job-card-container__workplace-types',
        '.entity-result__locations-list',
        '[class*="metadata"]'
      ]);
    const description =
      qText(el, [
        '.feed-shared-inline-show-more-text',
        '.feed-shared-text span',
        '.update-components-text',
        '.job-description',
        '.show-more-less-html__markup'
      ]);

    const text = norm(el.innerText || el.textContent || '');
    return { el, isFeed, company, title, location, description, text };
  }

  // ------------------------------------------------------------------
  // Rule engine
  // ------------------------------------------------------------------
  function evaluateRules(info, s) {
    const reasons = [];
    let score = 0;

    const company = (info.company || '').toLowerCase();
    const text = (info.text || '').toLowerCase();
    const full = (company + ' ' + text);

    // 0) Hide "Open to Work" / job-seeker self-promotion posts.
    if (s.hideOpenToWork && /open to work|#opentowork|open for work|opentowork/i.test(full)) {
      return { action: 'hide', score: 999, reasons: ['"Open to Work" post'] };
    }

    // 1) Blocked company -> immediate hide.
    for (const comp of s.blockedCompanies || []) {
      if (comp && company.includes(String(comp).toLowerCase())) {
        return { action: 'hide', score: 999, reasons: ['Blocked company: ' + (info.company || comp)] };
      }
    }

    // 2) Blocked keywords -> accumulate suspicion score.
    const perKeyword = (s.scoring && s.scoring.perKeyword) || 5;
    const matchedKeywords = [];
    for (const kw of s.blockedKeywords || []) {
      if (kw && full.includes(String(kw).toLowerCase())) {
        matchedKeywords.push(kw);
        score += perKeyword;
      }
    }

    // 3) Specific promotional / fake-hiring patterns.
    const sc = s.scoring || {};
    if (/follow (our|the|my|this|linkedin|company|page)/.test(text)) {
      score += sc.asksFollow || 0;
      reasons.push('Asks to follow company page');
    }
    if (/comment.{0,14}(interested|below|yes|done)/.test(text) || text.includes('comment interested')) {
      score += sc.commentInterested || 0;
      reasons.push('Asks to comment "Interested"');
    }
    if (/\b(dm|pm|direct message|message) (me|us)\b/.test(text)) {
      score += sc.dmMe || 0;
      reasons.push('Asks to DM / PM');
    }
    if (/(mass|bulk|urgent(ly)?|instant) (hiring|recruit|hire)|recruitment drive/.test(text)) {
      score += sc.massHiring || 0;
      reasons.push('Mass / urgent hiring language');
    }
    if (/(guaranteed (job|interview|selection))|(no experience (needed|required))|(make money|cash)/.test(text)) {
      score += sc.noExperienceGuarantee || 0;
      reasons.push('"Guaranteed" / no-experience pitch');
    }
    if (/(recruit|staffing|talent (solution|acquisition)|manpower|placement agency|headhunt)/.test(company)) {
      score += sc.recruitmentAgency || 0;
      reasons.push('Recruitment / staffing agency');
    }
    if (!info.isFeed) {
      // Job cards should always show a location.
      if (!info.location) {
        score += sc.noLocation || 0;
        reasons.push('No location');
      }
    } else {
      // Feed-style posts should have a real description.
      if (!info.description && info.text.length < 80) {
        score += sc.noDescription || 0;
        reasons.push('No real job description');
      }
    }

    for (const kw of matchedKeywords) reasons.push('Matched keyword: "' + kw + '"');

    // 4) Whitelist -> relevance. Determine which whitelist terms matched.
    let whitelist = [];
    for (const kw of s.whitelistKeywords || []) {
      if (kw && full.includes(String(kw).toLowerCase())) whitelist.push(kw);
    }

    if (score >= (s.scoreThreshold || 40)) {
      return { action: 'hide', score, reasons };
    }

    // REQUIRED mode: a post MUST match at least one whitelist term to be shown.
    // (Only enforced when the user has actually filled in whitelist terms.)
    if (s.whitelistRequired && (s.whitelistKeywords || []).length > 0 && whitelist.length === 0) {
      return {
        action: 'hide',
        score,
        reasons: reasons.concat(["Doesn't match required criteria (whitelist)"])
      };
    }

    if (whitelist.length) {
      return { action: 'recommend', score, reasons, whitelist };
    }
    return { action: 'show', score, reasons };
  }

  // ------------------------------------------------------------------
  // UI application
  // ------------------------------------------------------------------
  function clearCardUI(el) {
    el.classList.remove('jobshield-hidden', 'jobshield-recommended', 'jobshield-ai');
    el.style.display = '';
    const chip = $('.jobshield-chip', el);
    if (chip) chip.remove();
    const rec = $('.jobshield-recommend-badge', el);
    if (rec) rec.remove();
  }

  function setChip(el, text, kind) {
    let chip = $('.jobshield-chip', el);
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'jobshield-chip';
      if (el.style.position !== 'absolute' && el.style.position !== 'fixed') {
        el.style.position = el.style.position || 'relative';
      }
      el.prepend(chip);
    }
    chip.textContent = text;
    chip.className = 'jobshield-chip ' + (kind || 'hidden');
  }

  function setRecommendBadge(el) {
    if ($('.jobshield-recommend-badge', el)) return;
    const b = document.createElement('div');
    b.className = 'jobshield-recommend-badge';
    b.textContent = '⭐ Recommended';
    b.title = 'Matched your whitelist / AI says it is a real job';
    el.style.position = el.style.position || 'relative';
    el.prepend(b);
  }

  function applyCard(info, action, reasons, aiInfo) {
    const el = info.el;
    clearCardUI(el);

    let hide = false;
    let reasonsText = reasons || [];

    if (action === 'hide') {
      hide = true;
    } else if (aiInfo) {
      const conf = settings.aiConfidence || 0.6;
      if (aiInfo.action === 'hide' && aiInfo.score >= conf) {
        hide = true;
        reasonsText = reasonsText.concat(['AI: ' + String(aiInfo.label).replace(/^a(n)?\s+/, '') + ' (' + Math.round(aiInfo.score * 100) + '%)']);
      } else if (aiInfo.action === 'agency' && settings.aiBlockAgencies && aiInfo.score >= conf) {
        hide = true;
        reasonsText = reasonsText.concat(['AI: recruitment agency ad (' + Math.round(aiInfo.score * 100) + '%)']);
      }
    }

    if (hide) {
      el.classList.add('jobshield-hidden');
      el.__jobShieldReasons = reasonsText;
      if (state.showHidden) {
        el.style.display = '';
        setChip(el, '🚫 Hidden — ' + (reasonsText.join('; ') || 'matched a rule'), 'hidden');
      } else {
        el.style.display = 'none';
      }
      return 'hide';
    }

    // Not hidden.
    if ((action === 'recommend' || (aiInfo && aiInfo.action === 'real')) && settings.highlightRecommended) {
      el.classList.add('jobshield-recommended');
      setRecommendBadge(el);
      return 'recommend';
    }
    return 'show';
  }

  // ------------------------------------------------------------------
  // AI integration
  // ------------------------------------------------------------------
  async function runAI(info) {
    const el = info.el;
    if (state.aiDone.has(el)) return null;
    state.aiDone.add(el);
    const model = settings.aiModel;
    const text = [info.title, info.company, info.text].filter(Boolean).join(' \u00b7 ');
    try {
      const res = await browser.runtime.sendMessage({ type: 'ai-classify', text, model });
      if (!res || !res.ok) return null;
      // Re-apply this card with the AI verdict taken into account.
      const action = evaluateRules(info, settings).action;
      applyCard(info, action === 'hide' ? 'hide' : 'show', [], res);
      el.classList.add('jobshield-ai');
      updateHud();
      return res.action;
    } catch (err) {
      // Extension context may be invalidated during a reload; ignore.
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Scan / process
  // ------------------------------------------------------------------
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanNow();
    }, 250);
  }

  function scanNow() {
    if (!settings.enable) return;
    const cards = getCards();
    state.allCards = cards;
    for (const el of cards) {
      if (el.__jobShieldProcessed) continue;
      el.__jobShieldProcessed = true;
      const info = extractCardInfo(el);
      const verdict = evaluateRules(info, settings);

      if (verdict.action !== 'hide' && settings.aiEnabled) {
        // Don't block; run AI in the background and re-apply when it returns.
        runAI(info);
        applyCard(info, verdict.action, verdict.reasons);
      } else {
        applyCard(info, verdict.action, verdict.reasons);
      }
    }
    updateHud();
  }

  function updateHud() {
    const hidden = $$('.jobshield-hidden').length;
    const recommended = $$('.jobshield-recommended').length;
    const detected = state.allCards.length;
    // "shown" = detected cards that are not hidden.
    let shown = 0;
    for (const el of state.allCards) {
      if (!el.classList.contains('jobshield-hidden')) shown++;
    }
    const hud = $('#jobshield-hud');
    if (hud) {
      const dt = hud.querySelector('.js-hud-detected');
      if (dt) {
        dt.textContent = 'Detected ' + detected + ' card(s) on this page';
        dt.style.color = detected === 0 ? '#ffd9a0' : '#fff';
      }
      const st = hud.querySelector('.js-hud-stats');
      if (st) st.textContent = 'Hidden ' + hidden + ' · Shown ' + shown + ' · ⭐ ' + recommended;
      const eye = hud.querySelector('.js-hud-eye');
      if (eye) eye.textContent = state.showHidden ? 'Hide hidden' : 'Peek hidden';
      const tip = hud.querySelector('.js-hud-tip');
      if (tip) {
        tip.textContent = detected === 0
          ? 'No cards found on this page. If you are on LinkedIn, click Inspect.'
          : '';
        tip.style.display = detected === 0 ? '' : 'none';
      }
    }
  }

  // Debug / inspect tool: outlines detected cards and prints their structure so
  // a layout change can be diagnosed.
  function runDebug() {
    const cards = getCards();
    state.allCards = cards;
    const details = [];
    const shown = [];
    for (const el of cards.slice(0, 5)) {
      el.style.outline = '3px dashed #0a66c2';
      el.style.outlineOffset = '2px';
      shown.push(el);
      const info = extractCardInfo(el);
      let html = '';
      try {
        html = String(el.outerHTML || '').slice(0, 600);
      } catch (e) { html = ''; }
      details.push({
        tag: el.tagName,
        cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || ''),
        title: info.title,
        company: info.company,
        location: info.location,
        textLen: (info.text || '').length,
        html
      });
    }
    try {
      console.log('[JobShield] detected cards:', cards.length, details);
    } catch (e) { /* ignore */ }
    if (cards.length === 0) {
      showDebugModal(
        'Nothing detected',
        'No job cards were found on this page. This usually means you are not on a ' +
        'LinkedIn job-search or feed page, or LinkedIn changed its markup. Open the page ' +
        'below, press Inspect again, and check the browser console (F12 → Console) for ' +
        '[JobShield] output.',
        undefined
      );
      return;
    }
    if (shown.length) {
      try { shown[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    }
    showDebugModal(
      'Detected ' + cards.length + ' card(s)',
      'First ' + shown.length + ' are outlined in blue. Their details (title, company, ' +
      'location, class names) were logged to the console (F12 → Console) as "[JobShield] detected cards". ' +
      'You can paste that output in a support message to retune the detector.',
      details.map((d) =>
        (d.cls ? 'class="' + d.cls + '" ' : '') +
        (d.title ? 'title="' + d.title + '" ' : '') +
        (d.company ? 'company="' + d.company + '"' : '') +
        '(text ' + d.textLen + ' chars)'
      )
    );
  }

  function showDebugModal(heading, message, lines) {
    const old = $('#jobshield-modal');
    if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'jobshield-modal';
    m.innerHTML =
      '<div class="js-modal-box">' +
      '<div class="js-modal-title"><b>' + head(heading) + '</b></div>' +
      '<div class="js-modal-body">' + message + '</div>' +
      (lines && lines.length ? '<ul>' + lines.map((l) => '<li>' + head(l) + '</li>').join('') + '</ul>' : '') +
      '<button class="js-modal-close">Close</button>' +
      '</div>';
    m.querySelector('.js-modal-close').addEventListener('click', () => m.remove());
    document.body.appendChild(m);
  }

  function head(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ------------------------------------------------------------------
  // HUD (floating control panel)
  // ------------------------------------------------------------------
  function createHud() {
    if ($('#jobshield-hud')) return;
    const hud = document.createElement('div');
    hud.id = 'jobshield-hud';
    hud.innerHTML =
      '<div class="js-hud-title">🛡 Job Shield</div>' +
      '<div class="js-hud-detected">…</div>' +
      '<div class="js-hud-stats">…</div>' +
      '<div class="js-hud-actions">' +
      '<button class="js-hud-eye">Peek hidden</button>' +
      '<button class="js-hud-scan">Rescan</button>' +
      '<button class="js-hud-debug">🔍 Inspect</button>' +
      '<a class="js-hud-open" href="#">Settings</a>' +
      '</div>' +
      '<div class="js-hud-tip"></div>';
    hud.querySelector('.js-hud-eye').addEventListener('click', toggleShowHidden);
    hud.querySelector('.js-hud-scan').addEventListener('click', () => {
      state.allCards.forEach((el) => {
        if (el && el.isConnected) { clearCardUI(el); delete el.__jobShieldProcessed; }
      });
      state.aiDone = new WeakSet();
      scanNow();
    });
    hud.querySelector('.js-hud-debug').addEventListener('click', runDebug);
    hud.querySelector('.js-hud-open').addEventListener('click', (e) => {
      e.preventDefault();
      browser.runtime.sendMessage({ type: 'open-options' }).catch(() => {});
    });
    document.body.appendChild(hud);
    // Warm the AI model in the background if enabled.
    if (settings.aiEnabled) {
      browser.runtime.sendMessage({ type: 'ai-warmup', model: settings.aiModel }).catch(() => {});
    }
    updateHud();
  }

  function toggleShowHidden() {
    state.showHidden = !state.showHidden;
    $$('.jobshield-hidden').forEach((el) => {
      if (state.showHidden) {
        el.style.display = '';
        setChip(el, '🚫 Hidden — ' + ((el.__jobShieldReasons || ['rule']).join('; ')), 'hidden');
      } else {
        el.style.display = 'none';
        const chip = $('.jobshield-chip', el);
        if (chip) chip.remove();
      }
    });
    updateHud();
  }

  // ------------------------------------------------------------------
  // Styles
  // ------------------------------------------------------------------
  function injectStyles() {
    if ($('#jobshield-styles')) return;
    const style = document.createElement('style');
    style.id = 'jobshield-styles';
    style.textContent =
      '#jobshield-hud{position:fixed;top:12px;right:12px;z-index:2147483647;background:#0a66c2;color:#fff;' +
      'font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:13px;line-height:1.4;' +
      'border-radius:10px;padding:10px 12px;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:240px}' +
      '#jobshield-hud .js-hud-title{font-weight:700;margin-bottom:4px}' +
      '#jobshield-hud .js-hud-stats{opacity:.95;margin-bottom:8px}' +
      '#jobshield-hud .js-hud-actions{display:flex;gap:6px;flex-wrap:wrap}' +
      '#jobshield-hud button,#jobshield-hud a{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.4);' +
      'color:#fff;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer;text-decoration:none}' +
      '#jobshield-hud button:hover,#jobshield-hud a:hover{background:rgba(255,255,255,.3)}' +
      '.jobshield-hidden{outline:2px dashed #d11124 !important}' +
      '.jobshield-chip{display:block;box-sizing:border-box;margin:0 0 6px;padding:4px 8px;border-radius:6px;' +
      'font-size:12px;font-weight:600}' +
      '.jobshield-chip.hidden{background:#ffe4e6;color:#b91c1c;border:1px solid #f1aeb5}' +
      '.jobshield-recommended{box-shadow:0 0 0 2px #0a66c2, 0 0 12px rgba(10,102,194,.35) !important;border-radius:8px}' +
      '.jobshield-recommend-badge{position:absolute;top:8px;left:8px;z-index:3;background:#0a66c2;color:#fff;' +
      'font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;box-shadow:0 2px 6px rgba(0,0,0,.2)}' +
      '#jobshield-hud .js-hud-detected{font-size:12px;opacity:.95;margin-bottom:2px}' +
      '#jobshield-hud .js-hud-tip{font-size:11.5px;color:#ffd9a0;margin-top:8px;line-height:1.35}' +
      '#jobshield-modal{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);' +
      'display:flex;align-items:center;justify-content:center;padding:20px}' +
      '#jobshield-modal .js-modal-box{background:#fff;color:#1f2a37;border-radius:12px;max-width:520px;' +
      'max-height:80vh;overflow:auto;padding:18px 20px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}' +
      '#jobshield-modal .js-modal-title{font-size:15px;margin-bottom:8px}' +
      '#jobshield-modal .js-modal-body{font-size:13px;line-height:1.5;margin-bottom:10px}' +
      '#jobshield-modal ul{margin:8px 0 12px;padding-left:18px}' +
      '#jobshield-modal li{font-size:12px;margin:4px 0;word-break:break-word}' +
      '#jobshield-modal button{background:#0a66c2;border:none;color:#fff;border-radius:8px;padding:8px 14px;cursor:pointer}';
    (document.head || document.documentElement).appendChild(style);
  }

  // ------------------------------------------------------------------
  // Settings / messaging / lifecycle
  // ------------------------------------------------------------------
  async function loadSettings() {
    let user = {};
    try {
      const r = await browser.storage.local.get('jobShieldSettings');
      user = r.jobShieldSettings || {};
    } catch (e) { /* storage may be unavailable; use defaults */ }
    return mergeSettings(window.JobShieldDefaults || {}, user);
  }

  function bindMsg() {
    try {
      browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg) return;
        if (msg.type === 'scan') { scanNow(); sendResponse({ ok: true }); }
        else if (msg.type === 'get-stats') {
          sendResponse({
            hidden: $$('.jobshield-hidden').length,
            recommended: $$('.jobshield-recommended').length,
            insideLinkedIn: true
          });
        } else if (msg.type === 'open-options' || msg.type === 'open_settings') {
          browser.runtime.openOptionsPage();
        }
      });
    } catch (e) { /* ignore */ }
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes.jobShieldSettings) return;
    settings = mergeSettings(window.JobShieldDefaults || {}, changes.jobShieldSettings.newValue || {});
    // Reset per-card processing so everything is re-evaluated with new rules.
    $$('.jobshield-hidden, .jobshield-recommended, .jobshield-ai').forEach(clearCardUI);
    $$(CARD_SELECTORS.join(',')).forEach((el) => { delete el.__jobShieldProcessed; });
    state.aiDone = new WeakSet();
    if (settings.aiEnabled) {
      browser.runtime.sendMessage({ type: 'ai-warmup', model: settings.aiModel }).catch(() => {});
    }
    scanNow();
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  async function init() {
    settings = await loadSettings();
    injectStyles();
    createHud();
    bindMsg();
    try { browser.storage.onChanged.addListener(onStorageChanged); } catch (e) {}
    document.addEventListener('scroll', scheduleScan, { passive: true });
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    scheduleScan();
  }

  init();
})();


(function () {
  'use strict';

  const DEFAULTS = window.JobShieldDefaults || {};
  const $ = (id) => document.getElementById(id);

  const SCORING_IDS = [
    'noDescription', 'asksFollow', 'commentInterested', 'noLocation',
    'recruitmentAgency', 'dmMe', 'massHiring', 'noExperienceGuarantee', 'perKeyword'
  ];

  function joinLines(arr) { return (arr || []).join('\n'); }
  function splitLines(str) {
    return String(str || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function normalize(v) { return (v === undefined || v === null || v === '') ? DEFAULTS : v; }

  function populate(stored) {
    const s = Object.assign({}, DEFAULTS, stored);
    s.scoring = Object.assign({}, (DEFAULTS.scoring || {}), (stored.scoring || {}));

    $('enable').checked = !!s.enable;
    $('scoreThreshold').value = s.scoreThreshold;
    $('thresholdLabel').textContent = s.scoreThreshold;
    $('highlightRecommended').checked = !!s.highlightRecommended;

    $('blockedCompanies').value = joinLines(s.blockedCompanies);
    $('blockedKeywords').value = joinLines(s.blockedKeywords);
    $('whitelistKeywords').value = joinLines(s.whitelistKeywords);

    SCORING_IDS.forEach((id) => { $('sc_' + id).value = s.scoring[id]; });

    // Model dropdown
    const select = $('aiModel');
    select.innerHTML = '';
    (DEFAULTS._modelOptions || []).forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      opt.selected = (m.value === s.aiModel);
      select.appendChild(opt);
    });
    if (!Array.from(select.options).some((o) => o.selected)) {
      const opt = document.createElement('option');
      opt.value = s.aiModel; opt.textContent = s.aiModel; opt.selected = true;
      select.appendChild(opt);
    }

    $('aiEnabled').checked = !!s.aiEnabled;
    $('aiConfidence').value = s.aiConfidence;
    $('aiConfidenceLabel').textContent = Number(s.aiConfidence).toFixed(2);
    $('aiBlockAgencies').checked = !!s.aiBlockAgencies;
  }

  function collect() {
    const s = {
      enable: $('enable').checked,
      scoreThreshold: parseInt($('scoreThreshold').value, 10),
      highlightRecommended: $('highlightRecommended').checked,
      blockedCompanies: splitLines($('blockedCompanies').value),
      blockedKeywords: splitLines($('blockedKeywords').value),
      whitelistKeywords: splitLines($('whitelistKeywords').value),
      scoring: {},
      aiEnabled: $('aiEnabled').checked,
      aiModel: $('aiModel').value,
      aiConfidence: parseFloat($('aiConfidence').value),
      aiBlockAgencies: $('aiBlockAgencies').checked
    };
    SCORING_IDS.forEach((id) => { s.scoring[id] = parseInt($('sc_' + id).value, 10) || 0; });
    return s;
  }

  function save(settings) {
    return browser.storage.local.set({ jobShieldSettings: settings });
  }

  function flash(msg, ok) {
    const el = $('status');
    el.textContent = msg;
    el.style.color = ok ? '#059669' : '#dc2626';
    setTimeout(() => { el.textContent = ''; }, 2500);
  }

  async function init() {
    // Wire sliders that show live labels.
    $('scoreThreshold').addEventListener('input', () => {
      $('thresholdLabel').textContent = $('scoreThreshold').value;
    });
    $('aiConfidence').addEventListener('input', () => {
      $('aiConfidenceLabel').textContent = Number($('aiConfidence').value).toFixed(2);
    });

    let stored = {};
    try { stored = (await browser.storage.local.get('jobShieldSettings')).jobShieldSettings || {}; }
    catch (e) { /* ignore */ }
    populate(stored);

    $('save').addEventListener('click', async () => {
      await save(collect());
      flash('Saved ✔ — open LinkedIn tabs updated automatically.');
    });

    $('reset').addEventListener('click', async () => {
      await browser.storage.local.remove('jobShieldSettings');
      populate(DEFAULTS);
      flash('Reset to defaults ✔');
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();

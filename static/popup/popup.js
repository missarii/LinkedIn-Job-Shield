(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Resolve the current tab and whether it's LinkedIn.
  async function currentTab() {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      return tabs[0] || null;
    } catch (e) {
      return null;
    }
  }

  async function getSettings() {
    try {
      const r = await browser.storage.local.get('jobShieldSettings');
      const d = (typeof window.JobShieldDefaults !== 'undefined')
        ? window.JobShieldDefaults
        : { enable: true, aiEnabled: false };
      return Object.assign({}, d, r.jobShieldSettings || {});
    } catch (e) {
      return { enable: true, aiEnabled: false };
    }
  }

  async function refreshStats(sendToTab) {
    let hidden = 0, rec = 0, ai = false;
    if (sendToTab) {
      try {
        const res = await browser.tabs.sendMessage(sendToTab.id, { type: 'get-stats' });
        if (res) { hidden = res.hidden || 0; rec = res.recommended || 0; }
      } catch (e) { /* content not injected yet */ }
    }
    const s = await getSettings();
    $('statHidden').textContent = hidden;
    $('statShown').textContent = '–';
    $('statRec').textContent = rec;
    ai = !!s.aiEnabled;
    const aiEl = $('aiStatus');
    if (ai) {
      aiEl.style.display = '';
      aiEl.textContent = '🤖 AI filter enabled (' + (s.aiModel || '') + ') — first run downloads the model, be patient.';
    } else {
      aiEl.style.display = 'none';
    }
    return s;
  }

  async function init() {
    const tab = await currentTab();
    const isLinkedIn = tab && /linkedin\.com/.test(tab.url || '');
    const s = await getSettings();

    $('enabled').checked = !!s.enable;
    $('enabled').addEventListener('change', async (e) => {
      const cur = await getSettings();
      cur.enable = e.target.checked;
      await browser.storage.local.set({ jobShieldSettings: cur });
      if (isLinkedIn) {
        browser.tabs.sendMessage(tab.id, { type: 'scan' }).catch(() => {});
      }
    });

    $('btnScan').addEventListener('click', async () => {
      if (!isLinkedIn) {
        $('hint').textContent = 'Open a LinkedIn tab first, then press Re-scan.';
        return;
      }
      try {
        await browser.tabs.sendMessage(tab.id, { type: 'scan' });
        $('hint').textContent = 'Scanned current LinkedIn page.';
      } catch (e) {
        $('hint').textContent = 'Could not reach the page — reload the LinkedIn tab and try again.';
      }
      refreshStats(tab);
    });

    $('btnOptions').addEventListener('click', () => {
      browser.runtime.openOptionsPage();
    });

    if (!isLinkedIn) {
      $('hint').textContent = 'No LinkedIn tab found. Open LinkedIn Jobs and come back here.';
    }

    refreshStats(isLinkedIn ? tab : null);
  }

  document.addEventListener('DOMContentLoaded', init);
})();

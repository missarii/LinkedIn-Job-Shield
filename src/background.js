/*
 * background.js (source in src/)
 * ------------------------------
 * On-device AI classifier worker.
 *
 * This file is bundled with esbuild (see scripts/build.mjs) together with the
 * @huggingface/transformers library into a single self-contained IIFE that is
 * loaded as the extension's MV3 background "event page" (background.scripts).
 *
 * It runs zero-shot text classification entirely in the browser using a free
 * Hugging Face model. The model weights and the ONNX WebAssembly runtime are
 * downloaded from the Hugging Face CDN on first use and then cached, so the
 * extension keeps working for the rest of the session without any API keys.
 *
 * Messages handled:
 *   { type: 'ai-classify', text, model } -> { ok, action, label, score, ... }
 *   { type: 'ai-warmup',    model }      -> pre-loads the model in the background
 */
import { pipeline, env } from '@huggingface/transformers';

const DEFAULT_MODEL = 'Xenova/distilbert-base-multilingual-cased-nli-stsb';

// Candidate labels for zero-shot classification.
// The model scores the text against each label; we pick the highest.
const LABELS = [
  'an authentic real job posting with genuine employment',
  'a promotional, spam, or fake job advertisement',
  'a recruitment or staffing agency advertisement'
];

// Turn off the "local models folder" fallback; we always fetch from the hub.
try {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  env.quantized = true;
  // proxy=false is required when running inside a non-main-thread context
  // (an extension event page / worker), otherwise ORT tries to use a proxy
  // worker that cannot be created here.
  env.backends.onnx.wasm.proxy = false;
} catch (err) {
  console.warn('[JobShield] env setup issue:', err);
}

let classifierPromise = null;
let loadedModel = null;

// Create (or reuse) the classification pipeline for a given model.
async function getClassifier(model) {
  const key = model || DEFAULT_MODEL;
  if (classifierPromise && loadedModel === key) {
    return classifierPromise;
  }
  loadedModel = key;
  classifierPromise = (async () => {
    try {
      return await pipeline('zero-shot-classification', key);
    } catch (err) {
      // Reset so a later request can retry.
      classifierPromise = null;
      throw err;
    }
  })();
  return classifierPromise;
}

// Classify a piece of job-post text and map it to a simple action.
async function classify(text, model) {
  const clf = await getClassifier(model);
  const trimmed = String(text || '').slice(0, 1500);
  const res = await clf(trimmed, LABELS, { multi_label: false });

  const label = res.labels[0];
  const score = res.scores[0];

  let action = 'real';
  if (/promotional|fake|spam/.test(label)) action = 'hide';
  else if (/recruit|staffing|agency/.test(label)) action = 'agency';

  return { action, label, score, labels: res.labels, scores: res.scores };
}

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'open-options' || msg.type === 'open_settings') {
    browser.runtime.openOptionsPage();
    return false;
  }
  if (msg.type !== 'ai-classify') return false;

  classify(msg.text, msg.model)
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((err) =>
      sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
  return true; // keep the message channel open for the async response
});

// Optional: warm the model up as soon as the page asks for it.
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'ai-warmup') {
    getClassifier(msg.model).catch(() => {});
  }
});

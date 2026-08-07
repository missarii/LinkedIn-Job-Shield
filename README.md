# 🛡 LinkedIn Job Shield

A **Firefox extension** that cleans up your LinkedIn feed and job search by hiding
fake, promotional, scam-like and irrelevant job posts — and highlighting the ones
that actually match what you're looking for.

It combines two strategies:

1. **Rule engine (instant, offline, no downloads)** — blocked companies, blocked
   keywords/phrases, a weighted "suspicion score", and a whitelist that marks good
   posts as ⭐ Recommended.
2. **Optional on-device AI classifier (free)** — uses
   [Transformers.js](https://huggingface.co/docs/transformers.js) to run a *zero-shot
   text classification* model **locally in your browser**. No API key, no server, and
   nothing you look at ever leaves your machine.

---

## Features

- 🚫 **Hide by company name** — add `XYZ Recruitment`, `ABC Staffing`, etc.
- 🔑 **Hide by text patterns** — `follow our page`, `comment interested`, `dm me`,
  `urgent hiring`, `mass hiring` …
- ⚖️ **Suspicion scoring** — signals add points (no job description, asks to follow,
  comment-Interested bait, no location, recruitment agency, DM-me, guaranteed-job…);
  posts that cross the threshold are hidden.
- ⭐ **Whitelist & highlight** — posts matching `react`, `remote`, `germany`, `fullstack`…
  get a green ring + a ⭐ badge and are never hidden by score alone.
- 🤖 **On-device AI** — a zero-shot classifier labels each remaining post as *real job*,
  *promotional/spam*, or *recruitment agency ad*, and hides it when confident enough.
- 👁 **Peek hidden** — one click to reveal what was hidden (with the reason shown) or
  hide it again.
- 🔄 **Auto re-scan** — detects new cards as you scroll (LinkedIn loads them lazily).
- ⚙️ **Full settings page** — everything editable, saved to `browser.storage.local`,
  applied live to open LinkedIn tabs.

---

## Install (development / temporary add-on)

1. **Build** the extension:

   ```bash
   npm install
   npm run build
   ```

2. Open **`about:debugging#/runtime/this-firefox`** in Firefox → **Load Temporary Add-on…**
   → select **`dist/manifest.json`** (or the whole `dist` folder).

3. Open any LinkedIn Jobs or feed page and you'll see the floating **🛡 Job Shield**
   control panel in the top-right. Tweak rules from the toolbar popup or
   **⚙ Settings**.

> Requires **Firefox 128+** (for MV3 event-page background) and internet on first use
> of the AI model (it downloads the model once, then caches it).

---

## Project layout

```
├── src/background.js        # AI worker (bundled with Transformers.js via esbuild)
├── static/
│   ├── manifest.json        # Firefox MV3 manifest
│   ├── rules.js             # default rules + scoring (shared with options UI)
│   ├── content.js           # LinkedIn scraper + rule engine + HUD
│   ├── popup/               # toolbar popup
│   ├── options/             # settings page
│   └── icons/               # generated PNG icons
├── scripts/
│   ├── build.mjs            # builds ./dist (bundle + copy)
│   └── make_icons.py        # regenerates icons (Pillow)
├── tests/filter.test.mjs    # functional test (jsdom)
└── dist/                    # the loadable extension (generated)
```

### Commands

```bash
npm run build       # bundle background + copy static files into dist/
npm test            # run the filtering unit test (jsdom)
npm run build:icon  # regenerate icons
```

---

## How the AI part works

- The background worker is bundled (with **esbuild**) together with
  `@huggingface/transformers` into a single classic IIFE — the only file that runs
  the ML library (keeps the extension **CSP‑safe**; `'wasm-unsafe-eval'` is enabled in
  the manifest for the ONNX WebAssembly runtime).
- When **AI filtering** is enabled, each non-hidden card's text is sent to the worker,
  which runs zero-shot classification with labels like
  *“an authentic real job posting …”*, *“a promotional, spam, or fake job advertisement”*,
  and *“a recruitment or staffing agency advertisement”*.
- The model is a **free Hugging Face** model downloaded at runtime and cached:

  | Model | Languages | Notes |
  |---|---|---|
  | `Xenova/nli-deberta-v3-xsmall` | English | Small, fast — recommended default for English job posts |
  | `Xenova/distilbert-base-multilingual-cased-nli-stsb` | 50+ | Larger, good if you search in e.g. German/Norwegian |

- You pick the model in **Settings → 🤖 On-device AI classifier**.

### Adding your own fine-tuned model

The worker uses the standard Transformers.js `pipeline('zero-shot-classification')`.
You can swap in any compatible **zero-shot / NLI** model hosted on the Hugging Face hub
(e.g. a `Xenova/…` ONNX-converted NLI model) by adding it to `_modelOptions` in
`static/rules.js`. If you want to truly *fine-tune* a classifier to your own scraped
dataset, export it to ONNX with 🤗 [Optimum](https://huggingface.co/docs/optimum) and
point `aiModel` at it.

---

## Notes & limitations

- LinkedIn's DOM markup changes frequently. `content.js` uses several selector
  fallbacks and falls back to the card's visible text, so it keeps working across
  layout tweaks, but you may occasionally need to update selectors in
  `CARD_SELECTORS` / `extractCardInfo`.
- The rule engine is deliberately simple (`Array.includes` substring matching on
  lowercased text) — easy to read and extend.
- The AI model download happens once and is cached, but the very first run with AI
  enabled can take a little while on a slow connection.
- This is for personal use. Don't rely on it to hide posts that are fine for you —
  use **Peek hidden** to review anything the filter decided to hide.

---

## License

MIT. The bundled AI inference is powered by [🤗 Transformers.js](https://github.com/huggingface/transformers.js)
and [ONNX Runtime](https://onnxruntime.ai/) (both permissively licensed); models are
free Hugging Face checkpoints.

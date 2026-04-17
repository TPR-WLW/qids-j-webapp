# Security & supply chain

This document describes the third-party code/data this web app loads,
how each piece is pinned, and what integrity checks are in place.

## Trusted origins

| Origin | What | Trust |
|---|---|---|
| (this repo) `models/face_landmarker.task` | MediaPipe FaceLandmarker weights | **self-hosted**, SHA-384 pinned in `js/recorder.js` |
| `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs` | MediaPipe JS bundle | version pinned, **SHA-384 preload** (`<link rel="modulepreload" integrity=...>`) |
| `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/*` | MediaPipe WASM runtime (Emscripten) | version pinned, integrity not verified (runtime files loaded by the bundle) |

### Why the WASM files are not hashed

`FilesetResolver.forVisionTasks()` internally fetches `vision_wasm_internal.js`,
`vision_wasm_internal.wasm`, and their `nosimd` siblings.  The bundle does not
expose a way to attach SRI to those fetches.  If this becomes a concern,
self-host the whole tasks-vision package under `models/wasm/` and point
`WASM_BASE` in `js/recorder.js` at that local path.

## Verifying hashes manually

```bash
# model
openssl dgst -sha384 -binary models/face_landmarker.task | openssl base64 -A
# expected: tYQh+yJE8llY+zO4RviZmWaSKs5W9tsB0ix5rjQVpF5/CLTqmwtP7bYtkUi2w65P

# vision_bundle.mjs
curl -sL https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs \
  | openssl dgst -sha384 -binary | openssl base64 -A
# expected: pv/a53slpd9r+c7gv5R/Yx+690OjBKfh44t0YEEQi74uhGupAjv0NpiHrzlmhiVn
```

## Runtime behaviour

1. Browser preloads `vision_bundle.mjs`; if the SRI hash does not match,
   the preload is discarded and the dynamic `import()` in `js/recorder.js`
   will either re-fetch or fail, depending on the browser.  Chromium-based
   browsers currently re-use the preloaded response only when the integrity
   matches.
2. `js/recorder.js` fetches `models/face_landmarker.task`, computes its
   SHA-384 via `SubtleCrypto`, and **refuses to load** the model if the
   digest does not equal `MODEL_SHA384`.  The error bubbles up to the UI
   status bar.
3. All user data (landmarks, blendshapes, webcam video) stays inside the
   browser.  No analytics, telemetry, or beacons are sent.

## Updating pinned versions

When upgrading `@mediapipe/tasks-vision` or replacing the `.task` model:

1. Replace the file in place (or change the URL in `recorder.js`).
2. Recompute the SHA-384 and update `MODEL_SHA384` in `js/recorder.js` /
   the `integrity=` attribute in `index.html`.
3. Update this document.
4. Run the preview and confirm there is no "integrity mismatch" error.

## Reporting vulnerabilities

Please open a GitHub issue or email the maintainer listed in `LICENSE`.

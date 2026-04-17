# QIDS-J Self-check (web app)

A single-page, one-question-at-a-time web implementation of the
**QIDS-J** (Quick Inventory of Depressive Symptomatology — Japanese version),
an open self-rating scale published by Japan's Ministry of Health, Labour and Welfare.

Optional: while answering, the app can record webcam video and log
**478 3D facial landmarks + 52 ARKit-style blendshapes + 4×4 head-pose matrix** at 30 fps
using MediaPipe FaceLandmarker.  Everything is processed locally in the
browser; nothing is sent to any server.

> **Not a medical device.** This tool cannot diagnose depression.
> It is a screening/self-reflection instrument; for any diagnosis or
> treatment decision, please consult a licensed professional.
> If you are in Japan and having suicidal thoughts, the app will pop
> up a crisis-hotline panel immediately; you can also call `0120-279-338`
> (Yorisoi Hotline, 24h, free).

[**Live demo →** https://tpr-wlw.github.io/qids-j-webapp/](https://tpr-wlw.github.io/qids-j-webapp/)

日本語の詳しい説明は [`README.md`](./README.md) を参照。

---

## Features

- **16 QIDS-J items** in fixed order, one per screen.
- **QIDS-J scoring** (max of sleep / appetite / psychomotor groups + 6 single items → 0–27, 5 severity levels).
- **Optional webcam recording**
  - 478 3D landmarks (x, y, z normalized)
  - 52 blendshapes (jawOpen, browInnerUp, mouthSmileLeft, ...)
  - 4×4 head transformation matrix (yaw / pitch / roll)
  - ~30 fps, VIDEO mode with inter-frame tracking
- **Per-question time tracking** with `question_enter`, `answer_selected`, `question_finalize` events plus auto-computed `questionSegments` summary.
- **Safety affordances**: immediate crisis-hotline modal on Q12 ≥ 2, hard disclaimers, fine-grained consent, 18+ age gate.
- **Supply-chain hardening**: self-hosted model with SHA-384 verification, SRI preload hint for the MediaPipe JS bundle.
- **Privacy**: all data stays in the browser tab; only live on the page until reload unless the user explicitly downloads.
- **Responsive**: mobile / tablet / desktop layouts tested.
- **Accessibility**: radiogroup ARIA, visible focus outlines, WCAG-AA contrast severity colors, keyboard shortcuts (0–3 / Enter / ←).
- **Progress autosave**: no-camera runs survive reload (24h TTL, localStorage).

## Downloads produced

| File | What |
|---|---|
| `*_recording.webm` | Full webcam video (VP9 if supported, else VP8 / MP4) |
| `*_landmarks.json.gz` | Compressed landmark log (~12–18 MB per 5 min). Recommended. |
| `*_landmarks.json`    | Same, uncompressed (~100+ MB). For quick inspection. |
| `*_answers.csv`       | Answer table with total score and severity. Excel-friendly (BOM). |

JSON schema and parsing examples live in [`utils/README.md`](./utils/README.md);
Python (`decode.py`) and Node.js (`decode.mjs`) sample decoders are provided.

## Run locally

```bash
python -m http.server 8765          # or: npx serve .
# then open http://localhost:8765/
```

Web-camera APIs require HTTPS or localhost; do **not** open `index.html` via `file://`.

## File layout

```
.
├── index.html           Intro / Quiz / Result screens, crisis modal
├── css/style.css        Responsive, calm teal palette, WCAG-AA severity colors
├── js/
│   ├── questions.js     QIDS-J 16 items + scoring function
│   ├── recorder.js      MediaPipe FaceLandmarker + MediaRecorder orchestration
│   └── app.js           Screen router, answer state, event logging, downloads
├── models/
│   └── face_landmarker.task   Pinned MediaPipe model (SHA-384 verified at runtime)
├── utils/
│   ├── decode.py        Python decoder with pandas support
│   ├── decode.mjs       Node.js 18+ decoder, zero deps
│   └── README.md        JSON format spec + examples
├── SECURITY.md          Supply-chain story, trust boundaries, update playbook
└── .claude/launch.json  Local dev server config
```

## Browser compatibility

| Feature | Minimum |
|---|---|
| Web camera (getUserMedia) | Chrome 53+, Firefox 36+, Safari 11+, Edge 12+ |
| MediaRecorder / WebM | Chrome 49+, Firefox 25+, Safari 14.1+, Edge 79+ |
| CompressionStream ('gzip') | Chrome 80+, Firefox 113+, Safari 16.4+, Edge 80+ |
| MediaPipe WASM + WebGL2 | Chrome 56+, Firefox 51+, Safari 15+ |
| SubtleCrypto.digest | Evergreen (all HTTPS pages) |

Mobile Safari (iPadOS/iOS) works but camera capture is more restricted;
for full 30 fps performance, use a desktop Chromium or Firefox build.

## License

MIT. See [`LICENSE`](./LICENSE).

The QIDS-J questionnaire itself is published by the Japanese Ministry of Health, Labour
and Welfare; original authors and translators retain copyright.

## Attribution

- QIDS-J: [Ministry of Health, Labour and Welfare, Japan](https://www.mhlw.go.jp/bunya/shougaihoken/kokoro/dl/02.pdf)
- Face Landmarker model: Google, [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- Crisis hotlines: Inochi-no-Denwa, Yorisoi Hotline, `まもろうよこころ` (MHLW)

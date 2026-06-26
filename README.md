# QIDS-J / PHQ-9 セルフチェック Web アプリ

抑うつ症状の自己記入式尺度を、1 問ずつ回答する Web アンケート形式で実装したセルフチェックツールです。
最初の画面で **質問票を選択**でき、現在は **QIDS-J**（簡易抑うつ症状尺度）と **PHQ-9**（こころとからだの質問票）に対応しています。
設問・選択肢・採点ロジック・重症度区分・危機介入のしきい値はすべて `surveys/*.json` で定義されており、JSON を追加するだけで新しい尺度を増やせます。
回答中の表情を Web カメラで録画し、顔のランドマークの変化も記録できます。
すべての処理はブラウザ内で完結し、映像・データは外部へ送信されません。

> 出典：[厚生労働省「簡易抑うつ症状尺度（QIDS-J）」](https://www.mhlw.go.jp/bunya/shougaihoken/kokoro/dl/02.pdf) ／ PHQ-9（Patient Health Questionnaire-9）

**Live demo**: https://tpr-wlw.github.io/qids-j-webapp/
**English README**: [README_EN.md](./README_EN.md)

---

## 計測デバイス（心率: ECG / PPG）

回答中の心率・HRV を、被験者情報画面で選んだデバイスで記録できる（**PPG のみ / myBeat のみ / 両方**）。

- **myBeat（ECG・胸部）** — 本地サーバ `server.py`（Windows / UTWS SDK）経由。
- **PPG（ESP32-C6 + MAX30102・指先）** — ブラウザ **Web Bluetooth** 直結（Chrome / Edge）。固件は `xiao-esp32c6-max30102-hrv` をそのまま使用、PPG のみなら静的配信でも可。

両者は同一タイムラインで記録され、設問別・安静相別の HRV まで自動算出・保存される。
詳細は [`docs/PPG_INTEGRATION_PLAN.md`](./docs/PPG_INTEGRATION_PLAN.md) ／ [`docs/PROTOCOL.md`](./docs/PROTOCOL.md)。

---

## 主な機能

- **複数の質問票に対応** — 最初の画面で選択（現在 **QIDS-J** / **PHQ-9**）。題库は `surveys/*.json` で定義し、追加は JSON を置くだけ
- **質問票ごとの採点ロジック（JSON で宣言的に定義）**
  - QIDS-J（16 項目）: 睡眠（Q1-Q4）／食欲・体重（Q6-Q9）／精神運動（Q15-Q16）はそれぞれ最大値を採用。9 項目合計 0–27 点、5 段階判定（正常／軽度／中等度／重度／きわめて重度）
  - PHQ-9（9 項目）: 9 項目の単純合計 0–27 点、5 段階判定（なし〜最小／軽度／中等度／中等度〜重度／重度）
  - 危機介入モーダルのしきい値も質問票ごとに定義（QIDS-J は Q12 ≥ 2、PHQ-9 は Q9 ≥ 1）
- **Web カメラ録画**（`MediaRecorder` / WebM-VP9）
- **顔ランドマーク追跡**（[MediaPipe FaceLandmarker](https://developers.google.com/mediapipe/solutions/vision/face_landmarker)）
  - **478 点** 3D メッシュ（x, y, z）
  - **52 blendshape**（ARKit 準拠：`jawOpen`, `browInnerUp`, `mouthSmileLeft` ほか）
  - **4×4 頭部変換行列**（yaw / pitch / roll を抽出可能）
  - **30 fps** 連続記録、VIDEO モードによる帧間追跡
- **レスポンシブ** — スマホ／タブレット／デスクトップ対応
- **プライバシー重視** — 映像も特徴点もブラウザ内のみで処理し、外部送信なし
- **結果データのダウンロード**
  - 録画（`.webm`）
  - 特徴点データ（`.json.gz` 圧縮推奨 / `.json` 非圧縮も可）
  - 回答（`.csv`）

---

## ファイル構成

```
.
├── index.html           # 4 画面（被験者情報／イントロ／問卷／結果）
├── css/style.css        # レスポンシブ・落ち着いた青緑配色
├── surveys/             # 質問票を JSON で定義（量表の追加はここに置くだけ）
│   ├── manifest.json    #   選択可能な質問票の一覧
│   ├── qids-j.json      #   QIDS-J 16 項目（設問・採点・重症度・危機介入）
│   └── phq-9.json       #   PHQ-9 9 項目
├── js/
│   ├── survey.js        # 質問票エンジン（JSON 読み込み・採点・重症度判定）
│   ├── recorder.js      # MediaPipe FaceLandmarker + MediaRecorder
│   └── app.js           # 画面遷移・回答管理・結果表示・ダウンロード
├── utils/
│   ├── decode.py        # Python での読み込み例（pandas DataFrame 化まで）
│   ├── decode.mjs       # Node.js 18+ での読み込み例（依存なし）
│   └── README.md        # 出力 JSON のフォーマット仕様と利用サンプル
└── .claude/launch.json  # Claude Code プレビュー設定（ローカル開発用）
```

### 質問票の追加方法

新しい尺度を追加するには、コードを変更せずに JSON を 1 つ置くだけです。

1. `surveys/<id>.json` を作成（既存の `qids-j.json` / `phq-9.json` が雛形）。
   - `questions[]`: `{ id, domain, title, options }`。`options` は配列か `optionSets` のキー名（共通選択肢の使い回し）。自殺念慮など即時介入が必要な設問には `crisis: { minScore }` を付与。
   - `scoring`: `{ "method": "sum" }`（単純合計）か `{ "method": "grouped", "groups": [...] }`（組ごとに `max` / `sum`）。
   - `severity[]`: `{ max, key, label, color, advice }`（`max` 以下で区間判定）。
   - `intro` / `source` / `domainLabels`: 画面表示用メタ情報。
2. `surveys/manifest.json` に 1 行追加（`id` / `name` / `file`）。

`name` がそのまま選択ドロップダウンに表示されます。

---

## ローカルで試す

Web カメラ API は **HTTPS または `localhost`** でのみ動作するため、ファイルを直接ダブルクリックで開くのではなく、ローカルサーバを立ててください。

```bash
# Python があれば
python -m http.server 8765

# もしくは Node があれば
npx serve .
```

ブラウザで `http://localhost:8765/` を開き、カメラ使用を許可してください。

---

## 採点基準

| 合計点 | 重症度 |
| --- | --- |
| 0 – 5  | 正常 |
| 6 – 10 | 軽度 |
| 11 – 15 | 中等度 |
| 16 – 20 | 重度 |
| 21 – 27 | きわめて重度 |

**6 点以上が継続する場合は医療機関にご相談ください。**
本ツールは医学的診断を行うものではありません。

---

## アーキテクチャ（v2: post-hoc extraction）

v2 では問卷中に MediaPipe を走らせず、**録画のみ** を行います。表情の特徴点抽出は
問卷終了後のユーザー操作で、録画済み webm を再生しながら MediaPipe に通して
実施します。これにより、弱い GPU（例: Intel UHD）でも問卷 UI が一切カクつかず、
抽出精度も GPU 依存で決まらなくなります（時間はかかります）。

```
┌ 問卷中 ────────────────────────────┐     ┌ 問卷終了後 ─────────────────────┐
│ [Video] ─ MediaRecorder ─ webm Blob │ →   │ extract.mjs                     │
│ [Events] ─ performance.now() ────── │ →   │   ├─ webm を <video> で再生     │
│ question_enter / answer_selected /  │     │   ├─ 各フレームを MediaPipe へ │
│ baseline_start / baseline_end 等     │     │   └─ 478pts + 52bs + 4x4mat    │
└─────────────────────────────────────┘     │                                 │
                                            │ analyze.html ← handoff or drop  │
                                            └─────────────────────────────────┘
```

抽出時のオプション:
- **fps 10 / 20 / 30 (既定) / 60** — 高い fps ほど時間がかかるが微表情を捉えやすい
- **GPU / CPU 自動選択** — GPU 推論が 70ms/frame を超えたら WASM SIMD (CPU) にフォールバック
- **EMA 時間平滑化** — Off / 弱 / 中 / 強 の 4 段階

### 技術ノート

- MediaPipe FaceLandmarker は [@mediapipe/tasks-vision@0.10.14](https://www.npmjs.com/package/@mediapipe/tasks-vision) を jsDelivr 経由で動的 import。モデル `face_landmarker.task` はリポジトリ内に SHA-384 つきで同梱（CI でハッシュ一致を検証）。
- 時間軸: `event.t`（recorder.js 出力）と `video.currentTime * 1000` は同じ `mediaRecorder.start()` 時刻を起点にしており、**ずれ無し**で対応します（`meta.timebaseAligned: true`）。
- 録画映像は `Blob` として保持され、webm のまま直接ダウンロードできます。v1 互換の `.json.gz` ダウンロードは抽出後の分析ビューアーから行えます。
- 分析ビューアー (`analyze.html`) はスタンドアロンで、任意の webm（本ツール外で録った映像も可）をドロップして特徴点抽出・可視化できます。

### v1 → v2 の移行

v1 は [`v1.0`](https://github.com/TPR-WLW/qids-j-webapp/releases/tag/v1.0) で凍結しています。v1 でダウンロードした特徴点 JSON は v2 の analyze ビューアーでもそのまま開けます。

### 出力される特徴点 JSON

フォーマット仕様と読み込みサンプルは [`utils/README.md`](./utils/README.md) にまとめてあります。
5 分間 × 30 fps で、圧縮後 **約 12–18 MB**。

---

## ライセンス

本リポジトリのソースコードは MIT ライセンスです。
QIDS-J 自体の著作権は原著者・翻訳者に帰属します。

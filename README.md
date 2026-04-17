# QIDS-J セルフチェック Web アプリ

厚生労働省が公開する **簡易抑うつ症状尺度（QIDS-J）** を、1 問ずつ回答する Web アンケート形式で実装したセルフチェックツールです。
回答中の表情を Web カメラで録画し、顔の 68 点ランドマークの変化も記録できます。
すべての処理はブラウザ内で完結し、映像・データは外部へ送信されません。

> 出典：[厚生労働省「簡易抑うつ症状尺度（QIDS-J）」](https://www.mhlw.go.jp/bunya/shougaihoken/kokoro/dl/02.pdf)

**Live demo**: https://tpr-wlw.github.io/qids-j-webapp/
**English README**: [README_EN.md](./README_EN.md)

---

## 主な機能

- **QIDS-J 16 項目** — 日本語原文、順序固定、1 画面 1 問
- **QIDS-J 採点ロジック**
  - 睡眠（Q1-Q4）／食欲・体重（Q6-Q9）／精神運動（Q15-Q16）はそれぞれ最大値を採用
  - 9 項目合計 0–27 点、5 段階の重症度判定（正常／軽度／中等度／重度／きわめて重度）
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
├── index.html           # 3 画面（イントロ／問卷／結果）
├── css/style.css        # レスポンシブ・落ち着いた青緑配色
├── js/
│   ├── questions.js     # QIDS-J 16 項目 + 採点関数
│   ├── recorder.js      # MediaPipe FaceLandmarker + MediaRecorder
│   └── app.js           # 画面遷移・回答管理・結果表示・ダウンロード
├── utils/
│   ├── decode.py        # Python での読み込み例（pandas DataFrame 化まで）
│   ├── decode.mjs       # Node.js 18+ での読み込み例（依存なし）
│   └── README.md        # 出力 JSON のフォーマット仕様と利用サンプル
└── .claude/launch.json  # Claude Code プレビュー設定（ローカル開発用）
```

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

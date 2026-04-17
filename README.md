# QIDS-J セルフチェック Web アプリ

厚生労働省が公開する **簡易抑うつ症状尺度（QIDS-J）** を、1 問ずつ回答する Web アンケート形式で実装したセルフチェックツールです。
回答中の表情を Web カメラで録画し、顔の 68 点ランドマークの変化も記録できます。
すべての処理はブラウザ内で完結し、映像・データは外部へ送信されません。

> 出典：[厚生労働省「簡易抑うつ症状尺度（QIDS-J）」](https://www.mhlw.go.jp/bunya/shougaihoken/kokoro/dl/02.pdf)

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

## 技術ノート

- **MediaPipe FaceLandmarker** を [@mediapipe/tasks-vision@0.10.14](https://www.npmjs.com/package/@mediapipe/tasks-vision) から jsDelivr 経由で動的 import しています。モデル `face_landmarker.task` は Google が公開している公式 CDN から取得し、ブラウザにキャッシュされます。
- 検出は `setTimeout` ベースで **30 fps** に節流し、VIDEO モード（帧間追跡あり）で安定した 478 点 3D ランドマークを得ます。`detectForVideo` は同期実行ですが 1 frame あたり 8–15 ms 程度なので、UI イベントは詰まりません。
- 最初の推論時には GPU シェーダーのコンパイルが走るため、問卷画面に入る前にダミー画像で 1 回ウォームアップしています。
- 録画映像と特徴点ログはブラウザ内で `Blob` として保持され、ダウンロード時に `CompressionStream('gzip')` で圧縮して `.json.gz` を書き出します（非圧縮 `.json` も選択可）。
- 時間基準は `performance.now()` を使い、システム時刻のドリフトに影響されないようにしています。
- 画面右上の摄像头プレビューに、頭部のヨー / ピッチ / ロールがリアルタイム表示されます（4×4 変換行列から算出）。

### 出力される特徴点 JSON

フォーマット仕様と読み込みサンプルは [`utils/README.md`](./utils/README.md) にまとめてあります。
5 分間 × 30 fps で、圧縮後 **約 12–18 MB**。

---

## ライセンス

本リポジトリのソースコードは MIT ライセンスです。
QIDS-J 自体の著作権は原著者・翻訳者に帰属します。

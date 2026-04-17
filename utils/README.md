# utils — 記録データの読み込みサンプル

QIDS-J webapp が書き出す `qids-j_landmarks_*.json(.gz)` を読み込む最小サンプルを置いてあります。

## ファイルフォーマット

```jsonc
{
  "meta": { /* 後述 */ },

  "questionSegments": [
    // 問題ごとの入退出時刻・活動時間・回答履歴のサマリ（16 項目）
    {
      "q": 0,                             // 0-indexed
      "questionNumber": 1,                // 1-indexed（Q1）
      "title": "寝つき",
      "domain": "sleep",
      "enterTimes": [0.0, 45210.5],       // 2 回入ってきた
      "firstAnswerTime": 3210.1,          // 最初に選択肢を押した時刻
      "lastAnswerTime": 4980.7,           // 最後に選び直した時刻
      "finalAnswer": 1,                   // 最終的な選択 (0-3)
      "finalizeTime": 5430.2,             // 「次へ」を押して離れた時刻
      "answerEventCount": 2,              // 選び直し回数
      "activeTimeRanges": [[0.0, 5430.2], [45210.5, 48200.3]],
      "activeDurationMs": 8420.0          // 合計滞在時間
    }
  ],

  "frames": [
    // 通常の検出フレーム（30 fps）
    {
      "t": 123.45,
      "q": 0,
      "pts": [[0.5123, 0.4821, -0.0142], /* ... 478 点 × [x,y,z] */],
      "bs":  { "jawOpen": 0.12, "browInnerUp": 0.33, /* ... 52 項目 */ },
      "mat": [/* 16 floats (4x4 column-major) */]
    },
    // イベントマーカー（pts/bs/mat は持たない）
    { "t": 5432.10, "q": 1, "event": "question_enter" },
    { "t": 5980.12, "q": 1, "event": "answer_selected",   "a": 2 },
    { "t": 6310.45, "q": 1, "event": "answer_selected",   "a": 1 },  // 選び直し
    { "t": 6800.00, "q": 1, "event": "question_finalize", "a": 1 }
  ],

  "result":  { "total": 12, "severity": "中等度", "severityKey": "moderate", "breakdown": {...} },
  "answers": [{ "q": 1, "title": "寝つき", "score": 1 }, /* ... 16 項目 */]
}
```

### meta

```jsonc
{
  "sessionStart": "2026-04-17T05:12:30.123Z",
  "videoWidth": 640,
  "videoHeight": 480,
  "runtime": "@mediapipe/tasks-vision@0.10.14",
  "modelUrl": "https://.../face_landmarker.task",
  "targetFps": 30,
  "mirrored": true,
  "pointCount": 478,
  "blendshapeCount": 52,
  "ptsFormat": "array of [x, y, z] normalized",
  "matFormat": "16 floats, 4x4 facial transformation matrix, column-major",
  "timeBase": "performance.now() ms relative to recording start",
  "eventTypes": ["question_enter", "answer_selected", "question_finalize"]
}
```

### 特定の問題のフレームだけ抜き出す

```python
import gzip, json
doc = json.load(gzip.open("qids-j_landmarks_...json.gz", "rt", encoding="utf-8"))

def frames_of_question(doc, q_index):
    """Q(q_index+1) に滞在していた間の検出フレームを返す。"""
    seg = next((s for s in doc["questionSegments"] if s["q"] == q_index), None)
    if not seg:
        return []
    ranges = seg["activeTimeRanges"]
    return [
        f for f in doc["frames"]
        if "pts" in f and any(a <= f["t"] < b for (a, b) in ranges)
    ]

# 例: Q1（寝つき）回答中のフレーム
q0_frames = frames_of_question(doc, 0)
print(f"Q1 detection frames: {len(q0_frames)}")

# ついでに Q1 にかかった合計時間
seg = doc["questionSegments"][0]
print(f"Q1 滞在時間: {seg['activeDurationMs']/1000:.1f}s, "
      f"最初に答えを選ぶまで: {(seg['firstAnswerTime'] - seg['enterTimes'][0])/1000:.1f}s")
```

### 座標系

- `pts[i] = [x, y, z]`
  - `x`, `y` は入力フレームに対して 0〜1 に正規化されたピクセル座標（左上原点）
  - `z` は相対デプス（マイナスは鼻より手前、プラスは奥）
  - **ミラー表示はブラウザ側の CSS のみで、保存されている座標は生フレームの座標**
- `mat` は 4×4 の **列優先（column-major）** 変換行列。
  頭部姿勢を取り出す例：

  ```python
  import numpy as np
  M = np.array(frame["mat"], dtype=np.float32).reshape(4, 4, order="F")  # column-major
  R = M[:3, :3]  # 回転部
  yaw   = np.degrees(np.arctan2(R[0, 2], R[2, 2]))
  pitch = np.degrees(-np.arcsin(np.clip(R[1, 2], -1, 1)))
  roll  = np.degrees(np.arctan2(R[2, 0], R[1, 1]))
  ```

### blendshape の例（52 項目）

MediaPipe FaceLandmarker は ARKit 準拠の名前で blendshape スコア（0〜1）を返します:

```
_neutral
browDownLeft, browDownRight, browInnerUp, browOuterUpLeft, browOuterUpRight
cheekPuff, cheekSquintLeft, cheekSquintRight
eyeBlinkLeft, eyeBlinkRight, eyeLookDownLeft, eyeLookDownRight,
eyeLookInLeft, eyeLookInRight, eyeLookOutLeft, eyeLookOutRight,
eyeLookUpLeft, eyeLookUpRight, eyeSquintLeft, eyeSquintRight,
eyeWideLeft, eyeWideRight
jawForward, jawLeft, jawOpen, jawRight
mouthClose, mouthDimpleLeft, mouthDimpleRight, mouthFrownLeft, mouthFrownRight,
mouthFunnel, mouthLeft, mouthLowerDownLeft, mouthLowerDownRight,
mouthPressLeft, mouthPressRight, mouthPucker, mouthRight, mouthRollLower,
mouthRollUpper, mouthShrugLower, mouthShrugUpper,
mouthSmileLeft, mouthSmileRight, mouthStretchLeft, mouthStretchRight,
mouthUpperUpLeft, mouthUpperUpRight
noseSneerLeft, noseSneerRight
```

## 使い方

### Python

```bash
# 最低限
python utils/decode.py qids-j_landmarks_20260417_142530.json.gz

# pandas / numpy を入れておくと DataFrame 化までしてくれる
pip install pandas numpy
python utils/decode.py qids-j_landmarks_20260417_142530.json.gz
```

pandas を使う場合、`decode.py` の `to_dataframe()` が

```
t | q | pt0_x pt0_y pt0_z ... pt477_z | bs_jawOpen ... | mat0 ... mat15
```

という形の DataFrame を返すので、時系列分析や機械学習用の特徴量作成にそのまま使えます。

### Node.js (>= 18)

```bash
node utils/decode.mjs qids-j_landmarks_20260417_142530.json.gz
```

`decode.mjs` は追加の npm 依存なしで動きます。特定 blendshape の時系列を取り出したいときは:

```js
import { blendshapeSeries } from './utils/decode.mjs';
const smile = blendshapeSeries(doc, 'mouthSmileLeft');
// => [[t1, 0.12], [t2, 0.14], ...]
```

### 手動展開（zcat / gunzip）

```bash
gunzip qids-j_landmarks_20260417_142530.json.gz      # → .json が残る
# または
zcat  qids-j_landmarks_20260417_142530.json.gz | jq .meta
```

## サイズの目安

- 5 分間・30 fps・478 点 3D + 52 blendshape + 4×4 matrix
- 非圧縮 JSON: 約 **100–120 MB**
- gzip 圧縮後 : 約 **12–18 MB** （アプリが直接書き出す `.json.gz`）

# ML パイプライン（前処理 → 特徴量 → 学習）

抑うつスクリーニングの**二値分類**（臨床的に有意か否か）を、ECG/HRV・顔・被験者背景から
予測するための、データ準備と学習の指針。問診の**回答そのものは特徴に使わない**
（スコアの定義に等しく、リーク/循環になる）。X は生理・顔・背景、y はスコア由来のラベル。

## パイプライン全体（4 段）

| 段 | 何を | 産物 | 状態 |
|----|------|------|------|
| **A 収集** | アプリで rest→回答→rest を計測 | `data/<session>.csv`(ECG連続) / `.mp4` / `.session.json`(回答+phases+HRV) | ✅ 稼働中 |
| **B 顔抽出** | 各動画→478点+52blendshape+頭姿を抽出し**セッション毎に保存** | `data/<session>.landmarks.json(.gz)` | ⛔ 未実装（下記） |
| **C 特徴表** | 全セッションを 1 行/セッションに集約 | `data/dataset.csv` | ✅ `build_dataset.py` |
| **D 学習** | 被験者単位 CV で二値分類 | モデル/評価 | ⏳ データが揃ってから |

> 生データ（CSV/動画）は**消さない**。特徴設計は反復するので、いつでも再計算できるよう原本を保持。

## C. 特徴表の作成

```bash
python ml/build_dataset.py     # data/*.session.json → data/dataset.csv（pandas 不要）
```

1 行 = 1 セッション。主な列:
- **背景**: age_band / sex / sleep / caffeine / exercise / medication（睡眠・カフェイン・服薬は HRV の**交絡**。特徴かつ対照）
- **ラベル**: `label_clinically_significant`（total ≥ cutoff）。`CUTOFF` は `build_dataset.py` 冒頭で変更可
  - 既定: **PHQ-9 ≥ 10 / QIDS-J ≥ 11**（中等度以上＝臨床的に有意）。「何らかの抑うつ」なら PHQ-9≥5 / QIDS-J≥6 に。
- **HRV 特徴**: `all_*`(全体) と、phases があれば `pre_* / task_* / post_*`
  - **相位間差分**: `react_*`(task−rest_pre, 反応性) と `recov_*`(rest_post−rest_pre, 回復) ← 抑うつで鈍化しやすく判別力が高い
- **QC 列**: `ecg_samples / qc_hrv_plausible / qc_enough_beats / usable_for_ecg_ml / has_faces / has_phases`

### ⚠ QC（収集データの落とし穴）
初回の 4 セッションで判明:
- **RMSSD が 300〜750ms**（正常 ~20–50ms）= RRI の漏搏/異位搏伪迹。**電極の接触不良が主因**。
  対策: 装着位置（`assets/ecg-pad-placement.png`）厳守 → 開始前に**無線受信テスト**で波形/HR を確認 →
  解析側に**異位搏補正**（生理範囲外 RRI の除去/補間）を入れる。
- `usable_for_ecg_ml=0` の行は**解析から除外**すること。

## B. 顔特徴の抽出（`extract_faces.py`）

各 `data/<session>.mp4` を MediaPipe FaceLandmarker に通し、フレーム毎に
**52 ブレンドシェイプ + 頭部姿勢(yaw/pitch/roll)** を `data/<session>.landmarks.json.gz` に保存する。

MediaPipe は Python 3.9–3.12 のみ対応（本機の 3.14 は不可）。uv で隔離した 3.12 venv を使う:

```bash
python -m pip install uv
python -m uv venv ml/.venv --python 3.12
python -m uv pip install --python ml/.venv mediapipe opencv-python

# 満血版（推奨）: ネイティブfps + 478点(float16 npz) + 4並列。10本 ~1.2h / ~0.7GB
ml/.venv/Scripts/python.exe ml/extract_faces.py --fps 0 --landmarks --workers 4 --force
# 軽量版: 15fps・blendshapeのみ（相位集約には十分）
ml/.venv/Scripts/python.exe ml/extract_faces.py --fps 15
# テスト: 1本を先頭15秒だけ
ml/.venv/Scripts/python.exe ml/extract_faces.py --sessions <name> --fps 0 --max-seconds 15
```

`--fps 0`=ネイティブ（全フレーム, 微表情/瞬目を保持）。`--landmarks`=478×3 を `<session>.points.npz`
(float16) に保存（build_dataset は blendshape を使うので必須ではない・将来の幾何特徴用）。`--workers N`=並列。

抽出後 `build_dataset.py` が `sync.recorderStartIso` でフレーム t（動画時間）を壁時計に直し、
phases の窓に割当てて**相位別の顔特徴**を算出（`face_<phase>_*`）+ 反応性差分（`face_react_*`）。
特徴: 表出量 expressivity（全 blendshape の時間 std 平均）・瞬目 blink・笑顔 smile・眉 browInnerUp/browDown・
開口 jawOpen・しかめ mouthFrown・頭部運動 head_move・追跡率 track_rate。**抑うつでの表出減弱**を意識した最小セット。
`rest_pre` を基線とした task 反応性が判別の主軸。

## D. 学習（小サンプル・二値）の指針

- **評価は被験者単位**: LOSO（leave-one-subject-out）/ GroupKFold。同一人物を train/test に跨らせない（最大の落とし穴）。
- **モデルは単純に**: 正則化ロジスティック回帰・RandomForest・勾配ブースティング。N が数百になるまで深層/系列モデルは過学習。
- **多模態は late fusion**（モダリティ毎に予測→結合）。
- **ベースライン対照**: 多数派予測・「背景のみ」モデル。生理・顔がそれらを上回って初めて意味がある。
- **交絡の確認**: 陽性群が高齢/服薬に偏ると、モデルがそれを学ぶ。背景で層別/調整。
- **クラス不均衡**: class_weight / 適切な閾値、指標は AUROC・PR-AUC・感度/特異度（accuracy 単独は不可）。
- **相位の解釈**: `task` は「敏感な設問を読む反応」、`rest_*` は安静時の trait/state。両方を特徴に。

## いま訓練できない理由（このデータで確認済み）
1. ラベルが**一クラス**（陽性 0 例）→ まず臨床的に有意な被験者を集める。
2. **ECG 伪迹**で HRV が無意味 → 装着/接触を改善し、異位搏補正を入れる。
3. **顔特徴未抽出**（Stage B 未実装）。

→ 当面は「収集の品質を上げつつ `build_dataset.py` で表を育て、QC で使えるセッションを見極める」段階。
N とクラスが揃ったら D（LOSO ベースライン）を追加する。

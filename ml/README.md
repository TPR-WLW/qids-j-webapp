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

## B. 顔特徴の抽出（未実装の隙間）

現状、landmark 抽出は `analyze.html` での**手動/単発**で、セッション毎ファイルとして `data/` に残らない。
ML では全動画を**バッチ抽出**して `data/<session>.landmarks.json(.gz)` を作る必要がある（要 MediaPipe）。
抽出後、相位別の顔特徴（blendshape の mean/std/変化率・瞬目率・頭部運動量、**中性基線/ rest_pre で基線補正**）を
`build_dataset.py` に結合する（`_faces_path` と `has_faces` が結合点）。

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

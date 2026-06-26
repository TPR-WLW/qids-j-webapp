# PPG（ESP32 / Web Bluetooth）統合 — 設計と実装メモ

QIDS-J/PHQ-9 セルフチェックに、心率（HR/HRV）の測定デバイスを **選択式** で追加した。
従来の **myBeat（ECG・本地サーバ経由）** に加え、**ESP32-C6 + MAX30102 の PPG センサー
（ブラウザ Web Bluetooth 直結）** を使えるようにし、**PPG のみ / myBeat のみ / 両方** を
被験者情報画面で選べる。

> 由来: ESP32 ファーム/Web は `xiao-esp32c6-max30102-hrv`（`max30102_ble/` + `web/index.html`）。
> 固件は無改造で再利用。アルゴリズム（ピーク検出・RR・時域 HRV・SpO₂）は web 版から移植。

---

## 1. アーキテクチャ

2 つの心率源は transport が全く異なるため、**ブラウザ側で `HeartHub` が抽象化**する：

```
                    HeartHub (js/heart/hub.js)
   設備選択 UI ─────►  enabled:{ecg,ppg}
   PPG / myBeat / 両方   ├ 共有イベント時間線 (Date.now())：question_enter / rest_* …
                        ├ start()/stop()/保存 を有効源へ分配
                        └ 実時間叠加層（HR/HRV、PPG は SpO₂ も）
                              │                         │
              EcgSource (js/heart/ecg.js)     PpgSource (js/heart/ppg.js)
               = 既存 /api/* （server.py）       = Web Bluetooth (XIAO-HR)
               myBeat / WHS-1（Windows SDK）     MAX30102 100Hz 生波形 → 全算法は JS
```

**時間線の統一（要）**：ECG は CSV の `host_time_iso`（墙钟）、PPG は検出した各心拍に
`Date.now()` を付与。両者とも `Date.now()` 基準なので、`buildSegments()`/`buildRestSegments()`
で作る設問区間・安静区間を、サーバ側で **同一の HRV 解析** に通せる。

---

## 2. 採った方針（推奨デフォルト）

| 論点 | 採用 |
|---|---|
| PPG の transport | **ブラウザ Web Bluetooth**（既存 JS 資産を流用・クロスプラットフォーム） |
| PPG データの保存 | **サーバ保存**（`/api/save-session` を拡張、ECG と同じ `session.json` に統合）。サーバ無し時はブラウザDLにフォールバック |
| 生 IR/RED 波形 | **保存する**（`<session>.ppg_raw.csv`・後追いで検出器を再調整可能） |
| 「両方」時の HR 表示 | **両源を並列表示**（叠加層に ECG/PPG の 2 ブロック） |

PPG はブラウザ完結なので **myBeat と違い Windows/UTWS 不要**。`server.py` は mac/Linux でも
起動でき（UTWS は遅延ロード）、PPG の保存・設問別 HRV 算出が可能。

---

## 3. データフロー / 保存物

`/api/save-session` の payload に以下を追加：

```jsonc
{
  "sources": { "ecg": false, "ppg": true },
  "ppg": {
    "beats": [ { "t": <epochMs>, "rri": <ms> }, ... ],   // 検出心拍
    "raw":   { "idx": [...], "ir": [...], "red": [...] }   // 100Hz 生波形
  }
}
```

サーバ（`server.py: save_session`）は PPG 心拍を **ECG と同構の RRI 行**
（`host_time_iso, ecg_raw=RRI, ecg_mode_label='rri', sampling_freq=1`）へ変換し、
既存の `hrv_metrics` / `per_question_hrv` / `build_phases` を **そのまま再利用** して算出する。

出力（`data/<session>.*`）：
- `<session>.session.json` … 既存項目に加え `sources` / `ppg`（hrv/frequency/autonomic）
  / `ppg_per_question_hrv` / `ppg_rest_hrv` / `ppg_phases` を追加
- `<session>.ppg.csv` … RRI 行（再解析可能）
- `<session>.ppg_raw.csv` … `idx,ir,red`（生波形）

サーバ無し（GitHub Pages 等で PPG のみ）の場合は、ブラウザが
`<session>.session.json`（生波形は要約）+ `<session>.ppg_raw.csv` をダウンロード保存する。

---

## 4. 変更ファイル

新規：
- `js/heart/ppg.js` … PpgSource（Web Bluetooth + ピーク検出 + HRV + SpO₂、ESP32 web 版から移植）
- `js/heart/ecg.js` … EcgSource（既存の `/api/*` 採集/実時間ロジックを抽出）
- `js/heart/hub.js` … HeartHub（共有時間線・分配・叠加層・保存ペイロード）

改修：
- `index.html` … 被験者画面に **計測デバイス選択**（myBeat/PPG）+ **PPG 接続/信号テスト/脈波プレビュー**、
  叠加層を多源対応に、心率スクリプトを読み込み、関連 CSS
- `js/app.js` … `ECG.*` を `HeartHub.*` / `EcgSource.*` へ置換、デバイス選択の配線、
  `autoSave` に PPG ペイロード添付 + サーバ無し時のクライアントDLフォールバック
- `server/server.py` … `save_session` に PPG 受領・CSV 書出・設問別/相別 HRV を追加
- `server/mybeat/analysis.py` … 変更なし（RRI 行をそのまま再利用）

**ESP32 ファームは無改造。**

---

## 5. 使い方

1. （myBeat / 両方を使う場合）`start.bat`（Windows）または `python3 server/server.py` で起動。
   PPG のみなら静的配信（`python -m http.server` / GitHub Pages）でも可。
2. 被験者情報画面で **計測デバイス** を選択。
   - PPG：**「PPG 接続」→ `XIAO-HR` を選択 → 指先を光窓に当てて「信号テスト」**で受信確認。
   - myBeat：右上の ECG ペアリングで従来通り。
3. そのまま同意 → 安静（前）→ 回答 → 安静（後）→ 結果。心拍は自動で記録・保存。

> Web Bluetooth は **Chrome / Edge**、かつ **HTTPS か localhost** が必要（`server.py` は
> `127.0.0.1` 配信なので条件を満たす）。Safari / Firefox は非対応。

---

## 6. 検証済み

- 4 つの JS（ppg/ecg/hub/app）構文 OK、`app.js` の全 `$('id')` 参照が index.html に存在。
- `server.py` は mac でも import/起動可能（UTWS 遅延ロード）。
- `/api/save-session` に PPG payload を POST → `session.json` / `ppg.csv` / `ppg_raw.csv`
  生成、設問別 HRV・安静相・phases を算出（合成心拍で結合テスト済み）。
- ブラウザ（http.server 配信）で全グローバル初期化・デバイス選択切替・共有時間線・
  保存ペイロード構築をシミュレートし、コンソールエラーなしを確認。
- **未検証（要実機）**：実際の XIAO-HR との BLE 接続・受信、両源同時の長時間記録。

---

## 7. 今後（任意）

- `analyze.html` / `server/ecg_dashboard` に PPG 波形・HRV パネルを追加（表示面の充実）。
- 生波形 POST の圧縮（現状 JSON 配列。localhost なら実用上問題なし）。
- PPG の周波数 HRV（LF/HF）は短時間だと不安定 → 安静相（3分）で主に利用。

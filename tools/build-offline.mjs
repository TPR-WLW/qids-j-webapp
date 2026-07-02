/**
 * tools/build-offline.mjs — 単一ファイル版（オフライン配布用）をビルドする。
 *
 * index.html の外部参照（css/style.css、surveys/bank.js、js/*.js、assets/ 画像）を
 * すべてインライン化し、dist/qids-j-standalone.html を生成する。
 * 生成物は 1 ファイルだけで完結：USB 等で配布し、ダブルクリック（file://）で
 * PHQ-9/QIDS-J + PPG + カメラ録画 + 安静時間の全フローが動く（保存は自動DL）。
 *
 * 使い方:
 *   node tools/gen-survey-bank.mjs   # surveys/*.json を変更した場合は先に実行
 *   node tools/build-offline.mjs
 *
 * 注意:
 *   ・ECG（myBeat）と事後のランドマーク解析はサーバ/ES module が必要なため対象外。
 *   ・JS 内に "</script>" が現れるとインラインが壊れるため <\/script> にエスケープする。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('index.html');

// 1) CSS をインライン化
const css = read('css/style.css');
html = html.replace(
  /<link rel="stylesheet" href="css\/style\.css">/,
  () => `<style>\n/* === inlined: css/style.css === */\n${css}\n</style>`
);

// 2) 各 <script src> をインライン化（順序は index.html のまま）
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  const js = read(src).replace(/<\/script/gi, '<\\/script');
  return `<script>\n/* === inlined: ${src} === */\n${js}\n</script>`;
});
if (/<script src=/.test(html)) throw new Error('未処理の <script src> が残っています');

// 3) assets/ 画像を data URI 化（ECG 電極貼付ガイド等）
html = html.replace(/src="(assets\/[^"]+\.(png|jpe?g|webp))"/g, (m, p, ext) => {
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const b64 = fs.readFileSync(path.join(root, p)).toString('base64');
  return `src="data:${mime};base64,${b64}"`;
});

// 4) 生成物であることをヘッダに明記
html = html.replace(
  /<head>/,
  `<head>\n<!-- ⚠ 自動生成ファイル（node tools/build-offline.mjs）。直接編集せず、元ファイルを編集して再ビルドすること。 -->`
);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'qids-j-standalone.html');
fs.writeFileSync(out, html);
console.log('wrote', path.relative(root, out), '—', (fs.statSync(out).size / 1024).toFixed(0) + ' KB');

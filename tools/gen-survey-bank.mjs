/**
 * tools/gen-survey-bank.mjs — surveys/bank.js を surveys/*.json から再生成する。
 *
 * bank.js は file://（index.html ダブルクリック起動）用の質問票インライン版。
 * surveys/*.json を追加・変更したら必ずこれを実行して bank.js を同期させること:
 *   node tools/gen-survey-bank.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'surveys');

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const files = {};
for (const s of manifest.surveys) files[s.file] = JSON.parse(fs.readFileSync(path.join(dir, s.file), 'utf8'));

const out = `/**
 * surveys/bank.js — 質問票バンク（file:// 用インライン版・自動生成）
 *
 * index.html をダブルクリック（file://）で開くと fetch が同一オリジン制約で失敗するため、
 * surveys/*.json をこのファイルに内联して survey.js のフォールバックに使う。
 * http 配信時は従来どおり fetch が優先される（このファイルは読まれるが未使用）。
 *
 * 再生成（surveys/*.json を変更したら実行）:
 *   node tools/gen-survey-bank.mjs
 */
window.SURVEY_BANK = ${JSON.stringify({ manifest: manifest.surveys, files }, null, 2)};
`;
fs.writeFileSync(path.join(dir, 'bank.js'), out);
console.log('wrote surveys/bank.js —', manifest.surveys.map(s => s.file).join(', '));

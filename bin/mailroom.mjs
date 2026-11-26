#!/usr/bin/env node
// 電子報櫃台指令入口。預設值（名單、寄件人、樣板…）放在一個設定模組，用 --config <路徑> 或環境變數 MAILROOM_CONFIG 指定；
// 模組的 default export 是 CliDefaults。沒給就只能用命令列旗標。
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
// 原始碼資料夾裡（有 src）優先用 src，免得打包留下的舊 dist 蓋過最新的程式；裝成套件時沒有 src，用建置好的 JS（Node 不替 node_modules 裡的 .ts 去除型別）。
import { existsSync } from 'node:fs';
const srcMain = new URL('../src/cli/main.ts', import.meta.url);
const main = existsSync(srcMain) && !import.meta.url.includes('/node_modules/') ? await import(srcMain.href) : await import('../dist/cli/main.js');
const { runCli } = main;

const argv = process.argv.slice(2);
let cfgPath = process.env.MAILROOM_CONFIG;
const i = argv.indexOf('--config');
if (i !== -1) {
  cfgPath = argv[i + 1];
  argv.splice(i, 2);
}
const defaults = cfgPath ? (await import(pathToFileURL(resolve(cfgPath)).href)).default : {};
process.exitCode = await runCli(argv, {
  defaults,
  env: process.env,
  io: { readFile: (p) => readFile(p, 'utf8'), writeFile: async (p, b) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, b); } },
});

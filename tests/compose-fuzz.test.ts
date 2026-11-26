// 隨機探測的測試本體（產生器與比對在 compose-fuzz-helpers.ts）。
// 份數：環境變數 MAILROOM_FUZZ_N（CI 跑預設的小量；本機驗收跑 24000 以上），亂數種子 MAILROOM_FUZZ_SEED（固定，重跑結果一樣）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOne, runFuzz } from './compose-fuzz-helpers.ts';
import { parseMarkdown } from '../src/compose/markdown.ts';

const N = Number(process.env.MAILROOM_FUZZ_N ?? 1500);
const SEED = Number(process.env.MAILROOM_FUZZ_SEED ?? 20261126);

const show = (xs: { src: string; info: string }[]) =>
  [...xs]
    .sort((a, b) => a.src.length - b.src.length)
    .slice(0, 5)
    .map((v) => `${v.info}\n  ${JSON.stringify(v.src)}`)
    .join('\n');

test(`隨機探測：${N} 份（種子 ${SEED}），三條不變式零違反`, () => {
  const st = runFuzz(N, SEED);
  console.log(`fuzz n=${st.n} seed=${SEED} errored=${st.errored} I1=${st.i1.length} I2=${st.i2.length} I3=${st.i3.length}`);
  assert.equal(st.i1.length, 0, `I1 違反：\n${show(st.i1)}`);
  assert.equal(st.i2.length, 0, `I2 違反：\n${show(st.i2)}`);
  assert.equal(st.i3.length, 0, `I3 違反：\n${show(st.i3)}`);
  // 擋下的比例要合理：全部都擋就沒意義了
  assert.ok(st.errored < st.n * 0.6, `被擋比例過高：${st.errored}/${st.n}`);
});

// ───────── 五輪覆核留下的每一個反例＋本輪探測找到的寫法：固定下來，跟參照渲染器比對 ─────────
// r1～r5＝第一到第五輪覆核的反例（改寫成 BODY／CMT／CODE 記號，方便自動比對）；「本輪」＝這次改寫時隨機探測或推敲出來的；「審查」＝合併前對抗審查找到的；「複審」＝修完後第二次審查找到的。
// 名稱、原稿（只有正文）、預期：null＝正確處理（不記 error），字串＝必須記這個 error 擋下
const REVIEW_CASES: [string, string, string | null][] = [
  ['r1 沒收尾註解', 'BODY1X\n\n<!-- CMT2X\n\nBODY3X', 'unclosed_comment'],
  ['r1 沒收尾框', 'BODY1X\n\n```\nCODE2X\n\nBODY3X', 'unclosed_fence'],
  ['r2 段落下一行', 'BODY1X\n<!-- CMT2X -->\nBODY3X', null],
  ['r2 清單內', '- BODY1X\n  <!-- CMT2X -->\n- BODY3X', null],
  ['r2 清單後頂格', '- BODY1X\n<!-- CMT2X -->\n- BODY3X', null],
  ['r2 行內', 'BODY1X <!-- CMT2X --> BODY3X', null],
  ['r2 跨行', 'BODY1X\n<!-- CMT2X\nCMT3X -->\nBODY4X', null],
  ['r2 連續多個', '<!-- CMT1X --><!-- CMT2X -->\nBODY3X<!-- CMT4X -->BODY5X<!-- CMT6X -->', null],
  ['r2 段落中沒收尾', 'BODY1X\nBODY2X <!-- CMT3X\nBODY4X', 'unclosed_comment'],
  ['r2 清單中沒收尾', '- BODY1X <!-- CMT2X\n- BODY3X', 'unclosed_comment'],
  ['r2 收尾後又沒收尾', '<!-- CMT1X -->\n<!-- CMT2X\nBODY3X', 'unclosed_comment'],
  ['r2 框內', '```\n<!-- CODE1X -->\n```\nBODY2X', null],
  ['r2 波浪框內', '~~~html\n<!-- CODE1X -->\n~~~', null],
  ['r2 行內碼開頭', 'BODY1X `<!--` BODY2X\n\nBODY3X', null],
  ['r2 縮排碼', 'BODY1X\n\n    <!-- CODE2X -->\n\nBODY3X', null],
  ['r2 註解含框記號', '<!--\n```\n-->\nBODY1X', null],
  ['r2 註解含 --', '<!-- CMT1X -- CMT2X --->\nBODY3X', null],
  ['r2 空註解', '<!---->\nBODY1X', null],
  ['r2 最短註解', '<!-->\nBODY1X', null],
  ['r2 巢狀清單框', '- BODY1X\n  - BODY2X\n\n        ```\n        <!-- CODE3X -->\n        ```\n', null],
  ['r2 清單框', '- BODY1X\n\n  ```\n  <!-- CODE2X -->\n  ```\n', null],
  ['r2 引言', '> BODY1X\n> <!-- CMT2X -->\n> BODY3X', null],
  ['r3 兩段行內碼之間', 'BODY1X `<!--` BODY2X `-->` BODY3X', null],
  ['r3 跨段落', 'BODY1X `<!--` BODY2X\n\nBODY3X\n\nBODY4X `-->` BODY5X', null],
  ['r4 引言框後的註解', '> ```\n> CODE1X\n> ```\n\nBODY2X <!-- CMT3X --> BODY4X\n\n<!--\nCMT5X\n-->\n\nBODY6X', null],
  ['r5 跳脫反引號後註解', 'BODY1X \\` <!-- CMT2X --> BODY3X `CODE4X`', null],
  ['r5 跨行行內碼遇註解行', 'BODY1X `x\n<!-- CMT2X --> y` BODY3X', null],
  ['r5 標題偷程式碼', '# `BODY1X\n`<!--` BODY2X `-->`', null],
  ['r5 清單偷程式碼', '- `BODY1X\n- `<!--` BODY2X `-->` z', null],
  ['r5 清單波浪框', '- ~~~\n  <!-- CODE1X -->\n  ~~~\n\nBODY2X', null],
  ['r5 清單框含空行', '- ```\n  a\n\n  <!-- CODE1X -->\n  ```\n\nBODY2X', null],
  ['r5 成對反斜線', 'BODY1X \\\\`x <!-- CODE2X --> y` BODY3X', null],
  ['r5 成對反斜線外露', 'BODY1X \\\\`a` <!-- CMT2X --> `b` BODY3X', null],
  ['r5 標題偷碼2', '# `BODY1X\n`<!-- CODE2X -->` BODY3X', null],
  ['r5 表格格子', '| a | b |\n|---|---|\n| `x | <!-- CMT1X --> y` | BODY2X |', null],
  ['本輪 清單裡沒收尾註解遇懶惰行', '- <!-- CMT1X\n  - [BODY2X](https://example.com/a)\n``CODE3X ` <!-- CODE4X -->``\n\nBODY5X', 'unclosed_comment'],
  ['本輪 懶惰行像表頭', '2. `\n| `CODE1X mid <!-- CMT2X --> CODE3X` | b |\n|---|---|\n| x | y |', null],
  ['本輪 懶惰行像標題底線', '> BODY1X <!-- CMT2X\nBODY3X -->\n===\nBODY4X', null],
  ['本輪 強調不切開程式碼', '*BODY1X `CODE2X* <!-- CODE3X -->` BODY4X', null],
  ['本輪 --!>', '<!-- CMT1X --!> BODY2X\n-->', 'comment_ambiguous'],
  ['本輪 4 個反引號框', '````\n```\n<!-- CODE1X -->\n````\nBODY2X <!-- CMT3X -->', null],
  ['本輪 框說明有反引號', '```a`b <!-- CMT1X --> BODY2X', null],
  ['本輪 段落後 setext 前註解', 'BODY1X <!-- CMT2X\n===\nBODY3X -->', 'unclosed_comment'],
  ['本輪 div 後沒空行', '<div>\n`BODY1X <!-- CMT2X -->`\n</div>', 'unsupported_html'],
  ['審查 單獨一行的 <em>', '<em>\n`<!-- CMT1X -->`\n</em>', 'unsupported_html'],
  ['審查 單獨一行的 <br>', '<br>\n`<!-- CMT1X -->`', 'unsupported_html'],
  ['審查 單獨一行的 <a>', '<a href="https://example.com/a">\n`BODY1X <!-- CMT2X -->`\n</a>', 'unsupported_html'],
  ['審查 引言後 tab', '>  \t<!-- CMT1X -->\n\nBODY2X', null],
  ['審查 引言後直接 tab', '>\t<!-- CMT1X -->\n\nBODY2X', null],
  ['審查 引言清單後 tab', '> - \t<!-- CODE1X -->', null],
  ['審查 表頭沒有 |', 'BODY1X\n| --- |\n    CODE2X <!-- CODE3X -->', null],
  ['審查 表頭沒有 | 加註解', 'BODY1X\n:-- |\n`a | <!-- CMT2X --> b`', null],
  ['審查 懶惰續行遇標籤行', '- BODY1X <!-- CMT2X\n<span>\nBODY3X -->', 'unclosed_comment'],
  ['審查 引言裡標籤行後接縮排碼', '> <br>\n    CODE1X <!-- CODE2X -->', 'unsupported_html'],
  ['審查 <? 偽註解', 'BODY1X <?x CMT2X ?> BODY3X', 'unsupported_html'],
  ['審查 <!X 偽註解', '<!X CMT1X>\n\nBODY2X', 'unsupported_html'],
  ['審查 CDATA', '<![CDATA[\nCMT1X\n]]>\nBODY2X', 'unsupported_html'],
  ['審查 參照式連結定義', '[ref]: https://example.com/x "CMT1X"\n\nBODY2X', 'unsupported_syntax'],
  ['複審 清單項目不當表頭', '1. BODY1X\n--- |\n`a | <!-- CMT2X --> b`', null],
  ['複審 縮 4 格的分隔列不成表', 'BODY1X\n    --- |\n`a | <!-- CMT2X --> b`', null],
  ['複審 清單後的分隔列', '- BODY1X\n--- |\n<!-- CMT2X -->', null],
  ['複審 分隔列本身是清單項目', '1. | |\n- | ---\n\t<!-- CMT1X -->', null],
  ['複審 >> 後 tab', '>>\t<!-- CMT1X -->', null],
  ['複審 >>> 後 tab', '>>>\t<!-- CMT1X -->', null],
  ['複審 清單裡 > 後 tab', '- >\t<!-- CMT1X -->', null],
  ['複審 清單續行的 tab 從內層起算', '- BODY1X\n\n  \t<!-- CMT2X -->', null],
  ['複審 引言裡兩個 tab 是程式碼', '> BODY1X\n\n>\t\tCODE2X <!-- CODE3X -->', null],
  ['複審 註解後同一行的偽註解', '<!-- CMT1X --> <?x CMT2X ?> BODY3X', 'unsupported_html'],
  ['複審 沒被引用的腳註定義', '[^1]: CMT1X footnote', 'unsupported_syntax'],
  ['複審 有被引用的腳註', 'BODY1X[^1]\n\n[^1]: BODY2X', null],
  ['複審 清單裡 tab 開頭的註解行，後面的正文要留著', '- BODY1X\n\n  \t<!-- CMT2X -->BODY3X', null],
  ['複審 清單裡 tab 開頭的空註解', '- BODY1X\n\n  \t<!---->BODY2X', null],
  ['複審 標題裡的圖片替代文字', '- # ![ BODY1X ](https://example.com/x)', null],
  ['複審 替代文字裡有標籤字樣', '> ![ BODY1X </em> x](https://example.com/x) <!-- CMT2X -->', null],
  ['複審 縮排碼後不從 1 開始的有序清單', '\t<!--CODE1X-->\n2)     <!--CMT2X--> BODY3X', null],
];

test('程式碼裡的 tab 原樣保留（Go、Makefile）', () => {
  const code = (src: string) => JSON.stringify(parseMarkdown(src).blocks);
  assert.match(code('```go\nfunc f() {\n\tfmt.Println(1)\n}\n```'), /\\tfmt/);
  assert.match(code('\t\tx := 1'), /"\\tx := 1"/);
  assert.match(code('```\n-\tx\n```'), /"-\\tx"/);
  assert.match(code('- a\n\n  ```\n  \tb\n  ```'), /"\\tb"/);
});

test('覆核反例：每一個都正確處理或記 error，且結果與網站（參照渲染器）一致', () => {
  for (const [name, body, expected] of REVIEW_CASES) {
    const r = checkOne(body);
    assert.deepEqual(r.violations, [], `${name}：違反不變式`);
    if (expected === null) assert.deepEqual(r.errors, [], `${name}：應該正確處理、不擋`);
    else assert.ok(r.errors.includes(expected), `${name}：應該記 ${expected}，實際 ${r.errors.join(',') || '（沒有 error）'}`);
  }
});

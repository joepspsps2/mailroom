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
// r1～r5＝第一到第五輪覆核的反例（改寫成 BODY／CMT／CODE 記號，方便自動比對）；「本輪」＝這次改寫時隨機探測或推敲出來的；「審查」＝合併前對抗審查找到的；「複審」＝修完後第二次審查找到的；「三審」～「六審」＝第三到六次審查找到的。
// 名稱、原稿（只有正文）、預期：null＝正確處理（不記 error），字串＝必須記這個 error 擋下
// 行首結構用 tab 的寫法（引言 > 後、清單記號後、清單續行）一律擋下：主站沒有這種文章，網站的 tab 換算判不準
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
  ['審查 引言後 tab', '>  \t<!-- CMT1X -->\n\nBODY2X', 'unsupported_syntax'],
  ['審查 引言後直接 tab', '>\t<!-- CMT1X -->\n\nBODY2X', 'unsupported_syntax'],
  ['審查 引言清單後 tab', '> - \t<!-- CODE1X -->', 'unsupported_syntax'],
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
  ['複審 分隔列本身是清單項目', '1. | |\n- | ---\n\t<!-- CMT1X -->', 'unsupported_syntax'],
  ['複審 >> 後 tab', '>>\t<!-- CMT1X -->', 'unsupported_syntax'],
  ['複審 >>> 後 tab', '>>>\t<!-- CMT1X -->', 'unsupported_syntax'],
  ['複審 清單裡 > 後 tab', '- >\t<!-- CMT1X -->', 'unsupported_syntax'],
  ['複審 清單續行的 tab 從內層起算', '- BODY1X\n\n  \t<!-- CMT2X -->', 'unsupported_syntax'],
  ['複審 引言裡兩個 tab 是程式碼', '> BODY1X\n\n>\t\tCODE2X <!-- CODE3X -->', 'unsupported_syntax'],
  ['複審 註解後同一行的偽註解', '<!-- CMT1X --> <?x CMT2X ?> BODY3X', 'unsupported_html'],
  ['複審 沒被引用的腳註定義', '[^1]: CMT1X footnote', 'unsupported_syntax'],
  ['複審 有被引用的腳註', 'BODY1X[^1]\n\n[^1]: BODY2X', null],
  ['複審 清單裡 tab 開頭的註解行，後面的正文要留著', '- BODY1X\n\n  \t<!-- CMT2X -->BODY3X', 'unsupported_syntax'],
  ['複審 清單裡 tab 開頭的空註解', '- BODY1X\n\n  \t<!---->BODY2X', 'unsupported_syntax'],
  ['複審 標題裡的圖片替代文字', '- # ![ BODY1X ](https://example.com/x)', null],
  ['複審 替代文字裡有標籤字樣', '> ![ BODY1X </em> x](https://example.com/x) <!-- CMT2X -->', null],
  ['三審 腳註只在程式碼裡被引用', '`[^a]`\n\n[^a]: CMT1X', 'unsupported_syntax'],
  ['三審 腳註只在註解裡被引用', '<!-- [^a] -->\n\n[^a]: CMT1X', 'unsupported_syntax'],
  ['三審 腳註只在網址裡被引用', '[x](https://example.com/[^a])\n\n[^a]: CMT1X', 'unsupported_syntax'],
  ['三審 跳脫的腳註引用', '\\[^a]\n\n[^a]: CMT1X', 'unsupported_syntax'],
  ['三審 引言裡的腳註定義', '> [^a]: CMT1X', 'unsupported_syntax'],
  ['三審 清單裡的腳註定義', '- [^a]: CMT1X', 'unsupported_syntax'],
  ['三審 重複的腳註定義', '[^a]\n\n[^a]: BODY1X\n\n[^a]: CMT2X', 'unsupported_syntax'],
  ['三審 引用只在定義的續行', '[^a]: CMT1X\n[^a]', 'unsupported_syntax'],
  ['三審 標籤有空白的腳註', '[^a b]\n\n[^a b]: CMT1X', 'unsupported_syntax'],
  ['三審 腳註標籤不分大小寫', 'BODY1X[^A]\n\n[^a]: BODY2X', null],
  ['三審 > 不接空格的清單 tab', '>1. \t<!-- CODE1X -->', 'unsupported_syntax'],
  ['三審 > 不接空格、沒收尾註解', '>2.\t <!--CMT1X', 'unclosed_comment'],
  ['三審 縮一格的 >> 後 tab', ' >>\t CODE1X <!-- CODE2X -->', 'unsupported_syntax'],
  ['三審 打斷段落的清單裡不是 1 開頭', 'BODY1X\n- 2.      <!--CMT2X--> BODY3X', null],
  ['三審 打斷段落的引言裡不是 1 開頭', 'BODY1X\n> 2.      <!--CMT2X--> BODY3X', null],
  ['三審 打斷段落的清單裡的引言', 'BODY1X\n- > 2.      <!--CMT2X--> BODY3X', null],
  ['三審 縮排碼後的空清單項目', '    CODE1X\n\n-\n      <!--CMT2X--> BODY3X', null],
  ['三審 引言裡 tab 縮排的分隔列', '>BODY1X|BODY2X\n>\t  -|-\n\t<!-- CODE3X -->', 'unsupported_syntax'],
  ['三審 清單記號後 tab 的程式碼', '1)\t\t\tCODE1X <!-- CODE2X -->', 'unsupported_syntax'],
  ['三審 清單記號後空格加 tab 的程式碼', '2.     \tCODE1X <!-- CODE2X -->', 'unsupported_syntax'],
  ['三審 段落後一行的腳註定義', 'BODY1X[^f]\n[^f]: BODY2X', 'unsupported_syntax'],
  ['三審 縮一格的腳註定義', 'BODY1X[^f]\n\n [^f]: BODY2X', 'unsupported_syntax'],
  ['三審 連續兩個腳註定義都有引用', 'BODY1X[^a] BODY2X[^b]\n\n[^a]: BODY3X\n[^b]: BODY4X', null],
  ['三審 連續定義的第二個沒引用', 'BODY1X[^a]\n\n[^a]: BODY2X\n[^b]: CMT3X', 'unsupported_syntax'],
  ['三審 腳註定義被當成標題', '[^f]: CMT1X\n  ===\n\nBODY2X', 'unsupported_syntax'],
  ['三審 清單裡收尾的框不是新框', '* ```\n  ```\n [^f]: CMT1X', 'unsupported_syntax'],
  ['三審 表格遇到不從 1 開始的清單就結束', '| BODY1X |\n| --- |\n| BODY2X |\n2. BODY3X\n\nBODY4X | BODY5X', null],
  ['三審 表格後清單裡沒收尾的框', '| BODY1X |\n| --- |\n| BODY2X |\n2.  ~~~\n  BODY3X | BODY4X', 'unclosed_fence'],
  ['三審 偽註解吞掉圖片的網址', '> | ![ `CODE1X` `` <?x> CMT2X ](https://example.com/x)  | ?> |', 'unsupported_html'],
  ['四審 多段腳註的縮排續段', 'BODY0X[^1]\n\n[^1]: BODY1X\n\n    <!-- CMT2X -->', 'unsupported_syntax'],
  ['四審 註解裡的假程式碼框不影響腳註檢查', '<!-- CMT1X\n```\n-->\n\nBODY2X\n\n[^1]: CMT3X', 'unsupported_syntax'],
  ['四審 實體字不算腳註引用', 'BODY0X &#91;^1]\n\n[^1]: CMT1X', 'unsupported_syntax'],
  ['四審 角括號網址裡不算腳註引用', 'BODY0X <https://example.com/[^1]>\n\n[^1]: CMT1X', 'unsupported_syntax'],
  ['四審 括號裡跳脫不算腳註引用', 'BODY0X [\\^A]\n\n[^A]: CMT1X', 'unsupported_syntax'],
  ['四審 註解區塊尾巴不算腳註引用', '<!-- CMT0X --> BODY1X [^2]\n\n[^2]: CMT2X', 'unsupported_syntax'],
  ['四審 腳註定義變成標題', '[^a]: CMT1X [^a]\n===', 'unsupported_syntax'],
  ['四審 連結文字裡的腳註引用', '[BODY0X[^1]](https://example.com/BODY1X)\n\n[^1]: BODY2X', 'unsupported_syntax'],
  ['四審 腳註內容是縮排程式碼', 'BODY0X[^1]\n\n[^1]:     <!--CODE1X-->', 'unsupported_syntax'],
  ['四審 清單裡程式碼框的 tab 不擋', '- BODY1X\n\n  ```make\n  all:\n  \tgcc CODE2X\n  ```', null],
  ['四審 引言裡程式碼框的 tab 不擋', '> ```go\n> \tCODE1X\n> ```', null],
  ['四審 正常腳註：強調裡引用、大小寫不同、隔空行', 'BODY1X[^a] *BODY2X[^b]*\n\n[^a]: BODY3X\n[^b]: BODY4X\n\n[^c]: BODY5X\n\nBODY6X[^C]', null],
  ['四審 網址裡的 [^x] 不算腳註引用', 'https://example.com/[^a] BODY1X\n\n[^a]: CMT2X', 'unsupported_syntax'],
  ['四審 只有空白的引言行裡有 tab', 'BODY1X\n> \t\n    CODE2X <!-- CODE3X -->', 'unsupported_syntax'],
  ['四審 腳註定義後直接接表格', '[^a]: CMT1X\n| BODY2X[^a] | b |\n|---|---|', 'unsupported_syntax'],
  ['四審 腳註後空行再接縮 3 格的行', 'BODY0X[^1]\n\n[^1]: BODY1X\n\n   `CODE2X <!-- CODE3X -->`', 'unsupported_syntax'],
  ['四審 腳註內容又是定義', 'BODY0X[^A]\n\n[^A]: [^1]: CMT1X', 'unsupported_syntax'],
  ['五審 連結後緊接腳註引用', 'BODY0X[來源 BODY1X](https://example.com)[^2]\n\n[^2]: BODY2X', null],
  ['五審 圖片與角括號網址後緊接腳註引用', 'BODY0X ![圖](https://example.com/a.png)[^2] <https://example.com>[^3]\n\n[^2]: BODY1X\n\n[^3]: BODY2X', null],
  ['五審 括號裡 www 網址吃掉腳註引用', 'see (www.example.com)[^1] BODY1X\n\n[^1]: CMT2X', 'unsupported_syntax'],
  ['五審 標籤大小寫折疊 ß＝ss', 'BODY1X [^ss] [^ß]\n\n[^ss]: BODY2X\n\n[^ß]: CMT3X', 'unsupported_syntax'],
  ['五審 腳註內容以 HTML 開頭', 'BODY1X [^a]\n\n[^a]: <!-- --> `<!-- CMT2X -->` BODY3X', 'unsupported_syntax'],
  ['五審 網址後緊接反引號', 'BODY0X https://example.com` <!-- CMT1X --> ` BODY2X', 'unsupported_syntax'],
  ['五審 註解區塊後沒收尾的標籤', '<!-- CMT1X --> <x CMT2X\n\nBODY3X', 'unsupported_html'],
  ['五審 強調裡的網址吃掉腳註引用', '*www.example.com/p*[^a] BODY1X\n\n[^a]: CMT2X', 'unsupported_syntax'],
  ['五審 email 後緊接腳註引用', 'a@example.com_[^a] BODY1X\n\n[^a]: CMT2X', 'unsupported_syntax'],
  ['五審 行內程式碼不跨兩則腳註定義', 'BODY0X[^a] BODY1X[^b]\n\n[^a]: `BODY2X\n[^b]: `CODE3X`', null],
  ['六審 裸網址吞掉後面的連結與腳註引用', '詳見 https://example.com/p，[BODY1X](https://example.com/x)[^1] BODY2X\n\n[^1]: CMT3X', 'unsupported_syntax'],
  ['六審 裸網址吞掉後面的強調與反引號', '來源 https://example.com/p，**BODY1X**`BODY2X` BODY3X', 'unsupported_syntax'],
  ['六審 強調裡的連結被拆開', '*[**BODY1X**](https://example.com)BODY2X*', 'unsupported_syntax'],
  ['收斂 英數字後的網址不做成連結', 'BODY1Xhttps://example.com/pBODY2X BODY3X', null],
  ['收斂 註解把網址截斷', 'https://example.com/p<!-- CMT1X -->BODY2X BODY3X', null],
  ['收斂 網址後強調裡的腳註引用', 'https://example.com/p***~~![^1]** BODY1X\n\n[^1]: CMT2X', 'unsupported_syntax'],
  ['複審 縮排碼後不從 1 開始的有序清單', '\t<!--CODE1X-->\n2)     <!--CMT2X--> BODY3X', 'unsupported_syntax'],
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

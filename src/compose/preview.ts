// 預覽輸出：同一期信產成一組檔案（信件 HTML、純文字、檢查報告、一頁看全部的預覽頁）。純函式，寫檔由呼叫端做。
import type { ComposeResult } from './compose.ts';
import type { PreflightResult } from './preflight.ts';
import { personalize, type RecipientVars } from './personalize.ts';
import { escapeHtml } from './template.ts';

export const SAMPLE_VARS: RecipientVars = {
  name: 'Sample Reader',
  email: 'reader@example.com',
  unsubscribe_url: 'https://example.com/unsubscribe/preview',
  web_url: 'https://example.com/issue/preview',
};

export interface PreviewOptions {
  vars?: RecipientVars;
  /** 範例收件人沒有名字時的樣子也要看＝另外產一份。 */
  withoutName?: boolean;
}

export interface PreviewFiles {
  /** 檔名 → 內容。 */
  files: Record<string, string>;
}

export function buildPreview(c: ComposeResult, check: PreflightResult, opts: PreviewOptions = {}): PreviewFiles {
  const vars = opts.vars ?? SAMPLE_VARS;
  const track = (kind: 'c' | 'o', index?: number) => (kind === 'c' ? `preview-${index}` : 'preview');
  const a = personalize(c, vars, { track });
  const files: Record<string, string> = {
    'email.html': a.html,
    'email.txt': a.text,
    'check.json': JSON.stringify({ ok: check.ok, issues: check.issues, linkStatuses: check.linkStatuses }, null, 2),
    'links.json': JSON.stringify(c.links, null, 2),
  };
  if (opts.withoutName) {
    const b = personalize(c, { ...vars, name: null }, { track });
    files['email-no-name.html'] = b.html;
    files['email-no-name.txt'] = b.text;
  }
  files['index.html'] = previewPage(c, check, a.html, a.text);
  return { files };
}

function previewPage(c: ComposeResult, check: PreflightResult, html: string, text: string): string {
  const rows = check.issues
    .map((i) => `<tr class="${i.severity}"><td>${escapeHtml(i.severity)}</td><td>${escapeHtml(i.code)}</td><td>${escapeHtml(i.message)}${i.where ? ` <code>${escapeHtml(i.where)}</code>` : ''}</td></tr>`)
    .join('');
  const frame = (w: number) => `<iframe sandbox="" style="width:${w}px;height:900px;border:1px solid #bbb;background:#fff" srcdoc="${escapeHtml(html)}"></iframe>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:20px;color:#222}h2{margin:24px 0 8px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:4px 8px;vertical-align:top}tr.error td{background:#fde8e8}tr.warn td{background:#fff6dd}.row{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}pre{white-space:pre-wrap;background:#f5f5f5;padding:12px;max-width:760px}</style></head><body>
<h1>${escapeHtml(c.subject)}</h1>
<p>Preheader: ${escapeHtml(c.preheader)}</p>
<p><strong>${check.ok ? 'Checks passed' : 'Checks FAILED — do not schedule'}</strong> · HTML ${c.htmlBytes} bytes · ${c.links.length} tracked links · ${c.images.length} images</p>
<h2>Checks</h2>${rows ? `<table>${rows}</table>` : '<p>No issues.</p>'}
<h2>Mobile (375px) and desktop (700px)</h2><div class="row">${frame(375)}${frame(700)}</div>
<h2>Plain text</h2><pre>${escapeHtml(text)}</pre>
</body></html>`;
}

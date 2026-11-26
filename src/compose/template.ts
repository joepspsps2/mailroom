// 信件樣板：把「正文」包進頁首／頁尾，變成完整信件。
// 樣板是設定，不是程式：引擎只給一個通用的樣板工廠 createTemplate()，品牌樣板（名稱、頁尾、地址、文案）放私有設定。
// 表格排版＋內嵌 CSS（Outlook 看得到）、深色模式用 class 覆寫（不把底色反白）。

export interface Theme {
  font: string;
  text: string;
  muted: string;
  link: string;
  bg: string;
  card: string;
  border: string;
  accent: string;
  codeBg: string;
  /** 內容寬度（px）。 */
  width: number;
  dark: { bg: string; card: string; text: string; muted: string; link: string; border: string; codeBg: string };
}

export const DEFAULT_THEME: Theme = {
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Noto Sans TC','Microsoft JhengHei',Helvetica,Arial,sans-serif",
  text: '#222222',
  muted: '#6b6b6b',
  link: '#1a56c4',
  bg: '#f3f3f3',
  card: '#ffffff',
  border: '#dddddd',
  accent: '#333333',
  codeBg: '#f5f5f5',
  width: 600,
  dark: { bg: '#111111', card: '#1c1c1c', text: '#e8e8e8', muted: '#a0a0a0', link: '#8ab4f8', border: '#3a3a3a', codeBg: '#262626' },
};

export interface Labels {
  /** 頁首小字連結：「在瀏覽器開啟」。 */
  viewInBrowser: string;
  /** 頁尾退訂連結文字。 */
  unsubscribe: string;
  /** 頁尾「這封信寄給 {email}」；用 {email} 代表位置。 */
  sentTo: string;
  /** 嵌入內容（影片、互動圖表）換成的連結卡文字。 */
  embedCard: string;
  /** 純文字版的圖片標記；alt 為原稿的替代文字。 */
  image: (alt: string) => string;
}

export const DEFAULT_LABELS: Labels = {
  viewInBrowser: 'View in browser',
  unsubscribe: 'Unsubscribe',
  sentTo: 'This email was sent to {email}',
  embedCard: 'This content is best viewed on the website →',
  image: (alt) => (alt ? `[Image: ${alt}]` : '[Image]'),
};

export type FooterLine = string | { text: string; href: string };

export interface TemplateConfig {
  /** 頁首名稱（純文字）。 */
  brandName: string;
  tagline?: string;
  /** 頁首圖示（絕對 https 網址）；沒有就只放名稱。 */
  logoUrl?: string;
  /** <html lang>。 */
  lang?: string;
  theme?: Partial<Theme> & { dark?: Partial<Theme['dark']> };
  labels?: Partial<Labels>;
  /** 正文前的問候語；可含 {{name}}。整段包在 {{#name}} 內，沒有名字就整段不出現。例：「Hi {{name}},」。 */
  greeting?: string;
  /** 頁尾每行（純文字，會被跳脫；{ text, href } 為連結）。 */
  footerLines?: FooterLine[];
  /** 頁尾的自訂區塊（受信任的 HTML，由設定的擁有者提供，不經跳脫；可含 {{web_url}} 等佔位）。放在 footerLines 之前。 */
  footerHtml?: string;
  /** footerHtml 的純文字版（純文字信用）；同樣可含佔位。 */
  footerText?: string;
  /** 退訂連結前面的引導句，例「Don't want these emails?」；沒給就只有連結。 */
  unsubscribeLead?: string;
  /** 實體地址（寄前檢查要求一定有、且不能是待補標記）。 */
  postalAddress: string;
}

export interface TemplateParts {
  subject: string;
  preheader: string;
  bodyHtml: string;
  bodyText: string;
  /** 開信圖網址（含 {{o}} 佔位）；沒開追蹤就是 undefined。 */
  pixelUrl?: string;
}

export interface EmailTemplate {
  theme: Theme;
  labels: Labels;
  postalAddress: string;
  renderHtml(p: TemplateParts): string;
  renderText(p: TemplateParts): string;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\uE000/g, '&#123;');
}

function mergeTheme(t: TemplateConfig['theme']): Theme {
  return { ...DEFAULT_THEME, ...t, dark: { ...DEFAULT_THEME.dark, ...(t?.dark ?? {}) } };
}

export function createTemplate(cfg: TemplateConfig): EmailTemplate {
  const theme = mergeTheme(cfg.theme);
  const labels: Labels = { ...DEFAULT_LABELS, ...cfg.labels };
  const lang = cfg.lang ?? 'en';
  const w = theme.width;
  const d = theme.dark;
  const footer = cfg.footerLines ?? [];

  const css = `
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}
  img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
  a{word-break:break-word}
  @media only screen and (max-width:${w + 20}px){.mr-wrap{width:100%!important}.mr-pad{padding-left:16px!important;padding-right:16px!important}}
  @media (prefers-color-scheme:dark){
    .mr-bg{background:${d.bg}!important}
    .mr-card{background:${d.card}!important}
    .mr-text{color:${d.text}!important}
    .mr-muted{color:${d.muted}!important}
    .mr-link{color:${d.link}!important}
    .mr-bd{border-color:${d.border}!important}
    .mr-code{background:${d.codeBg}!important}
  }`;

  const renderHtml = (p: TemplateParts): string => {
    const pre = escapeHtml(p.preheader);
    const header = cfg.logoUrl
      ? `<img src="${escapeHtml(cfg.logoUrl)}" alt="${escapeHtml(cfg.brandName)}" height="36" style="display:block;border:0;height:36px;width:auto">`
      : `<span class="mr-text" style="font-size:20px;font-weight:700;color:${theme.accent}">${escapeHtml(cfg.brandName)}</span>`;
    const tagline = cfg.tagline ? `<div class="mr-muted" style="font-size:13px;color:${theme.muted};margin-top:2px">${escapeHtml(cfg.tagline)}</div>` : '';
    const greeting = cfg.greeting ? `{{#name}}<p class="mr-text" style="margin:0 0 18px;font-size:16px;line-height:1.8;color:${theme.text}">${escapeHtml(cfg.greeting)}</p>{{/name}}` : '';
    const footLines = footer
      .map((l) =>
        typeof l === 'string'
          ? `<p class="mr-muted" style="margin:0 0 6px;font-size:12px;line-height:1.7;color:${theme.muted}">${escapeHtml(l)}</p>`
          : `<p style="margin:0 0 6px;font-size:12px;line-height:1.7"><a class="mr-link" href="${escapeHtml(l.href)}" style="color:${theme.link}">${escapeHtml(l.text)}</a></p>`,
      )
      .join('');
    const sentTo = labels.sentTo.replace('{email}', '{{email}}');
    const lead = cfg.unsubscribeLead ? `${escapeHtml(cfg.unsubscribeLead)} ` : '';
    return `<!doctype html>
<html lang="${escapeHtml(lang)}" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(p.subject)}</title>
<style>${css}</style>
</head>
<body class="mr-bg" style="margin:0;padding:0;background:${theme.bg};word-break:break-word">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${theme.bg}">${pre}${'&#8204;&nbsp;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="mr-bg" style="background:${theme.bg}"><tr><td align="center" style="padding:20px 10px">
<!--[if mso]><table role="presentation" width="${w}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="mr-wrap" width="${w}" cellpadding="0" cellspacing="0" border="0" style="width:${w}px;max-width:100%">
<tr><td class="mr-pad" style="padding:0 4px 12px;font-family:${theme.font}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="font-family:${theme.font}">${header}${tagline}</td>
<td align="right" style="font-family:${theme.font};font-size:12px"><a class="mr-link" href="{{web_url}}" style="color:${theme.link}">${escapeHtml(labels.viewInBrowser)}</a></td></tr></table>
</td></tr>
<tr><td class="mr-card mr-bd mr-pad" style="background:${theme.card};border:1px solid ${theme.border};padding:28px 32px;font-family:${theme.font};color:${theme.text}">
${greeting}${p.bodyHtml}
</td></tr>
<tr><td class="mr-pad" style="padding:16px 4px;font-family:${theme.font}">
${cfg.footerHtml ?? ''}${footLines}<p class="mr-muted" style="margin:0 0 6px;font-size:12px;line-height:1.7;color:${theme.muted}">${escapeHtml(cfg.postalAddress)}</p>
{{#email}}<p class="mr-muted" style="margin:0 0 6px;font-size:12px;line-height:1.7;color:${theme.muted}">${escapeHtml(sentTo)}</p>{{/email}}
<p class="mr-muted" style="margin:0;font-size:12px;line-height:1.7;color:${theme.muted}">${lead}<a class="mr-link" href="{{unsubscribe_url}}" style="color:${theme.link}">${escapeHtml(labels.unsubscribe)}</a></p>
${p.pixelUrl ? `<img src="${escapeHtml(p.pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : ''}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
  };

  const renderText = (p: TemplateParts): string => {
    const lines: string[] = [];
    lines.push(cfg.brandName + (cfg.tagline ? ` — ${cfg.tagline}` : ''));
    lines.push(`${labels.viewInBrowser}: {{web_url}}`);
    lines.push('');
    if (cfg.greeting) lines.push(`{{#name}}${cfg.greeting}{{/name}}`, '');
    lines.push(p.bodyText.trim(), '', '--');
    if (cfg.footerText) lines.push(cfg.footerText.trim());
    for (const l of footer) lines.push(typeof l === 'string' ? l : `${l.text}: ${l.href}`);
    lines.push(cfg.postalAddress);
    lines.push(`{{#email}}${labels.sentTo.replace('{email}', '{{email}}')}{{/email}}`);
    lines.push(`${cfg.unsubscribeLead ? `${cfg.unsubscribeLead} ` : ''}${labels.unsubscribe}: {{unsubscribe_url}}`);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n{{#email}}{{\/email}}/g, '') + '\n';
  };

  return { theme, labels, postalAddress: cfg.postalAddress, renderHtml, renderText };
}

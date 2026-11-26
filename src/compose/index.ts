// 產信模組的對外入口（package.json 的 "./compose"）。不含 cloudflare:*，Node 與 Worker 都能載入。
export { compose, type ComposeOptions, type ComposeResult, type LinkRecord, type ImageRecord } from './compose.ts';
export { parseMarkdown, type Block, type Inline, type Parsed, type Problem, type Severity } from './markdown.ts';
export { createTemplate, escapeHtml, DEFAULT_THEME, DEFAULT_LABELS, type EmailTemplate, type TemplateConfig, type TemplateParts, type Theme, type Labels, type FooterLine } from './template.ts';
export { personalize, fill, checkVars, cleanName, scanPlaceholders, PersonalizeError, type RecipientVars, type PersonalizeOptions } from './personalize.ts';
export { preflight, TODO_MARKER, type PreflightOptions, type PreflightResult } from './preflight.ts';
export { buildPreview, SAMPLE_VARS, type PreviewFiles, type PreviewOptions } from './preview.ts';
export { detectScannerClicks, type ClickEvent, type ScannerRule } from './clicks.ts';

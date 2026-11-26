// Amazon SES（API v2）郵差：電子報用。實作 postman.ts 的 Postman 介面。
//
// 送一封：POST https://email.{地區}.amazonaws.com/v2/email/outbound-emails（SendEmail，Simple 內容＋自訂標頭）。
// - 帶設定組（ConfigurationSetName）→ 事件經 SNS 回郵務室（ses-events.ts）；帶 EmailTags（campaign、contact）→ 事件對得到人。
// - 退訂兩個標頭（List-Unsubscribe、List-Unsubscribe-Post）由 render 放進 mail.headers，原樣送出。
// - 自訂 MAIL FROM 是 SES 身分（寄件網域）層級的設定，不在每封信的請求裡；寄件網域在 SES 驗過就會套用。
// 報上限：GET /v2/email/account（GetAccount）→ 每秒上限、24 小時上限、已用量、帳號健康狀態。
//
// 錯誤分類（SES 沒有冪等鍵：沒拿到明確答覆就不能假設沒寄出）：
// - 200＋MessageId → ok。
// - 限流（TooManyRequestsException、Throttling…，「每秒上限」那種）→ throttled（引擎延遲再試）。
// - 「每日額度用完」→ daily_quota（引擎今天停放水、明天自動恢復；不在這裡無限重試）。
// - 帳號被停／暫停、寄件網域沒驗證、設定組不存在、鑰匙或權限錯（403）→ account_paused（每一封都會一樣失敗，停下來查）。
// - 其他 4xx（地址不合格、沙盒沒驗證的收件人、內容被拒）→ permanent（只影響這一位）。
// - 5xx、逾時、連線錯、回應讀不懂 → 丟例外＝不知道有沒有寄出（引擎記 uncertain、絕不自動重寄）。
// 鑰匙、收件人、內容都不進 log 與錯誤訊息；錯誤只留 HTTP 狀態與 SES 的錯誤名稱。

import { signRequest, type AwsCredentials } from '../aws-sigv4.ts';
import type { Postman, PostmanLimits, PostmanMail, PostmanOutcome } from './postman.ts';

export interface SesPostmanOptions {
  region: string;
  credentials: AwsCredentials;
  /** SES 設定組名稱（事件發布用）。沒給＝不帶，事件就不會回來（只建議測試用）。 */
  configurationSet?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  name?: string;
}

export const SES_REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const CONFIG_SET = /^[A-Za-z0-9_-]{1,64}$/;
const TAG_VALUE = /^[A-Za-z0-9_-]{1,256}$/;
/** SES MessageHeader：名稱可見 ASCII（不含冒號）≤126；值可見 ASCII ≤995、名稱＋值 ≤996。 */
const HEADER_NAME = /^[!-9;-~]{1,126}$/;
const HEADER_VALUE = /^[ -~]{1,995}$/;
/** 這些標頭 SES 自己組，或由 API 欄位決定；不准從 mail.headers 帶進去。 */
const RESERVED_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'reply-to', 'sender', 'return-path', 'message-id', 'date', 'mime-version', 'content-type', 'content-transfer-encoding']);

const DEFAULT_TIMEOUT_MS = 10_000;

const THROTTLE_CODES = new Set(['TooManyRequestsException', 'Throttling', 'ThrottlingException']);
const PAUSE_CODES = new Set([
  'AccountSuspendedException', 'SendingPausedException', 'MailFromDomainNotVerifiedException', 'NotFoundException',
  'AccessDeniedException', 'UnrecognizedClientException', 'InvalidSignatureException', 'SignatureDoesNotMatch', 'InvalidClientTokenId',
  'ExpiredTokenException', 'MissingAuthenticationTokenException', 'IncompleteSignatureException', 'RequestExpired', 'RequestTimeTooSkewed',
]);

/** 非 ASCII 的顯示名稱用 RFC 2047 編碼（SES 要求）；地址本身照舊。 */
export function encodeAddress(a: string): string {
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(a.trim());
  if (!m || !m[1]) return a.trim();
  const name = m[1].replace(/^"(.*)"$/, '$1');
  if (/^[\x20-\x7e]*$/.test(name)) return /[(),.:;<>@[\\\]"]/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}" <${m[2]}>` : `${name} <${m[2]}>`;
  const bytes = new TextEncoder().encode(name);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?= <${m[2]}>`;
}

/** SES 回的錯誤名稱：x-amzn-ErrorType 標頭（`名稱:網址`）或內文 __type／code。 */
export function sesErrorCode(res: Response, body: Record<string, unknown>): string {
  const h = res.headers.get('x-amzn-errortype');
  const raw = h ?? (typeof body.__type === 'string' ? body.__type : typeof body.code === 'string' ? body.code : typeof body.Code === 'string' ? body.Code : '');
  return raw.split(':')[0].split('#').pop()!.trim().slice(0, 80) || 'Unknown';
}

function errorMessage(body: Record<string, unknown>): string {
  const m = body.message ?? body.Message;
  return typeof m === 'string' ? m : '';
}

export function classifySesError(status: number, code: string, message: string): Exclude<PostmanOutcome, { ok: true }> | null {
  if (status >= 500) return null; // 不知道有沒有收下
  if (/daily message quota exceeded/i.test(message)) return { ok: false, kind: 'daily_quota', error: `${status} ${code} daily_quota_exceeded` };
  if (status === 429 || THROTTLE_CODES.has(code)) return { ok: false, kind: 'throttled', error: `${status} ${code}` };
  if (status === 403 || PAUSE_CODES.has(code)) return { ok: false, kind: 'account_paused', error: `${status} ${code}` };
  if (status >= 400) return { ok: false, kind: 'permanent', error: `${status} ${code}` };
  return null;
}

export class SesPostman implements Postman {
  readonly name: string;
  private readonly opts: SesPostmanOptions;
  private readonly endpoint: string;

  constructor(opts: SesPostmanOptions) {
    if (!SES_REGION.test(opts.region)) throw new Error('ses: bad region');
    if (!opts.credentials?.accessKeyId || !opts.credentials?.secretAccessKey) throw new Error('ses: missing credentials');
    if (opts.configurationSet !== undefined && !CONFIG_SET.test(opts.configurationSet)) throw new Error('ses: bad configuration set name');
    this.opts = opts;
    this.name = opts.name ?? 'ses';
    this.endpoint = `https://email.${opts.region}.amazonaws.com`;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: string): Promise<{ res: Response; json: Record<string, unknown> }> {
    const url = `${this.endpoint}${path}`;
    const signed = await signRequest({
      method, url, body, region: this.opts.region, service: 'ses', credentials: this.opts.credentials,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      now: (this.opts.now ?? (() => new Date()))(),
    });
    // host 由 fetch 依網址自己帶（簽進去的就是同一個值）。
    const { host: _host, ...headers } = signed;
    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await (this.opts.fetcher ?? fetch)(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        const parsed = text ? JSON.parse(text) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed;
      } catch {
        /* 讀不懂就當空的；下面依狀態碼判斷 */
      }
      return { res, json };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error(`ses timeout (${timeoutMs}ms)`);
      throw new Error('ses network error');
    } finally {
      clearTimeout(timer);
    }
  }

  async send(mail: PostmanMail): Promise<PostmanOutcome> {
    const headers: { Name: string; Value: string }[] = [];
    for (const [name, value] of Object.entries(mail.headers ?? {})) {
      if (!HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value) || name.length + value.length > 996 || RESERVED_HEADERS.has(name.toLowerCase())) {
        return { ok: false, kind: 'permanent', error: 'bad_header' };
      }
      headers.push({ Name: name, Value: value });
    }
    const tags: { Name: string; Value: string }[] = [];
    for (const [name, value] of [['campaign', mail.tags.campaign], ['contact', mail.tags.contact]] as const) {
      if (!TAG_VALUE.test(String(value))) return { ok: false, kind: 'permanent', error: `bad_tag_${name}` };
      tags.push({ Name: name, Value: String(value) });
    }
    const payload: Record<string, unknown> = {
      FromEmailAddress: encodeAddress(mail.from),
      Destination: { ToAddresses: [mail.to] },
      Content: {
        Simple: {
          Subject: { Data: mail.subject, Charset: 'UTF-8' },
          Body: { Html: { Data: mail.html, Charset: 'UTF-8' }, Text: { Data: mail.text, Charset: 'UTF-8' } },
          ...(headers.length ? { Headers: headers } : {}),
        },
      },
      EmailTags: tags,
      ...(mail.replyTo ? { ReplyToAddresses: [encodeAddress(mail.replyTo)] } : {}),
      ...(this.opts.configurationSet ? { ConfigurationSetName: this.opts.configurationSet } : {}),
    };
    const { res, json } = await this.call('POST', '/v2/email/outbound-emails', JSON.stringify(payload));
    if (res.ok) {
      if (typeof json.MessageId === 'string' && json.MessageId) return { ok: true, providerId: json.MessageId };
      throw new Error(`ses ${res.status} without MessageId`);
    }
    const code = sesErrorCode(res, json);
    const out = classifySesError(res.status, code, errorMessage(json));
    if (!out) throw new Error(`ses ${res.status} ${code}`);
    return out;
  }

  async limits(): Promise<PostmanLimits> {
    const { res, json } = await this.call('GET', '/v2/email/account');
    if (!res.ok) throw new Error(`ses GetAccount ${res.status} ${sesErrorCode(res, json)}`);
    const q = (json.SendQuota ?? {}) as { Max24HourSend?: unknown; MaxSendRate?: unknown; SentLast24Hours?: unknown };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    // 寄信被關（SendingEnabled=false）也當成不健康：引擎會停寄。
    const enforcement = json.SendingEnabled === false ? 'SENDING_DISABLED' : typeof json.EnforcementStatus === 'string' && json.EnforcementStatus ? json.EnforcementStatus : 'UNKNOWN';
    return {
      perSecond: num(q.MaxSendRate),
      perDay: num(q.Max24HourSend),
      sentLast24h: num(q.SentLast24Hours),
      enforcement,
      ...(typeof json.ProductionAccessEnabled === 'boolean' ? { production: json.ProductionAccessEnabled } : {}),
    };
  }
}

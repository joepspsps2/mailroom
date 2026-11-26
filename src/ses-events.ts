// Amazon SES 的事後回報：SES 設定組 → SNS 主題 → HTTPS 訂閱 → 郵務室 POST /webhooks/ses。
//
// 進來的每一則先驗 SNS 簽章，過了才處理（官方作法：
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html）：
// 1. 主題 ARN 必須在白名單（部署端設定），而且跟設定的地區一致。
// 2. 憑證網址必須是 https://sns.{地區}.amazonaws.com/…pem（AWS 自己的網域、同一個地區，不收別的主機、連接埠、帳密）。
// 3. 從憑證取公鑰（只用 WebCrypto＋一小段 DER 解析），照 Type 組「待簽字串」，SignatureVersion 2＝SHA256（預設只收這版）、
//    1＝SHA1（要部署端明確打開才收）。憑證過期或還沒生效一律不收。
// 4. Timestamp 太舊（預設 7 天）或在未來太遠的不收（防重播；更近的重播靠下面的去重）。
// 訂閱確認（SubscriptionConfirmation）：驗過簽章、SubscribeURL 也是同一個 SNS 主機時，才去打那個網址確認。
// 通知（Notification）：Message 裡是 SES 的事件 JSON → 正規化成 ProviderEvent → ingestEvent（退信、檢舉進 applyFeedback）。
// 同一則 SNS 訊息（MessageId）重送只處理一次：跟其他郵差共用 webhook_events。
// 不 import cloudflare:*；收件人、鑰匙不進 log。

import type { Db } from './core.ts';
import { ingestEvent, type IngestOptions } from './broadcast/events.ts';
import type { EventType, ProviderEvent } from './broadcast/postman.ts';

export interface SnsVerifyOptions {
  /** SES／SNS 所在地區，例 ap-northeast-1。憑證與訂閱確認網址都必須是這個地區的 SNS 主機。 */
  region: string;
  /** 准收的 SNS 主題 ARN（完全相同才收）。空的＝一律不收。 */
  topicArns: readonly string[];
  /** 也收 SignatureVersion 1（SHA1）。預設 false：主題請設成 SignatureVersion 2。 */
  allowSha1?: boolean;
  /** Timestamp 最多多舊（秒），預設 7 天。 */
  maxAgeSeconds?: number;
  fetcher?: typeof fetch;
  now?: () => Date;
}

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

export type VerifyResult = { ok: true; msg: SnsMessage } | { ok: false; reason: string };

const DEFAULT_MAX_AGE_S = 7 * 86_400;
const FUTURE_SKEW_S = 15 * 60;
const CERT_TTL_MS = 60 * 60_000;
const MAX_CERT_BYTES = 16_000;
const TYPES = ['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'];

// ---------- 憑證：PEM → DER → 公鑰（SubjectPublicKeyInfo）與有效期間 ----------

interface Tlv { tag: number; start: number; end: number; next: number }

function readTlv(b: Uint8Array, at: number, limit = b.length): Tlv {
  if (at + 2 > limit) throw new Error('asn1 short');
  const tag = b[at];
  let len = b[at + 1];
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || p + n > limit) throw new Error('asn1 length');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[p + i];
    p += n;
  }
  if (p + len > limit) throw new Error('asn1 overflow');
  return { tag, start: p, end: p + len, next: p + len };
}

function asn1Time(b: Uint8Array, t: Tlv): number {
  const s = new TextDecoder().decode(b.subarray(t.start, t.end));
  let m: RegExpExecArray | null;
  if (t.tag === 0x17 && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    const yy = Number(m[1]);
    return Date.UTC(yy >= 50 ? 1900 + yy : 2000 + yy, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  if (t.tag === 0x18 && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  throw new Error('asn1 time');
}

export interface ParsedCert { spki: Uint8Array; notBefore: number; notAfter: number }

/** X.509 憑證（PEM）→ 公鑰與有效期間。只解析用得到的欄位；格式不對就丟例外。 */
export function parseCertificate(pem: string): ParsedCert {
  const m = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/.exec(pem);
  if (!m) throw new Error('not a certificate');
  const bin = atob(m[1].replace(/\s+/g, ''));
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error('cert not sequence');
  const tbs = readTlv(der, cert.start, cert.end);
  if (tbs.tag !== 0x30) throw new Error('tbs not sequence');
  let p = tbs.start;
  let f = readTlv(der, p, tbs.end);
  if (f.tag === 0xa0) f = readTlv(der, (p = f.next), tbs.end); // version
  // serialNumber, signature, issuer
  for (const tag of [0x02, 0x30, 0x30]) {
    if (f.tag !== tag) throw new Error('tbs layout');
    f = readTlv(der, (p = f.next), tbs.end);
  }
  if (f.tag !== 0x30) throw new Error('validity');
  const nb = readTlv(der, f.start, f.end);
  const na = readTlv(der, nb.next, f.end);
  const notBefore = asn1Time(der, nb);
  const notAfter = asn1Time(der, na);
  const subject = readTlv(der, (p = f.next), tbs.end);
  if (subject.tag !== 0x30) throw new Error('subject');
  const spkiStart = subject.next;
  const spki = readTlv(der, spkiStart, tbs.end);
  if (spki.tag !== 0x30) throw new Error('spki');
  return { spki: der.slice(spkiStart, spki.end), notBefore, notAfter };
}

// ---------- 網址檢查 ----------

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** 必須是 https://sns.{地區}.amazonaws.com/（沒有連接埠、帳密）；回 URL 或 null。 */
function snsUrl(raw: string | undefined, region: string): URL | null {
  if (typeof raw !== 'string' || raw.length > 2048 || !REGION.test(region)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hostname !== `sns.${region}.amazonaws.com`) return null;
  return u;
}

export function isTrustedCertUrl(raw: string | undefined, region: string): boolean {
  const u = snsUrl(raw, region);
  return !!u && /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/.test(u.pathname) && !u.search && !u.hash;
}

export function isTrustedSubscribeUrl(raw: string | undefined, region: string, topicArn: string): boolean {
  const u = snsUrl(raw, region);
  return !!u && u.pathname === '/' && u.searchParams.get('Action') === 'ConfirmSubscription' && u.searchParams.get('TopicArn') === topicArn && !!u.searchParams.get('Token');
}

// ---------- 簽章 ----------

/** 照 Type 組待簽字串：欄位名、值各一行，固定順序，最後一行後面也有換行。 */
export function stringToSign(msg: SnsMessage): string | null {
  const fields =
    msg.Type === 'Notification'
      ? ['Message', 'MessageId', ...(msg.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  let out = '';
  for (const f of fields) {
    const v = (msg as unknown as Record<string, unknown>)[f];
    if (typeof v !== 'string') return null;
    out += `${f}\n${v}\n`;
  }
  return out;
}

const certCache = new Map<string, { cert: ParsedCert; at: number }>();

/** 測試用：清掉憑證快取。 */
export function clearCertCache(): void {
  certCache.clear();
}

async function loadCert(url: string, fetcher: typeof fetch, nowMs: number): Promise<ParsedCert> {
  const hit = certCache.get(url);
  if (hit && nowMs - hit.at < CERT_TTL_MS) return hit.cert;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetcher(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    if (res.status !== 200) throw new Error(`cert ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_CERT_BYTES) throw new Error('cert too large');
    const cert = parseCertificate(text);
    if (certCache.size > 20) certCache.clear();
    certCache.set(url, { cert, at: nowMs });
    return cert;
  } finally {
    clearTimeout(timer);
  }
}

function b64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 驗一則 SNS 訊息（已 JSON.parse）。過了才回 ok。 */
export async function verifySnsMessage(raw: unknown, opts: SnsVerifyOptions): Promise<VerifyResult> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_message' };
  const msg = raw as SnsMessage;
  for (const k of ['Type', 'MessageId', 'TopicArn', 'Message', 'Timestamp', 'SignatureVersion', 'Signature', 'SigningCertURL'] as const) {
    if (typeof msg[k] !== 'string' || !msg[k]) return { ok: false, reason: `missing_${k}` };
  }
  if (!TYPES.includes(msg.Type)) return { ok: false, reason: 'bad_type' };
  if (!REGION.test(opts.region)) return { ok: false, reason: 'bad_region_config' };
  if (!opts.topicArns.includes(msg.TopicArn) || msg.TopicArn.split(':')[3] !== opts.region) return { ok: false, reason: 'topic_not_allowed' };
  const hash = msg.SignatureVersion === '2' ? 'SHA-256' : msg.SignatureVersion === '1' && opts.allowSha1 ? 'SHA-1' : null;
  if (!hash) return { ok: false, reason: 'signature_version_not_allowed' };
  if (!isTrustedCertUrl(msg.SigningCertURL, opts.region)) return { ok: false, reason: 'untrusted_cert_url' };
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const ts = Date.parse(msg.Timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  if (nowMs - ts > (opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_S) * 1000 || ts - nowMs > FUTURE_SKEW_S * 1000) return { ok: false, reason: 'stale_timestamp' };
  const toSign = stringToSign(msg);
  if (toSign === null) return { ok: false, reason: 'missing_fields' };
  const sig = b64(msg.Signature);
  if (!sig || sig.length < 64) return { ok: false, reason: 'bad_signature_encoding' };
  let cert: ParsedCert;
  try {
    cert = await loadCert(msg.SigningCertURL, opts.fetcher ?? fetch, nowMs);
  } catch {
    return { ok: false, reason: 'cert_unavailable' };
  }
  if (nowMs < cert.notBefore || nowMs > cert.notAfter) return { ok: false, reason: 'cert_expired' };
  try {
    const key = await crypto.subtle.importKey('spki', Uint8Array.from(cert.spki), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Uint8Array.from(sig), new TextEncoder().encode(toSign));
    return ok ? { ok: true, msg } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}

// ---------- SES 事件 → ProviderEvent ----------

interface SesMail { messageId?: unknown; destination?: unknown; tags?: unknown; timestamp?: unknown }
interface SesEvent {
  eventType?: unknown;
  notificationType?: unknown;
  mail?: SesMail;
  bounce?: { bounceType?: unknown; bounceSubType?: unknown; bouncedRecipients?: unknown; feedbackId?: unknown; timestamp?: unknown };
  complaint?: { complainedRecipients?: unknown; complaintFeedbackType?: unknown; complaintSubType?: unknown; feedbackId?: unknown; timestamp?: unknown };
  delivery?: { recipients?: unknown; timestamp?: unknown; smtpResponse?: unknown };
  reject?: { reason?: unknown };
  failure?: { errorMessage?: unknown };
  deliveryDelay?: { delayType?: unknown; delayedRecipients?: unknown; timestamp?: unknown };
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const addr = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const m = /<([^<>\s]+)>\s*$/.exec(v);
  const a = (m ? m[1] : v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(a) && a.length <= 320 ? a : null;
};
function tag(tags: unknown, name: string): string | null {
  if (!tags || typeof tags !== 'object') return null;
  const v = (tags as Record<string, unknown>)[name];
  return Array.isArray(v) && typeof v[0] === 'string' ? v[0].slice(0, 64) : null;
}

/**
 * 事件說的收件人，只認原信收件人裡有的（mail.destination）。
 * 事件沒列任何地址、原信只有一位收件人 → 算他的；事件列了地址卻對不上（例：讀者自動轉寄，退信報的是轉寄目的地）→ 不認，
 * 不能把轉寄目的地的退信算成讀者自己的信箱壞了。
 */
function recipients(listed: string[], destination: string[], anyListed: boolean): string[] {
  const matched = listed.filter((a) => destination.includes(a));
  if (matched.length) return [...new Set(matched)];
  return !anyListed && destination.length === 1 ? destination : [];
}

/** SES 根本沒寄（收件人已在 SES 自己的拒收名單）：只記事件，不當成新的退信或檢舉。 */
const NOT_SENT_SUBTYPES = new Set(['OnAccountSuppressionList', 'OnTenantSuppressionList', 'EmailValidationSuppressed']);

/** SES 暫時退信子類型 → 給 applyFeedback 的原因。只有信箱滿算信箱層級；原因不明的不給（不累計）。 */
export function transientCause(subType: string | null): 'mailbox' | 'content' | undefined {
  if (subType === 'MailboxFull') return 'mailbox';
  if (subType === 'ContentRejected' || subType === 'AttachmentRejected' || subType === 'MessageTooLarge') return 'content';
  return undefined;
}

/** 一則 SES 事件 → 0～多則 ProviderEvent（每個收件人一則）。Open、Click、Subscription 不處理（開信點擊自己追蹤）。 */
export function normalizeSesEvent(ev: unknown, snsMessageId: string, opts: { configurationSet?: string } = {}): ProviderEvent[] {
  if (!ev || typeof ev !== 'object') return [];
  const e = ev as SesEvent;
  // 只收自己設定組的事件：同一個帳號或主題裡別的寄信不能影響我們的拒收名單。
  if (opts.configurationSet && tag(e.mail?.tags, 'ses:configuration-set') !== opts.configurationSet) return [];
  const kind = str(e.eventType) ?? str(e.notificationType);
  const mail = e.mail ?? {};
  const providerMessageId = str(mail.messageId);
  if (!kind || !providerMessageId) return [];
  const destination = (Array.isArray(mail.destination) ? mail.destination : []).map(addr).filter((a): a is string => !!a);
  const campaign = tag(mail.tags, 'campaign');
  const contactRaw = tag(mail.tags, 'contact');
  const contact = contactRaw && /^\d{1,15}$/.test(contactRaw) ? contactRaw : null;
  const base = { provider: 'ses', providerMessageId, campaign, contact };
  const make = (type: EventType, list: string[], at: unknown, extra: Partial<ProviderEvent> = {}): ProviderEvent[] =>
    list.map((email, i) => ({
      ...base,
      providerEventId: `ses:${snsMessageId}:${i}`.slice(0, 200),
      type,
      at: str(at, 40) ?? str(mail.timestamp, 40) ?? new Date().toISOString(),
      email,
      ...extra,
    }));
  const listed = (v: unknown, field: string) => (Array.isArray(v) ? v.map((r) => addr(field ? (r as Record<string, unknown>)?.[field] : r)).filter((a): a is string => !!a) : []);
  const pick = (v: unknown, field: string) => recipients(listed(v, field), destination, Array.isArray(v) && v.length > 0);

  switch (kind) {
    case 'Send':
      return make('send', destination.slice(0, 1), mail.timestamp);
    case 'Delivery': {
      const d = e.delivery ?? {};
      return make('delivery', pick(d.recipients, ''), d.timestamp);
    }
    case 'Bounce': {
      const b = e.bounce ?? {};
      const type = str(b.bounceType, 40) ?? 'Undetermined';
      const subType = str(b.bounceSubType, 60);
      const rs = Array.isArray(b.bouncedRecipients) ? (b.bouncedRecipients as Record<string, unknown>[]) : [];
      const list = pick(rs, 'emailAddress');
      return list.map((email, i) => {
        const r = rs.find((x) => addr(x?.emailAddress) === email) ?? {};
        const cause = type === 'Transient' ? transientCause(subType) : undefined;
        // SES 根本沒寄（已在 SES 自己的拒收名單）：記成拒收（reject），不算退信率、不進拒收名單。
        if (subType && NOT_SENT_SUBTYPES.has(subType)) {
          return { ...make('reject', [email], b.timestamp, { subtype: subType, skipFeedback: true, detail: { from: 'Bounce', feedbackId: str(b.feedbackId, 120) } })[0], providerEventId: `ses:${snsMessageId}:${i}` };
        }
        return {
          ...make('bounce', [email], b.timestamp)[0],
          providerEventId: `ses:${snsMessageId}:${i}`,
          // 只有 bounceType 正好是 Permanent 才是硬退信；Undetermined、Transient 都不是。
          subtype: type === 'Permanent' ? 'Permanent' : type === 'Transient' ? 'Transient' : 'Undetermined',
          ...(cause ? { cause } : {}),
          detail: { bounceSubType: subType, status: str(r.status, 20), diagnosticCode: str(r.diagnosticCode, 200), feedbackId: str(b.feedbackId, 120) },
        };
      });
    }
    case 'Complaint': {
      const c = e.complaint ?? {};
      // 「不是垃圾信」是更正，不是檢舉。
      if (str(c.complaintFeedbackType) === 'not-spam') return [];
      const notSentSub = str(c.complaintSubType, 60);
      if (notSentSub && NOT_SENT_SUBTYPES.has(notSentSub)) {
        // 同上：SES 沒寄，不是新的檢舉；記成拒收，不算檢舉率。
        return make('reject', pick(c.complainedRecipients, 'emailAddress'), c.timestamp, { subtype: notSentSub, skipFeedback: true, detail: { from: 'Complaint', feedbackId: str(c.feedbackId, 120) } });
      }
      return make('complaint', pick(c.complainedRecipients, 'emailAddress'), c.timestamp, {
        subtype: str(c.complaintFeedbackType, 40),
        detail: { feedbackType: str(c.complaintFeedbackType, 40), complaintSubType: str(c.complaintSubType, 60), feedbackId: str(c.feedbackId, 120) },
      });
    }
    case 'Reject':
      return make('reject', destination, mail.timestamp, { subtype: 'Reject', detail: { reason: str(e.reject?.reason, 100) } });
    case 'Rendering Failure':
      return make('reject', destination, mail.timestamp, { subtype: 'RenderingFailure', detail: { error: str(e.failure?.errorMessage, 200) } });
    case 'DeliveryDelay': {
      const d = e.deliveryDelay ?? {};
      return make('delay', pick(d.delayedRecipients, 'emailAddress'), d.timestamp, { subtype: str(d.delayType, 40) });
    }
    default:
      return [];
  }
}

// ---------- HTTP 入口 ----------

export interface SesWebhookOptions extends SnsVerifyOptions {
  /** 只收這個 SES 設定組的事件（mail.tags 的 ses:configuration-set）。強烈建議設；沒設＝不檢查。 */
  configurationSet?: string;
  ingest?: IngestOptions;
}

export interface SesWebhookResult {
  status: number;
  outcome: string;
}

/** 處理 POST /webhooks/ses 的內文。回 HTTP 狀態與做了什麼（給 log、測試；不含收件人）。2xx 以外 SNS 會照重試政策重送。 */
export async function handleSesWebhook(db: Db, body: string, opts: SesWebhookOptions, messageTypeHeader?: string | null): Promise<SesWebhookResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { status: 400, outcome: 'bad_json' };
  }
  const v = await verifySnsMessage(raw, opts);
  if (!v.ok) return { status: 403, outcome: `rejected:${v.reason}` };
  const msg = v.msg;
  if (messageTypeHeader && messageTypeHeader !== msg.Type) return { status: 400, outcome: 'type_mismatch' };

  if (msg.Type === 'SubscriptionConfirmation') {
    if (!isTrustedSubscribeUrl(msg.SubscribeURL, opts.region, msg.TopicArn)) return { status: 403, outcome: 'rejected:untrusted_subscribe_url' };
    try {
      const res = await (opts.fetcher ?? fetch)(msg.SubscribeURL!, { method: 'GET', redirect: 'manual' });
      if (res.status !== 200) return { status: 502, outcome: `subscribe_confirm_failed:${res.status}` };
    } catch {
      return { status: 502, outcome: 'subscribe_confirm_failed:network' };
    }
    return { status: 200, outcome: 'subscription_confirmed' };
  }
  if (msg.Type === 'UnsubscribeConfirmation') return { status: 200, outcome: 'unsubscribe_confirmation_ignored' };

  const key = `ses:${msg.MessageId}`.slice(0, 200);
  const seen = await db.prepare('SELECT 1 AS x FROM webhook_events WHERE id = ?').bind(key).first();
  if (seen) return { status: 200, outcome: 'repeat' };
  let ses: unknown;
  try {
    ses = JSON.parse(msg.Message);
  } catch {
    ses = null;
  }
  const events = normalizeSesEvent(ses, msg.MessageId, { configurationSet: opts.configurationSet });
  const outcomes: string[] = [];
  for (const ev of events) outcomes.push(`${ev.type}:${await ingestEvent(db, ev, opts.ingest)}`);
  const kind = ses && typeof ses === 'object' ? String((ses as SesEvent).eventType ?? (ses as SesEvent).notificationType ?? 'unknown').slice(0, 40) : 'unparsed';
  await db.prepare('INSERT INTO webhook_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(key, `ses.${kind}`, (opts.now ?? (() => new Date()))().toISOString()).run();
  return { status: 200, outcome: outcomes.length ? outcomes.join(',') : `ignored:${kind}` };
}

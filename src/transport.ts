// 郵差層：照「郵差順序」一個一個試（順序依站＋信件層級設定，見 core.ts routeFor）。
//
// 三種郵差：
// - cloudflare：Cloudflare 寄信（Workers 的 send_email 綁定，不用鑰匙），只給第二層。
//   8 秒上限；收件人在 Cloudflare 自己的拒收名單（E_RECIPIENT_SUPPRESSED）→ 不換郵差，回 suppressed。
//   其他錯誤（額度用完、限流、網域沒驗證、逾時）→ 換下一個郵差。逾時時 Cloudflare 可能其實寄出了：寧可重複不要漏寄。
// - resend：帶 Idempotency-Key（＝站名/去重鍵）POST Resend，8 秒上限。
//   逾時／連線錯／5xx（不確定 Resend 有沒有收下）→ 同一把鑰匙、同一份內容再問一次，3 秒上限。
//   Resend 24 小時內認得這把鑰匙：收過就回原本那封的 id、不會再寄。4xx＝確定沒寄 → 換下一個。
// - smtp2go：最後一道。
// 全部失敗回 ok:false（不丟例外），由呼叫端記帳。
// 只回狀態碼與郵差回的錯誤名稱，鑰匙與信件內容不進 log。

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export type MailRoute = 'cloudflare' | 'resend' | 'smtp2go';
export const MAIL_ROUTES: readonly MailRoute[] = ['cloudflare', 'resend', 'smtp2go'];

/** Cloudflare send_email 綁定用得到的那一小塊（SendEmail 本身就符合）。 */
export interface CloudflareSender {
  send(message: {
    from: string | { email: string; name?: string };
    to: string;
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string | { email: string; name?: string };
  }): Promise<{ messageId?: string }>;
}

export interface TransportKeys {
  resend?: string;
  smtp2go?: string;
  cloudflare?: CloudflareSender;
}

export interface TransportResult {
  ok: boolean;
  route?: MailRoute;
  providerId?: string | null;
  error?: string;
  /** true＝郵差說收件人在它的拒收名單（不換郵差、不重試）。 */
  suppressed?: boolean;
}

const RESEND_URL = 'https://api.resend.com/emails';
const SMTP2GO_URL = 'https://api.smtp2go.com/v3/email/send';
const PRIMARY_TIMEOUT_MS = 8_000;
const RECHECK_TIMEOUT_MS = 3_000;
const FALLBACK_TIMEOUT_MS = 10_000;
/** 沒有備援鑰匙時 Resend 是唯一一條路，給寬一點。 */
const SOLO_TIMEOUT_MS = 15_000;

interface Attempt {
  ok: boolean;
  id?: string | null;
  error?: string;
  /** true＝不確定對方有沒有收下（逾時／連線錯／5xx），值得拿同一把鑰匙補問。 */
  uncertain?: boolean;
  suppressed?: boolean;
}

async function postJson(fetcher: typeof fetch, url: string, headers: Record<string, string>, body: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: controller.signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, ok: res.ok, json };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`逾時（${timeoutMs}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function viaResend(fetcher: typeof fetch, key: string, idempotencyKey: string, body: string, timeoutMs: number): Promise<Attempt> {
  try {
    const { ok, status, json } = await postJson(fetcher, RESEND_URL, { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey }, body, timeoutMs);
    if (!ok) {
      return { ok: false, uncertain: status >= 500, error: `resend ${status} ${String(json.name ?? '')}`.trim().slice(0, 200) };
    }
    return { ok: true, id: typeof json.id === 'string' ? json.id : null };
  } catch (error) {
    return { ok: false, uncertain: true, error: `resend ${error instanceof Error ? error.message : 'error'}` };
  }
}

async function viaSmtp2go(fetcher: typeof fetch, key: string, mail: OutgoingMail): Promise<Attempt> {
  try {
    const payload: Record<string, unknown> = { sender: mail.from, to: [mail.to], subject: mail.subject, text_body: mail.text, html_body: mail.html };
    if (mail.replyTo) payload.custom_headers = [{ header: 'Reply-To', value: mail.replyTo }];
    const { ok, status, json } = await postJson(fetcher, SMTP2GO_URL, { 'X-Smtp2go-Api-Key': key }, JSON.stringify(payload), FALLBACK_TIMEOUT_MS);
    const data = (json.data ?? {}) as { succeeded?: number; email_id?: string; error_code?: string };
    // SMTP2GO 部分錯誤也回 200，一律以 data.succeeded 為準。
    if (!ok || data.succeeded !== 1) return { ok: false, error: `smtp2go ${status} ${String(data.error_code ?? '')}`.trim().slice(0, 200) };
    return { ok: true, id: data.email_id ?? null };
  } catch (error) {
    return { ok: false, error: `smtp2go ${error instanceof Error ? error.message : 'error'}` };
  }
}

/**
 * Resend 的 Idempotency-Key 上限 256 字；太長就改用 sha256。
 * 去重鍵含非 ASCII 可見字元（中文、換行…）時也改用 sha256：HTTP 標頭放不進這些字，
 * 照放會讓 Resend 那一趟直接丟例外、每封都悄悄落到備援郵差。
 */
export async function idempotencyKeyFor(site: string, dedupeKey: string): Promise<string> {
  const raw = `${site}/${dedupeKey}`;
  if (raw.length <= 200 && /^[\x20-\x7e]+$/.test(raw)) return raw;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return `${site}/sha256-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** `名稱 <地址>` 或 `地址` → Cloudflare 要的 { email, name }（core.ts 已驗過、重組過）。 */
export function splitAddress(a: string): { email: string; name?: string } {
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(a.trim());
  return m ? (m[1] ? { email: m[2], name: m[1] } : { email: m[2] }) : { email: a.trim() };
}

async function viaCloudflare(sender: CloudflareSender, mail: OutgoingMail, timeoutMs: number): Promise<Attempt> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sent = sender.send({
      from: splitAddress(mail.from), to: mail.to, subject: mail.subject, html: mail.html, text: mail.text,
      ...(mail.replyTo ? { replyTo: splitAddress(mail.replyTo) } : {}),
    });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`逾時（${timeoutMs}ms）`)), timeoutMs); });
    const r = await Promise.race([sent, timeout]);
    return { ok: true, id: typeof r?.messageId === 'string' ? r.messageId : null };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    const msg = error instanceof Error ? error.message : 'error';
    // 沒有錯誤碼時不記郵差的原文訊息（內容我們管不到，可能帶收件地址）；只留自己的逾時訊息。
    const detail = code || (msg.startsWith('逾時') ? msg : 'error');
    return { ok: false, suppressed: code === 'E_RECIPIENT_SUPPRESSED', error: `cloudflare ${detail}`.slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const has = (keys: TransportKeys, r: MailRoute): boolean => (r === 'cloudflare' ? !!keys.cloudflare : !!keys[r]);

/**
 * 照 routes 的順序試；沒有鑰匙（或沒有綁定）的郵差跳過。
 * routes 預設 resend → smtp2go（第一層的預設順序）。
 */
export async function deliver(
  keys: TransportKeys,
  mail: OutgoingMail,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
  routes: readonly MailRoute[] = ['resend', 'smtp2go'],
): Promise<TransportResult> {
  const usable = routes.filter((r, i) => routes.indexOf(r) === i && has(keys, r));
  if (usable.length === 0) return { ok: false, error: `no-route ${routes.join('>')}` };
  const errors: string[] = [];
  for (let i = 0; i < usable.length; i++) {
    const route = usable[i];
    const last = i === usable.length - 1;
    let a: Attempt;
    if (route === 'cloudflare') {
      a = await viaCloudflare(keys.cloudflare!, mail, last ? SOLO_TIMEOUT_MS : PRIMARY_TIMEOUT_MS);
      if (a.suppressed) return { ok: false, suppressed: true, error: a.error };
    } else if (route === 'resend') {
      const payload: Record<string, unknown> = { from: mail.from, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text };
      if (mail.replyTo) payload.reply_to = mail.replyTo;
      // 補問時鑰匙與內容必須完全相同（內容不同＝Resend 回 409）。
      const body = JSON.stringify(payload);
      a = await viaResend(fetcher, keys.resend!, idempotencyKey, body, last ? SOLO_TIMEOUT_MS : PRIMARY_TIMEOUT_MS);
      if (!a.ok && a.uncertain && !last) {
        const recheck = await viaResend(fetcher, keys.resend!, idempotencyKey, body, RECHECK_TIMEOUT_MS);
        if (recheck.ok) a = recheck;
      }
    } else {
      a = await viaSmtp2go(fetcher, keys.smtp2go!, mail);
    }
    if (a.ok) {
      if (i > 0) console.warn(`mail via ${route} after`, errors.join('; '));
      return { ok: true, route, providerId: a.id };
    }
    errors.push(a.error ?? `${route} error`);
  }
  return { ok: false, error: errors.join('; ') };
}

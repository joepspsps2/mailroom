// 一期信：存草稿、記寄前檢查、核准、排程、暫停、續寄、取消。狀態只能照下表走，其他一律擋。
//
//   draft → approved → scheduled → sending ⇄ paused → done
//   draft／approved／scheduled／paused → cancelled
//   approved → draft（內容改了）、scheduled → approved（取消排程）、scheduled → draft（內容改了）
//
// sending／done 只有派送程式（dispatch.ts）能進；人能做的是 pause／resume／cancel。
// 內容（讀者看得到的一切）算一個雜湊：核准與寄前檢查都綁在那個雜湊上，內容一改就退回 draft、要重新核准。

import { parseAddress, type Db } from '../core.ts';

export type CampaignStatus = 'draft' | 'approved' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['draft', 'approved', 'scheduled', 'sending', 'paused', 'done', 'cancelled'];

/** 合法轉換（from → 可去的狀態）。 */
export const TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ['approved', 'cancelled'],
  approved: ['draft', 'scheduled', 'cancelled'],
  scheduled: ['draft', 'approved', 'sending', 'cancelled'],
  sending: ['paused', 'done'],
  paused: ['sending', 'cancelled'],
  done: [],
  cancelled: [],
};

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export type Audience = { plan: string } | { waves: string[][]; maxCount?: number };

export interface CampaignInput {
  id: string;
  list: string;
  subject: string;
  preheader?: string;
  from: string;
  replyTo?: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** 這期的網頁版網址（https；信裡的 {{web_url}}）。排程前一定要有。 */
  webUrl?: string;
  sourceRef?: string;
  audience: Audience;
}

export interface CampaignRow {
  id: string; list_id: string; subject: string; preheader: string | null; from_addr: string; reply_to: string | null;
  html: string; text: string; headers: string | null; web_url: string | null; source_ref: string | null; status: CampaignStatus;
  audience: string; audience_resolved: string | null; content_hash: string; approved_hash: string | null;
  approved_at: string | null; approved_note: string | null; preflight: string | null; scheduled_at: string | null;
  started_at: string | null; frozen_at: string | null; last_release_at: string | null; waiting_since: string | null; last_progress_at: string | null;
  finished_at: string | null; pause_reason: string | null; counts: string | null; created_at: string; updated_at: string;
}

export type Fail = { ok: false; reason: string; status?: CampaignStatus };
export type Ok<T = object> = { ok: true } & T;

export const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LIST_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SEGMENT = /^[^\u0000-\u001f\u007f]{1,64}$/;
/** 一期信能自帶的標頭：只收退訂兩個標頭、List-Id 與 X- 開頭的（寄件人、收件人、主旨等一律由引擎自己組，不准從這裡帶）。 */
export const EXTRA_HEADER = /^(?:list-unsubscribe|list-unsubscribe-post|list-id|x-[a-z0-9-]{1,60})$/i;
const LIMITS = { subject: 300, preheader: 300, html: 400_000, text: 200_000, note: 300, reason: 200, sourceRef: 300 };
const nowIso = (now?: () => Date) => (now ?? (() => new Date()))().toISOString();
const ctl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

/** 讀者看得到的一切（含名單與寄件人）算一個雜湊。 */
export async function contentHash(c: { list: string; subject: string; preheader?: string | null; from: string; replyTo?: string | null; html: string; text: string; headers?: Record<string, string> | null; webUrl?: string | null }): Promise<string> {
  const raw = JSON.stringify([c.list, c.subject, c.preheader ?? '', c.from, c.replyTo ?? '', c.html, c.text, Object.entries(c.headers ?? {}).sort(), c.webUrl ?? '']);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 收件群設定檢查：plan 要有名字；waves 要是非空的二維字串陣列、同一個群不能出現兩次。 */
export function checkAudience(a: unknown): Audience | null {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const o = a as Record<string, unknown>;
  if ('plan' in o) return typeof o.plan === 'string' && CAMPAIGN_ID.test(o.plan) && Object.keys(o).length === 1 ? { plan: o.plan } : null;
  const waves = checkWaves(o.waves);
  if (!waves) return null;
  if (o.maxCount !== undefined && !(Number.isInteger(o.maxCount) && (o.maxCount as number) > 0)) return null;
  return o.maxCount === undefined ? { waves } : { waves, maxCount: o.maxCount as number };
}

export function checkWaves(w: unknown): string[][] | null {
  if (!Array.isArray(w) || w.length === 0 || w.length > 20) return null;
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const wave of w) {
    if (!Array.isArray(wave) || wave.length === 0 || wave.length > 50) return null;
    const segs: string[] = [];
    for (const s of wave) {
      if (typeof s !== 'string' || !SEGMENT.test(s) || seen.has(s)) return null;
      seen.add(s);
      segs.push(s);
    }
    out.push(segs);
  }
  // 「*」（其他所有人）只能放在最後一波的最後一個。群總數上限 20（凍結那條 SQL 的綁定值才不會超過 D1 上限）。
  const flat = out.flat();
  if (flat.length > 20) return null;
  if (flat.includes('*') && flat.indexOf('*') !== flat.length - 1) return null;
  return out;
}

function checkInput(input: CampaignInput, marketingDomain: string): string | null {
  if (!input || typeof input !== 'object') return 'bad_request';
  if (typeof input.id !== 'string' || !CAMPAIGN_ID.test(input.id)) return 'bad_id';
  if (typeof input.list !== 'string' || !LIST_ID.test(input.list)) return 'bad_list';
  if (typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > LIMITS.subject || ctl(input.subject)) return 'bad_subject';
  if (input.preheader !== undefined && (typeof input.preheader !== 'string' || input.preheader.length > LIMITS.preheader || ctl(input.preheader))) return 'bad_preheader';
  const from = parseAddress(String(input.from ?? ''));
  if (!from || !marketingDomain || !from.addr.endsWith(`@${marketingDomain.toLowerCase()}`)) return 'bad_from';
  if (input.replyTo !== undefined && !parseAddress(input.replyTo)) return 'bad_reply_to';
  if (typeof input.html !== 'string' || !input.html || input.html.length > LIMITS.html) return 'bad_html';
  if (typeof input.text !== 'string' || !input.text || input.text.length > LIMITS.text) return 'bad_text';
  if (input.headers !== undefined) {
    if (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)) return 'bad_headers';
    for (const [k, v] of Object.entries(input.headers)) if (!EXTRA_HEADER.test(k) || typeof v !== 'string' || v.length > 2000 || /[\r\n]/.test(v)) return 'bad_headers';
  }
  if (input.webUrl !== undefined && (typeof input.webUrl !== 'string' || input.webUrl.length > 2000 || !/^https:\/\/[^\s<>"]+$/i.test(input.webUrl))) return 'bad_web_url';
  if (input.sourceRef !== undefined && (typeof input.sourceRef !== 'string' || input.sourceRef.length > LIMITS.sourceRef || ctl(input.sourceRef))) return 'bad_source_ref';
  if (!checkAudience(input.audience)) return 'bad_audience';
  return null;
}

export async function getCampaign(db: Db, id: string): Promise<CampaignRow | null> {
  if (typeof id !== 'string' || !CAMPAIGN_ID.test(id)) return null;
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<CampaignRow>();
}

/**
 * 存草稿：新的一期建成 draft；已存在的只有 draft／approved／scheduled 能改，改了一律退回 draft
 * （清掉核准與寄前檢查）。sending 之後不能改內容。
 */
export async function saveDraft(db: Db, input: CampaignInput, opts: { marketingDomain: string; now?: () => Date }): Promise<Ok<{ status: CampaignStatus; changed: boolean }> | Fail> {
  const bad = checkInput(input, opts.marketingDomain);
  if (bad) return { ok: false, reason: bad };
  if (!(await db.prepare('SELECT id FROM lists WHERE id = ?').bind(input.list).first())) return { ok: false, reason: 'unknown_list' };
  const hash = await contentHash(input);
  const audience = JSON.stringify(checkAudience(input.audience));
  const headers = input.headers ? JSON.stringify(input.headers) : null;
  const t = nowIso(opts.now);
  const existing = await getCampaign(db, input.id);
  if (!existing) {
    const r = await db
      .prepare(
        `INSERT INTO campaigns (id, list_id, subject, preheader, from_addr, reply_to, html, text, headers, web_url, source_ref, status, audience, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      )
      .bind(input.id, input.list, input.subject, input.preheader ?? null, input.from, input.replyTo ?? null, input.html, input.text, headers, input.webUrl ?? null, input.sourceRef ?? null, audience, hash, t, t)
      .run();
    if ((r.meta.changes ?? 0) === 1) return { ok: true, status: 'draft', changed: true };
    return { ok: false, reason: 'conflict' };
  }
  if (!['draft', 'approved', 'scheduled'].includes(existing.status)) return { ok: false, reason: 'locked', status: existing.status };
  if (existing.content_hash === hash && existing.audience === audience && existing.list_id === input.list && (existing.source_ref ?? null) === (input.sourceRef ?? null)) {
    return { ok: true, status: existing.status, changed: false };
  }
  const r = await db
    .prepare(
      `UPDATE campaigns SET list_id = ?, subject = ?, preheader = ?, from_addr = ?, reply_to = ?, html = ?, text = ?, headers = ?, web_url = ?, source_ref = ?, audience = ?,
         content_hash = ?, status = 'draft', approved_hash = NULL, approved_at = NULL, approved_note = NULL, preflight = NULL, scheduled_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('draft', 'approved', 'scheduled')`,
    )
    .bind(input.list, input.subject, input.preheader ?? null, input.from, input.replyTo ?? null, input.html, input.text, headers, input.webUrl ?? null, input.sourceRef ?? null, audience, hash, t, input.id)
    .run();
  if ((r.meta.changes ?? 0) !== 1) return { ok: false, reason: 'locked' };
  return { ok: true, status: 'draft', changed: true };
}

/** 寄前檢查結果（compose 的 preflight 產生）的最小形狀。 */
export interface PreflightRecord { ok: boolean; issues?: { severity?: string; code?: string; message?: string }[] }

/**
 * 記下寄前檢查結果，綁在目前的內容雜湊上。檢查是在呼叫端跑的（要打網路查連結），
 * 引擎只認「ok 而且雜湊對得上」才准排程。
 */
export async function recordPreflight(db: Db, id: string, result: PreflightRecord, now?: () => Date): Promise<Ok<{ preflightOk: boolean }> | Fail> {
  const c = await getCampaign(db, id);
  if (!c) return { ok: false, reason: 'not_found' };
  if (!['draft', 'approved', 'scheduled'].includes(c.status)) return { ok: false, reason: 'locked', status: c.status };
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return { ok: false, reason: 'bad_preflight' };
  const errors = Array.isArray(result.issues) ? result.issues.filter((i) => i && i.severity === 'error').slice(0, 50).map((i) => String(i.code ?? i.message ?? 'error').slice(0, 100)) : [];
  // 回報 ok 但列了 error＝自相矛盾，當沒過。
  const ok = result.ok && errors.length === 0;
  const record = JSON.stringify({ ok, hash: c.content_hash, at: nowIso(now), errors });
  const r = await db.prepare('UPDATE campaigns SET preflight = ?, updated_at = ? WHERE id = ? AND content_hash = ?').bind(record, nowIso(now), id, c.content_hash).run();
  if ((r.meta.changes ?? 0) !== 1) return { ok: false, reason: 'changed_meanwhile' };
  // 檢查沒過：已排程的退回 approved（不准留在 scheduled）。
  if (!ok && c.status === 'scheduled') await db.prepare("UPDATE campaigns SET status = 'approved', scheduled_at = NULL WHERE id = ? AND status = 'scheduled'").bind(id).run();
  return { ok: true, preflightOk: ok };
}

function preflightPasses(c: CampaignRow): boolean {
  if (!c.preflight) return false;
  try {
    const p = JSON.parse(c.preflight) as { ok?: unknown; hash?: unknown };
    return p.ok === true && p.hash === c.content_hash;
  } catch {
    return false;
  }
}

async function move(db: Db, id: string, from: CampaignStatus[], to: CampaignStatus, sets: string, binds: unknown[], now?: () => Date): Promise<Ok<{ status: CampaignStatus }> | Fail> {
  for (const f of from) if (!canTransition(f, to)) throw new Error(`transition table forbids ${f} -> ${to}`);
  const c = await getCampaign(db, id);
  if (!c) return { ok: false, reason: 'not_found' };
  if (!from.includes(c.status)) return { ok: false, reason: 'illegal_transition', status: c.status };
  const r = await db
    .prepare(`UPDATE campaigns SET status = ?, ${sets ? `${sets}, ` : ''}updated_at = ? WHERE id = ? AND status = ? AND content_hash = ?`)
    .bind(to, ...binds, nowIso(now), id, c.status, c.content_hash)
    .run();
  if ((r.meta.changes ?? 0) !== 1) return { ok: false, reason: 'changed_meanwhile' };
  return { ok: true, status: to };
}

function cleanText(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() && !ctl(v) ? v.trim().slice(0, max) : null;
}

/** 核准：只在本人看過預覽、明確說好之後執行；note 要寫「誰、什麼時候、在哪說的」。 */
export async function approveCampaign(db: Db, id: string, note: string, now?: () => Date): Promise<Ok<{ status: CampaignStatus }> | Fail> {
  const n = cleanText(note, LIMITS.note);
  if (!n) return { ok: false, reason: 'note_required' };
  const c = await getCampaign(db, id);
  if (!c) return { ok: false, reason: 'not_found' };
  return move(db, id, ['draft'], 'approved', 'approved_hash = content_hash, approved_at = ?, approved_note = ?', [nowIso(now), n], now);
}

/** 排程（at＝ISO 時間）：要已核准、核准的就是現在這份內容、寄前檢查過了、收件群有效。 */
export async function scheduleCampaign(db: Db, id: string, at: string, now?: () => Date): Promise<Ok<{ status: CampaignStatus; scheduledAt: string }> | Fail> {
  const c = await getCampaign(db, id);
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.status !== 'approved') return { ok: false, reason: 'illegal_transition', status: c.status };
  if (c.approved_hash !== c.content_hash) return { ok: false, reason: 'not_approved' };
  if (!preflightPasses(c)) return { ok: false, reason: 'preflight_not_passed' };
  if (!c.web_url) return { ok: false, reason: 'web_url_required' };
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return { ok: false, reason: 'bad_time' };
  let audience: Audience | null = null;
  try {
    audience = checkAudience(JSON.parse(c.audience));
  } catch {
    /* 下面擋 */
  }
  if (!audience) return { ok: false, reason: 'bad_audience' };
  if ('plan' in audience && !(await db.prepare('SELECT 1 AS x FROM warmup_steps WHERE plan_id = ? LIMIT 1').bind(audience.plan).first())) return { ok: false, reason: 'unknown_plan' };
  const iso = new Date(at).toISOString();
  const r = await move(db, id, ['approved'], 'scheduled', 'scheduled_at = ?', [iso], now);
  return r.ok ? { ok: true, status: r.status, scheduledAt: iso } : r;
}

/** 取消排程（退回 approved）。 */
export function unscheduleCampaign(db: Db, id: string, now?: () => Date) {
  return move(db, id, ['scheduled'], 'approved', 'scheduled_at = NULL', [], now);
}

/** 人工暫停（寄送中）。 */
export function pauseCampaign(db: Db, id: string, reason: string, now?: () => Date) {
  const r = cleanText(reason, LIMITS.reason);
  if (!r) return Promise.resolve<Fail>({ ok: false, reason: 'reason_required' });
  return move(db, id, ['sending'], 'paused', 'pause_reason = ?', [`manual: ${r}`], now);
}

/**
 * 續寄：只有 paused 能續；note 必填（寫查過什麼、為什麼可以繼續）。
 * 寄件網域被整個停掉時不能續（要先解除網域停寄）。
 */
export async function resumeCampaign(db: Db, id: string, note: string, opts: { marketingDomain: string; now?: () => Date }): Promise<Ok<{ status: CampaignStatus }> | Fail> {
  const n = cleanText(note, LIMITS.note);
  if (!n) return { ok: false, reason: 'note_required' };
  const hold = await db.prepare('SELECT reason FROM domain_holds WHERE domain = ? AND released_at IS NULL LIMIT 1').bind(opts.marketingDomain).first<{ reason: string }>();
  if (hold) return { ok: false, reason: 'domain_held' };
  // 「最後進度」順便更新：不然暫停很久之後一續寄，就被當成 Queue 卡住。
  // 只有「讓這期停下來的那一道煞車」從續寄這一刻重新起算（ackBrake＋brakeSince）：人查過的就是那一項。
  // 為了別的原因暫停（人工、Queue 卡住、對帳…）再續寄，比率照舊全部算，不會被清零。
  const c = await getCampaign(db, id);
  const m = /^brake:(hard_bounce_rate|complaint_rate|wave_gate)\b/.exec(c?.pause_reason ?? '');
  const t = nowIso(opts.now);
  return move(
    db, id, ['paused'], 'sending',
    "pause_reason = NULL, last_progress_at = ?, waiting_since = NULL, counts = json_set(COALESCE(counts, '{}'), '$.lastResumeNote', ?, '$.ackBrake', ?, '$.brakeSince', ?)",
    [t, n, m ? m[1] : null, m ? t : null], opts.now,
  );
}

/**
 * 取消：開寄前（draft／approved／scheduled）或暫停中才能取消；寄送中要先暫停。
 * 暫停中取消：還沒寄的人記成 skipped／cancelled（已經交出去的那幾封由派送端看到 cancelled 後跳過）。
 */
export async function cancelCampaign(db: Db, id: string, reason: string, now?: () => Date): Promise<Ok<{ status: CampaignStatus }> | Fail> {
  const r = cleanText(reason, LIMITS.reason);
  if (!r) return { ok: false, reason: 'reason_required' };
  const out = await move(db, id, ['draft', 'approved', 'scheduled', 'paused'], 'cancelled', 'pause_reason = ?, finished_at = ?', [`cancelled: ${r}`, nowIso(now)], now);
  if (out.ok) {
    await db.prepare("UPDATE campaign_recipients SET state = 'skipped', skip_reason = 'cancelled' WHERE campaign_id = ? AND state IN ('planned', 'enqueued')").bind(id).run();
  }
  return out;
}

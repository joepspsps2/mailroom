// 郵務室（mailroom）：多個站共用的寄信 Worker。運作說明見 README。
//
// 兩個入口：
// - 內線（service binding）：同一個 Cloudflare 帳號的站在 wrangler.jsonc 加
//   { "binding": "MAILROOM", "service": "mailroom", "entrypoint": "Mailroom" }，呼叫 env.MAILROOM.send({...})。
// - 公開網址（workers.dev）：Resend 事後回報 POST /webhooks/resend；SES 事後回報（SNS）POST /webhooks/ses；
//   別的 Cloudflare 帳號的站帶自己的鑰匙 POST /v1/send；演習 POST /v1/drill；寄信統計 GET /v1/report；
//   人工解除拒收 POST /v1/unsuppress。
// - 退訂：GET／POST /u/{券}、POST /u/{券}/resubscribe；email() 收退訂信。
// - 追蹤（TRACK_BASE_URL 那個 host）：GET /c/{券} 點擊轉址、GET /o/{券}.gif 開信圖（見 src/track.ts、docs/tracking.md）。
// - 名單管理（帶管理口令）：PUT /v1/lists/{id}、POST /v1/lists/{id}/import、POST /v1/lists/{id}/segments。
// - 群發（帶管理口令）：/v1/campaigns/*、/v1/throttle、/v1/warmup/*、/v1/broadcast/*（見 src/broadcast/routes.ts）；Queue mailroom-broadcast；排程每分鐘放水。
// - Queue：Cloudflare 寄信的事後回報（cf-events.ts）。
// - 排程：有設 cron 時，每次順手清舊計數窗；有設 DAILY_DRILL 時每天最多寄一輪演習信（過了 until 自動停）；有設 LEDGER_RETENTION_DAYS 時清過期帳本列。

import { WorkerEntrypoint } from 'cloudflare:workers';
import { bodySizeProblem, checkHttpFrom, limitVar, localDay, lookup, parseAddress, pruneRate, purgeLedger, removeSuppression, retentionDays, send, SUPPRESSION_REASONS, takeRate, TIERS, type SuppressionReason, type CoreDeps, type MessageRow, type RouteTable, type SendRequest, type SendResult, type Tier } from './core.ts';
import { handleCfEvent } from './cf-events.ts';
import { listMembers, listStatus, listUnsubscribe, type SubscribeInput, type SubscribeResult, type UnsubscribeInput } from './lists.ts';
import { subscribeWithWelcome, type WelcomeQueue } from './welcome.ts';
import { bearer, json, notFound, sameToken } from './http.ts';
import { ADMIN_LIMITS, routeLists } from './list-routes.ts';
import { routeExport } from './export.ts';
import { handleUnsubRequest, unsubscribeLinksForEmail, unsubSecrets, type UnsubLinks } from './unsub.ts';
import { flushUnsubAlerts, handleEmailMessage, unsubConfig } from './unsub-wiring.ts';
import { warnIfNoAlert } from './alert.ts';
import { MAIL_ROUTES, type CloudflareSender, type MailRoute } from './transport.ts';
import { handleEvent, verifySignature } from './webhook.ts';
import { handleSesWebhook } from './ses-events.ts';
import { handleBroadcastRequest, isBroadcastPath } from './broadcast/routes.ts';
import { broadcastDeps, broadcastQueue, broadcastTick, isBroadcastBatch, testSendDeps, type BroadcastEnv } from './broadcast/worker.ts';
import { handleTrackRequest, resolveTrackSettings, trackHost, trackSecrets } from './track.ts';

export interface Env extends BroadcastEnv {
  DB: D1Database;
  /** 第一層（一定要到）的寄件網域，例 notify.example.com。 */
  FROM_DOMAIN: string;
  /** 第二層（服務提醒）的寄件網域，例 remind.example.com。沒設＝第二層不收。 */
  REMIND_DOMAIN?: string;
  /** 郵差順序表（JSON 物件，鍵＝`站:層`／`*:層`）。改這裡＋部署＝換郵差順序／退回原狀。 */
  ROUTES?: RouteTable | string;
  /** Cloudflare 寄信綁定（send_email），只准第二層的寄件地址。 */
  EMAIL?: SendEmail;
  /** 第二層專用的 Resend 鑰匙（只能從第二層網域寄）；沒放＝第二層備援跳過 Resend。 */
  RESEND_API_KEY_REMIND?: string;
  /** 每日演習：{ until: 'YYYY-MM-DD'（含當天；日期照 utcOffsetHours，預設 UTC）, to: [...], site, tier, routes?, utcOffsetHours? }。 */
  DAILY_DRILL?: DailyDrill | string;
  /** 走公開網址寄信的站（逗號分隔，例 "shop"）；每站一把 Secret：HTTP_KEY_<站名大寫>。 */
  HTTP_CLIENTS?: string;
  /** 走公開網址的站每分鐘最多幾次請求（預設 60；鑰匙外洩時的上限）。 */
  HTTP_RATE_PER_MIN?: string | number;
  /** 走公開網址的站每天最多幾次請求（預設 2000，UTC 日）。 */
  HTTP_DAILY_LIMIT?: string | number;
  /** 走公開網址的站准用的寄件地址（JSON：{ "站": ["app@notify.example.com"] }）。每個 HTTP client 都必須列；沒列的站一律拒收（from_allowlist_required）。 */
  HTTP_FROM?: Record<string, string[]> | string;
  /** 帳本保存天數（正整數）。設了之後，排程（cron）每次會順手清掉超過天數的 messages 與 webhook_events；沒設＝不自動清。 */
  LEDGER_RETENTION_DAYS?: string | number;
  RESEND_API_KEY?: string;
  SMTP2GO_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  /** 管理口令（演習、查帳、統計、解除拒收）；沒設＝這些路徑一律 404。 */
  DRILL_TOKEN?: string;
  /** 退訂券簽章鑰匙（Secret，至少 16 字元）。沒設＝退訂端點回 503。 */
  UNSUB_TOKEN_SECRET?: string;
  /** 換鑰匙過渡期：舊鑰匙（逗號分隔），只用來驗證、不簽新券。過了過渡期就拿掉。 */
  UNSUB_TOKEN_SECRET_PREVIOUS?: string;
  /** 退訂網址的開頭（https，不含結尾斜線），例 https://u.example.com。 */
  UNSUB_BASE_URL?: string;
  /** 收退訂信的地址（Email Routing 轉進本 Worker 的 email()），例 unsubscribe@mail.example.com。 */
  UNSUB_MAILTO?: string;
  /** 讀者退訂沒成功時的告警 webhook（https，POST JSON：event、from、subject、token、at、text）。沒設＝只寫 log，並警告。見 docs/unsubscribe.md。 */
  UNSUB_ALERT_WEBHOOK?: string;
  /** 選填：告警 webhook 的 Bearer 口令（Secret）。 */
  UNSUB_ALERT_TOKEN?: string;
  /** 退訂頁文字（JSON 物件，只寫想改的欄位，見 docs/unsubscribe.md）。 */
  UNSUB_PAGE?: string | Record<string, unknown>;
  /** SES 事件入口准收的 SNS 主題 ARN（逗號分隔）。沒設（或沒設 SES_REGION、SES_CONFIGURATION_SET）＝POST /webhooks/ses 一律 404。 */
  SES_SNS_TOPIC_ARNS?: string;
  /** "true"＝也收 SNS SignatureVersion 1（SHA1）。預設只收 2，主題請設 SignatureVersion=2。 */
  SES_SNS_ALLOW_SHA1?: string;
  [key: `HTTP_KEY_${string}`]: string | undefined;
}

/** 公開網址入口每站每分鐘預設上限。 */
const DEFAULT_HTTP_RATE_PER_MIN = 60;
/** 公開網址入口每站每天預設上限。 */
const DEFAULT_HTTP_DAILY_LIMIT = 2000;
/** 請求內文上限（位元組，一定要帶 content-length）：寄信 3 MB（內文上限 html 40 萬＋text 20 萬字元，中文 UTF-8 一字 3 bytes）、webhook 256 KB。 */
const MAX_SEND_BYTES = 3_000_000;
const MAX_WEBHOOK_BYTES = 256_000;


interface DailyDrill { until: string; to: string[]; site?: string; tier?: Tier; routes?: MailRoute[]; utcOffsetHours?: number }

function jsonVar<T>(v: T | string | undefined): T | undefined {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as T;
  } catch {
    console.error('bad json var');
    return undefined;
  }
}

function deps(env: Env): CoreDeps {
  const base = { resend: env.RESEND_API_KEY, smtp2go: env.SMTP2GO_API_KEY };
  return {
    db: env.DB,
    keys: base,
    fromDomain: env.FROM_DOMAIN,
    tierDomains: env.REMIND_DOMAIN ? { remind: env.REMIND_DOMAIN } : {},
    // 第二層：Resend 用自己的鑰匙（Resend 鑰匙綁網域）；Cloudflare 綁定只給第二層。
    tierKeys: { remind: { resend: env.RESEND_API_KEY_REMIND, smtp2go: env.SMTP2GO_API_KEY, cloudflare: env.EMAIL as unknown as CloudflareSender | undefined } },
    routes: jsonVar<RouteTable>(env.ROUTES),
  };
}

export type DrillMode = 'fallback' | 'normal';
export interface DrillInput { to: string; mode?: DrillMode; key?: string; tier?: Tier; only?: MailRoute }

/**
 * 演習信：fallback 故意給錯的 Resend 鑰匙（Resend 真的回 401）→ 應改走下一個郵差；normal 走正式路徑。
 * tier＝哪一層（寄件網域跟著換）；only＝只走這一個郵差（看單一郵差能不能寄、簽章對不對）。
 */
async function drill(env: Env, site: string, input: DrillInput): Promise<SendResult & { row: MessageRow | null }> {
  const mode: DrillMode = input.mode === 'normal' ? 'normal' : 'fallback';
  const tier: Tier = input.tier && TIERS.includes(input.tier) ? input.tier : 'notify';
  const only = input.only && MAIL_ROUTES.includes(input.only) ? input.only : undefined;
  const domain = tier === 'remind' ? env.REMIND_DOMAIN : env.FROM_DOMAIN;
  const stamp = new Date().toISOString();
  const label = [site, tier, only ? `only-${only}` : mode].join(' / ');
  // 演習的去重鍵一律加 drill: 前綴：不能拿演習去搶真信的去重鍵（否則那封真信會被當成已寄）。
  const raw = input.key || `${tier}:${only ?? mode}:${stamp}`;
  const key = raw.startsWith('drill:') ? raw : `drill:${raw}`;
  const result = await send(
    deps(env),
    {
      site, key, tier, kind: 'drill', to: input.to,
      from: `Mailroom drill <mailroom@${domain ?? 'unset.invalid'}>`,
      subject: `[mailroom drill] ${label} ${stamp}`,
      text: `This is a mailroom delivery drill (${label}). No reply needed.\n${stamp}`,
      html: `<p>This is a mailroom delivery drill (${label}). No reply needed.</p><p>${stamp}</p>`,
    },
    { forceInvalidResend: !only && mode === 'fallback', routes: only ? [only] : undefined },
  );
  return { ...result, row: await lookup(env.DB, site, key) };
}


/** 試跑期每日演習：每個收件人一封，同一天同一人只寄一次（去重鍵含日期）。 */
async function dailyDrill(env: Env, now = new Date()): Promise<string[]> {
  const cfg = jsonVar<DailyDrill>(env.DAILY_DRILL);
  if (!cfg || !Array.isArray(cfg.to) || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.until ?? '')) return [];
  const day = localDay(now, cfg.utcOffsetHours);
  if (day > cfg.until) return [];
  const out: string[] = [];
  for (const to of cfg.to) {
    const only = cfg.routes && cfg.routes.length === 1 ? cfg.routes[0] : undefined;
    const r = await drill(env, cfg.site || 'drill', { to, mode: 'normal', tier: cfg.tier, only, key: `daily:${day}:${to.toLowerCase()}` });
    out.push(`${r.status}:${r.route ?? '-'}`);
  }
  return out;
}

/** 最近 N 天的寄信統計（試跑驗收用）：依站、層、郵差、結果、事後回報分組。不含收件人。 */
async function report(env: Env, days: number) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT site, tier, route, status, COALESCE(last_event, '-') AS last_event, COUNT(*) AS n,
            SUBSTR(to_email, INSTR(to_email, '@') + 1) AS to_domain
       FROM messages WHERE created_at >= ? GROUP BY site, tier, route, status, last_event, to_domain ORDER BY site, tier, n DESC`,
  ).bind(since).all();
  const suppressions = await env.DB.prepare('SELECT reason, source, COUNT(*) AS n FROM suppressions WHERE created_at >= ? GROUP BY reason, source').bind(since).all();
  return { since, rows: rows.results, suppressions: suppressions.results };
}

/** 內線入口（RPC）。 */
export class Mailroom extends WorkerEntrypoint<Env> {
  send(req: SendRequest): Promise<SendResult> {
    return send(deps(this.env), req);
  }
  lookup(site: string, key: string): Promise<MessageRow | null> {
    return lookup(this.env.DB, site, key);
  }
  drill(site: string, input: DrillInput) {
    return drill(this.env, site, input);
  }
  // 電子報名單（內線）：見 docs/lists.md。
  /** 加入名單。第一次加入（firstTime）而且群發總開關開著、這份名單的歡迎信打開時，排一封歡迎信（見 src/welcome.ts）。 */
  async listSubscribe(input: SubscribeInput): Promise<SubscribeResult> {
    // 總開關＝群發設得起來（寄件網域、郵差、Queue 都有）；關著就一封都不排。排信失敗不影響加入結果。
    let switchOn = false;
    try {
      switchOn = broadcastDeps(this.env) !== null;
    } catch {
      switchOn = false;
    }
    return subscribeWithWelcome(this.env.DB, input, { queue: this.env.BROADCAST as unknown as WelcomeQueue | undefined, switchOn });
  }
  listUnsubscribe(input: UnsubscribeInput) {
    return listUnsubscribe(this.env.DB, input);
  }
  listStatus(input: { list: string; email: string }) {
    return listStatus(this.env.DB, input);
  }
  listMembers(input: { list: string; status?: 'subscribed' | 'unsubscribed'; cursor?: string | null; limit?: number }) {
    return listMembers(this.env.DB, input);
  }
  /** 某人的退訂連結與兩個一鍵退訂標頭（url／mailto 對應 compose 的 unsubscribe_url／unsubscribe_mailto）；不是成員＝null。 */
  async unsubscribeLinks(input: { list: string; email: string; campaign?: string | null }): Promise<UnsubLinks | null> {
    const cfg = unsubConfig(this.env);
    return unsubscribeLinksForEmail(this.env.DB, cfg.secrets, { baseUrl: this.env.UNSUB_BASE_URL ?? '', mailtoAddress: this.env.UNSUB_MAILTO }, input);
  }
}

/** 帶鑰匙的站：鑰匙決定是哪個站，站名不聽請求本身的。 */
function clientSite(env: Env, token: string): string | null {
  for (const site of (env.HTTP_CLIENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (sameToken(token, env[`HTTP_KEY_${site.toUpperCase().replace(/-/g, '_')}`] ?? '')) return site;
  }
  return null;
}

/** 公開網址查帳只回狀態欄位，不回收件人、寄件人、主旨（口令外洩時不會變成查收件人的工具）。 */
function publicRow(row: MessageRow | null) {
  if (!row) return null;
  const { id, stream, tier, site, dedupe_key, kind, status, route, attempts, last_event, error, last_error, created_at, updated_at, sent_at } = row;
  return { id, stream, tier, site, dedupe_key, kind, status, route, attempts, last_event, error, last_error, created_at, updated_at, sent_at };
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 開信與點擊追蹤：只在 TRACK_BASE_URL 的 host 上接 /c/、/o/；鑰匙或網址沒設＝不處理。
    const tHost = trackHost(env.TRACK_BASE_URL);
    if (tHost && url.hostname.toLowerCase() === tHost) {
      const site = (jsonVar<Record<string, unknown>>(env.BROADCAST_CONFIG) ?? {}).site;
      const tracked = await handleTrackRequest(request, {
        db: env.DB,
        secrets: trackSecrets(env.TRACK_TOKEN_SECRET, env.TRACK_TOKEN_SECRET_PREVIOUS),
        host: tHost,
        settings: resolveTrackSettings(env.TRACK_CONFIG, typeof site === 'string' ? site : undefined),
        waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined,
      });
      if (tracked) return tracked;
    }

    if (url.pathname === '/webhooks/resend' && request.method === 'POST') {
      const size = bodySizeProblem(request.headers.get('content-length'), MAX_WEBHOOK_BYTES);
      if (size) return new Response(size, { status: size === 'missing' ? 411 : 413 });
      const body = await request.text();
      const h = request.headers;
      const ok = await verifySignature(env.RESEND_WEBHOOK_SECRET ?? '', h.get('svix-id') ?? '', h.get('svix-timestamp') ?? '', h.get('svix-signature') ?? '', body);
      if (!ok) return new Response('bad signature', { status: 401 });
      const outcome = await handleEvent(env.DB, h.get('svix-id') ?? '', body);
      console.log('resend webhook', outcome);
      return json({ ok: true });
    }

    if (url.pathname === '/webhooks/ses' && request.method === 'POST') {
      const topicArns = (env.SES_SNS_TOPIC_ARNS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      // 設定組也要有：沒有就無法只收自己的事件（同一個主題裡別的寄信會混進來），一律不收。
      if (!topicArns.length || !env.SES_REGION || !env.SES_CONFIGURATION_SET) return notFound();
      const size = bodySizeProblem(request.headers.get('content-length'), MAX_WEBHOOK_BYTES);
      if (size) return new Response(size, { status: size === 'missing' ? 411 : 413 });
      const r = await handleSesWebhook(env.DB, await request.text(), { region: env.SES_REGION, topicArns, configurationSet: env.SES_CONFIGURATION_SET, allowSha1: env.SES_SNS_ALLOW_SHA1 === 'true' }, request.headers.get('x-amz-sns-message-type'));
      (r.status === 200 ? console.log : console.warn)('ses webhook', r.status, r.outcome.slice(0, 200));
      return new Response(r.status === 200 ? 'ok' : 'rejected', { status: r.status });
    }

    if (url.pathname === '/v1/send' && request.method === 'POST') {
      const site = clientSite(env, bearer(request));
      if (!site) return notFound();
      const limits = {
        perMinute: limitVar(env.HTTP_RATE_PER_MIN, DEFAULT_HTTP_RATE_PER_MIN),
        perDay: limitVar(env.HTTP_DAILY_LIMIT, DEFAULT_HTTP_DAILY_LIMIT),
      };
      const over = await takeRate(env.DB, site, limits);
      // 舊計數窗順手清（約每 100 次請求一次），不另開排程。
      if (Math.random() < 0.01) await pruneRate(env.DB).catch((e) => console.error('prune rate failed', e instanceof Error ? e.message : 'unknown'));
      if (over) {
        console.warn('http client rate limited', site, over);
        return new Response(JSON.stringify({ status: 'failed', retryable: true, reason: `rate_limited_${over}` }), {
          status: 429,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': over === 'day' ? '3600' : '60' },
        });
      }
      const size = bodySizeProblem(request.headers.get('content-length'), MAX_SEND_BYTES);
      if (size) return json({ status: 'rejected', retryable: false, reason: size === 'missing' ? 'length_required' : 'too_large' }, size === 'missing' ? 411 : 413);
      const req = (await request.json().catch(() => null)) as SendRequest | null;
      if (!req || typeof req !== 'object') return json({ status: 'rejected', retryable: false, reason: 'bad_json' }, 400);
      // 白名單有設但讀不懂（JSON 寫壞）＝設定錯誤，整個入口先不收；不能當成「沒設」放行。
      const fromTable = jsonVar<Record<string, string[]>>(env.HTTP_FROM);
      if (env.HTTP_FROM !== undefined && env.HTTP_FROM !== '' && (!fromTable || typeof fromTable !== 'object' || Array.isArray(fromTable))) {
        console.error('HTTP_FROM unreadable, refusing http sends');
        return json({ status: 'failed', retryable: true, reason: 'config_error' }, 500);
      }
      const fromProblem = checkHttpFrom(fromTable, site, req.from);
      if (fromProblem === 'allowlist_required') {
        // 沒列白名單就拒收：預設不能是「這把鑰匙可以用整個網域任一地址寄」。
        console.warn('http client without HTTP_FROM allowlist, refusing', site);
        return json({ status: 'rejected', retryable: false, reason: 'from_allowlist_required' }, 403);
      }
      if (fromProblem) return json({ status: 'rejected', retryable: false, reason: 'from_not_allowed' }, 400);
      const result = await send(deps(env), { ...req, site });
      return json(result, result.status === 'rejected' ? 400 : result.status === 'failed' ? 502 : 200);
    }

    // 名單管理入口（帶管理口令）：見 list-routes.ts。
    const listResponse = await routeLists(request, env.DB, env.DRILL_TOKEN, env.MARKETING_DOMAIN);
    if (listResponse) return listResponse;

    // 分析匯出（帶管理口令）：見 export.ts。
    const exportResponse = await routeExport(request, env.DB, env.DRILL_TOKEN);
    if (exportResponse) return exportResponse;

    // 退訂頁與一鍵退訂：GET /u/{券}（確認頁）、POST /u/{券}、POST /u/{券}/resubscribe。
    const unsubResponse = await handleUnsubRequest(env.DB, unsubConfig(env), request);
    if (unsubResponse) return unsubResponse;

    // 群發管理入口（帶管理口令）。
    if (isBroadcastPath(url.pathname)) {
      if (!sameToken(bearer(request), env.DRILL_TOKEN ?? '') || !env.MARKETING_DOMAIN) return notFound();
      const adminOver = await takeRate(env.DB, '_admin', ADMIN_LIMITS);
      if (adminOver) return new Response('rate limited', { status: 429, headers: { 'retry-after': adminOver === 'day' ? '3600' : '60' } });
      if (request.method !== 'GET') {
        const size = bodySizeProblem(request.headers.get('content-length'), MAX_SEND_BYTES);
        if (size) return json({ ok: false, reason: size === 'missing' ? 'length_required' : 'too_large' }, size === 'missing' ? 411 : 413);
      }
      const config = { ...(jsonVar<Record<string, unknown>>(env.BROADCAST_CONFIG) ?? {}), ...(env.NEWSLETTER_MAX_PER_DAY !== undefined ? { maxPerDay: env.NEWSLETTER_MAX_PER_DAY } : {}) };
      return (await handleBroadcastRequest(request, url, { db: env.DB, domain: env.MARKETING_DOMAIN.toLowerCase(), config: config as never, test: testSendDeps(env) })) ?? notFound();
    }

    const postPaths = ['/v1/drill', '/v1/unsuppress'];
    const tokenPaths = [...postPaths, '/v1/lookup', '/v1/report'];
    if (tokenPaths.includes(url.pathname) && (request.method === 'POST') === postPaths.includes(url.pathname)) {
      if (!sameToken(bearer(request), env.DRILL_TOKEN ?? '')) return notFound();
      // 管理入口也有速度上限（站名用 _admin，不會跟真站撞：站名規則不准底線開頭）。
      const adminOver = await takeRate(env.DB, '_admin', ADMIN_LIMITS);
      if (adminOver) return new Response('rate limited', { status: 429, headers: { 'retry-after': adminOver === 'day' ? '3600' : '60' } });
      if (Math.random() < 0.05) await pruneRate(env.DB).catch((e) => console.error('prune rate failed', e instanceof Error ? e.message : 'unknown'));
      if (url.pathname === '/v1/unsuppress') {
        const body = (await request.json().catch(() => null)) as { email?: unknown; reasons?: unknown } | null;
        const email = typeof body?.email === 'string' ? body.email.trim() : '';
        const reasons = Array.isArray(body?.reasons) ? body.reasons : [];
        if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320) return json({ ok: false, reason: 'bad_email' }, 400);
        if (!reasons.length || !reasons.every((r) => SUPPRESSION_REASONS.includes(r as SuppressionReason))) return json({ ok: false, reason: 'bad_reasons' }, 400);
        const removed = await removeSuppression(env.DB, email, [...new Set(reasons as SuppressionReason[])]);
        console.log('manual unsuppress', removed.join(',') || 'none');
        return json({ ok: true, removed });
      }
      if (url.pathname === '/v1/lookup') return json(publicRow(await lookup(env.DB, url.searchParams.get('site') ?? '', url.searchParams.get('key') ?? '')));
      if (url.pathname === '/v1/report') return json(await report(env, Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90)));
      const body = (await request.json().catch(() => ({}))) as DrillInput & { site?: string };
      const result = await drill(env, body.site || 'drill', { to: String(body.to ?? ''), mode: body.mode, key: body.key, tier: body.tier, only: body.only });
      return json({ ...result, row: publicRow(result.row) }, result.status === 'failed' ? 502 : 200);
    }

    if (url.pathname === '/' && request.method === 'GET') return new Response('mailroom', { status: 200 });
    return notFound();
  },

  /** Cloudflare 寄信的事後回報（wrangler.jsonc 的 queues.consumers）。處理失敗的那則讓 Queue 重送。 */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (isBroadcastBatch(env, batch.queue)) return broadcastQueue(env, batch.messages);
    for (const msg of batch.messages) {
      try {
        const outcome = await handleCfEvent(env.DB, msg.body);
        if (outcome !== 'event:delivered' && outcome !== 'repeat') console.log('cloudflare email event', outcome);
        msg.ack();
      } catch (error) {
        console.error('cloudflare email event failed', error instanceof Error ? error.message : 'unknown');
        msg.retry();
      }
    }
  },

  /** 退訂信（Cloudflare Email Routing）：主旨帶退訂券就退訂；沒成功的情況都通知人工，見 unsub-wiring.ts。 */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmailMessage(env.DB, env, message);
  },

  /** 試跑期每日演習（DAILY_DRILL）。 */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // 群發先跑（煞車不能被後面的雜事拖累）：每分鐘放水、踩煞車、寄完對帳；沒設定群發就什麼都不做。
    await broadcastTick(env).catch((e) => console.error('broadcast tick failed', e instanceof Error ? e.message : 'unknown'));
    warnIfNoAlert(env.UNSUB_ALERT_WEBHOOK);
    await flushUnsubAlerts(env).catch((e) => console.error('unsub alert flush failed', e instanceof Error ? e.message : 'unknown'));
    const out = await dailyDrill(env);
    if (out.length) console.log('daily drill', out.join(','));
    const days = retentionDays(env.LEDGER_RETENTION_DAYS);
    if (days !== null) {
      try {
        const n = await purgeLedger(env.DB, days);
        if (n.messages || n.webhookEvents) console.log('ledger purge', n.messages, n.webhookEvents);
      } catch (e) {
        console.error('ledger purge failed', e instanceof Error ? e.message : 'unknown');
      }
    }
    await pruneRate(env.DB).catch((e) => console.error('prune rate failed', e instanceof Error ? e.message : 'unknown'));
  },
} satisfies ExportedHandler<Env>;

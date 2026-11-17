// 郵務室（mailroom）：多個站共用的寄信 Worker。運作說明見 README。
//
// 兩個入口：
// - 內線（service binding）：同一個 Cloudflare 帳號的站在 wrangler.jsonc 加
//   { "binding": "MAILROOM", "service": "mailroom", "entrypoint": "Mailroom" }，呼叫 env.MAILROOM.send({...})。
// - 公開網址（workers.dev）：Resend 事後回報 POST /webhooks/resend；
//   別的 Cloudflare 帳號的站帶自己的鑰匙 POST /v1/send；演習 POST /v1/drill；寄信統計 GET /v1/report；
//   人工解除拒收 POST /v1/unsuppress。
// - Queue：Cloudflare 寄信的事後回報（cf-events.ts）。
// - 排程：有設 cron 與 DAILY_DRILL 時，每天最多寄一輪演習信（過了 until 自動停）。

import { WorkerEntrypoint } from 'cloudflare:workers';
import { bodySizeProblem, limitVar, localDay, lookup, parseAddress, pruneRate, removeSuppression, send, SUPPRESSION_REASONS, takeRate, TIERS, type SuppressionReason, type CoreDeps, type MessageRow, type RouteTable, type SendRequest, type SendResult, type Tier } from './core.ts';
import { handleCfEvent } from './cf-events.ts';
import { MAIL_ROUTES, type CloudflareSender, type MailRoute } from './transport.ts';
import { handleEvent, verifySignature } from './webhook.ts';

export interface Env {
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
  /** 走公開網址的站准用的寄件地址（JSON：{ "站": ["app@notify.example.com"] }）。沒列的站＝該層網域內任一地址（並記警告）。 */
  HTTP_FROM?: Record<string, string[]> | string;
  RESEND_API_KEY?: string;
  SMTP2GO_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  /** 管理口令（演習、查帳、統計、解除拒收）；沒設＝這些路徑一律 404。 */
  DRILL_TOKEN?: string;
  [key: `HTTP_KEY_${string}`]: string | undefined;
}

/** 公開網址入口每站每分鐘預設上限。 */
const DEFAULT_HTTP_RATE_PER_MIN = 60;
/** 公開網址入口每站每天預設上限。 */
const DEFAULT_HTTP_DAILY_LIMIT = 2000;
/** 管理口令入口（演習、查帳、統計、解除拒收）合計上限：口令外洩時，別人拿它也寄不了多少演習信。 */
const ADMIN_LIMITS = { perMinute: 20, perDay: 200 };
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
}

function sameToken(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(request: Request): string {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
  return m ? m[1].trim() : '';
}

/** 帶鑰匙的站：鑰匙決定是哪個站，站名不聽請求本身的。 */
function clientSite(env: Env, token: string): string | null {
  for (const site of (env.HTTP_CLIENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (sameToken(token, env[`HTTP_KEY_${site.toUpperCase().replace(/-/g, '_')}`] ?? '')) return site;
  }
  return null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const notFound = () => new Response('Not found', { status: 404 });

/** 公開網址查帳只回狀態欄位，不回收件人、寄件人、主旨（口令外洩時不會變成查收件人的工具）。 */
function publicRow(row: MessageRow | null) {
  if (!row) return null;
  const { id, stream, tier, site, dedupe_key, kind, status, route, attempts, last_event, error, created_at, updated_at, sent_at } = row;
  return { id, stream, tier, site, dedupe_key, kind, status, route, attempts, last_event, error, created_at, updated_at, sent_at };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
      const allowed = fromTable?.[site];
      if (allowed) {
        const from = parseAddress(String(req.from ?? ''));
        if (!from || !allowed.map((a) => a.toLowerCase()).includes(from.addr)) return json({ status: 'rejected', retryable: false, reason: 'from_not_allowed' }, 400);
      } else {
        console.warn('http client without HTTP_FROM allowlist', site);
      }
      const result = await send(deps(env), { ...req, site });
      return json(result, result.status === 'rejected' ? 400 : result.status === 'failed' ? 502 : 200);
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

  /** 試跑期每日演習（DAILY_DRILL）。 */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const out = await dailyDrill(env);
    if (out.length) console.log('daily drill', out.join(','));
  },
} satisfies ExportedHandler<Env>;

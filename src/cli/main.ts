// 電子報櫃台的指令（AI 用）：建一期、預覽、寄測試信、核准、排程、開寄、看進度、暫停、放行、取消、重試、對帳、解除網域停寄。
// 每個會改狀態的指令：沒有 --yes 就只演練（dry-run），印出「會做什麼」；有 --yes 才真的做。
// 輸出：給人看的摘要；加 --json 改成一個 JSON 物件（給程式讀）。錯誤講清楚下一步，結束碼 1（用法錯誤 2）。
// 預設值（名單代號、寄件人、樣板、測試信箱…）由部署端傳入 runCli 的 defaults，引擎本身不帶任何自家資訊。
import { compose, createTemplate, preflight, type ComposeOptions, type PreflightResult } from '../compose/index.ts';
import { parseArgs } from './args.ts';
import { friendly } from './errors.ts';

export interface CliDefaults {
  /** 管理入口網址（沒給就讀環境變數 MAILROOM_URL）。 */
  baseUrl?: string;
  list?: string;
  /** 寄件人（含顯示名稱，例 `Weekly <news@mail.example.com>`）。 */
  from?: string;
  replyTo?: string;
  /** 預設收件群：{ plan: 'ramp' } 或 { waves: [...] }。 */
  audience?: unknown;
  /** 測試信的預設收件信箱。 */
  testRecipients?: string[];
  /** 測試信主旨前綴（預設 `[Test] `）。 */
  subjectPrefix?: string;
  /** 本地時間的時差，預設 +08:00。 */
  utcOffset?: string;
  /** createTemplate 的設定（品牌、頁尾、實體地址…）。 */
  template?: Parameters<typeof createTemplate>[0];
  /** compose 的固定選項（trackBase、siteBase、assetBase、utm…）。 */
  composeDefaults?: Partial<ComposeOptions>;
  /** 用 `--post <代號>` 找原稿：回傳原稿路徑、原稿位置標記（記進 sourceRef）、網頁版網址。 */
  sourceFor?: (post: string) => { path: string; ref?: string; webUrl?: string };
  /** 由原稿 frontmatter 推網頁版網址（沒給 --web-url 時用）。 */
  webUrlFor?: (frontmatter: Record<string, string>) => string | undefined;
  /** 擁有者看預覽的網址。 */
  previewUrl?: (id: string) => string;
}

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  fetch: typeof fetch;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, body: string) => Promise<void>;
  now: () => Date;
}

export interface RunOptions { defaults?: CliDefaults; env?: Record<string, string | undefined>; io?: Partial<CliIo> }

const VALUES = ['issue', 'source', 'post', 'web-url', 'list', 'from', 'subject', 'audience', 'source-ref', 'to', 'note', 'reason', 'at', 'out', 'contact', 'as', 'tz', 'base-url'];
const BOOLEANS = ['yes', 'json', 'offline', 'force', 'release-domain', 'to-defaults', 'help'];

class CliError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

const HELP = `mailroom campaign <command> [options]

Read-only:
  status <id>                 progress, brake light, why it paused, what to do next
  audience <id>               who would receive it if it started now
  reconcile <id>              check frozen = sent + skipped + failed (safe to repeat)
  throttle                    today's budget, provider health, domain hold
Changes state (dry-run unless --yes is given):
  create --issue <id> (--source <file.md> | --post <name>) [--web-url U] [--list L] [--subject S] [--audience JSON|plan] [--offline] --yes
  preview <id> [--out DIR] --yes        mark the current content as previewed (needed before approve)
  test <id> (--to a@x,b@x | --to-defaults) --yes
  approve <id> --note "who, when, where" --yes
  schedule <id> --at "2027-03-01 09:00" --yes    unschedule <id> --yes
  start <id> --yes            schedule for right now
  pause <id> --reason "..." --yes
  resume <id> --note "what was checked" [--release-domain] [--force] --yes     (alias: release)
  cancel <id> --reason "..." --yes
  retry-failed <id> --yes     resolve <id> --contact N --as sent|failed --note "..." --yes
  hold release --note "..." --yes        release the sender-domain hold
Options: --json (machine-readable output), --base-url, --tz +08:00
Environment: MAILROOM_URL, MAILROOM_ADMIN_TOKEN`;

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function offsetOf(s: string | undefined): string {
  const v = s ?? '+08:00';
  if (!/^[+-]\d{2}:\d{2}$/.test(v)) throw new CliError(`bad time zone "${v}": use +08:00 style`, 2);
  return v;
}

/** 「2027-03-01 09:00」（本地時間）或完整 ISO → ISO（UTC）。 */
export function parseAt(input: string, offset: string): string | null {
  const s = input.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(s);
  const iso = local ? `${local[1]}T${local[2]}:${local[3] ?? '00'}${offset}` : /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(s) ? s : null;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export async function runCli(argv: readonly string[], opts: RunOptions = {}): Promise<number> {
  const d = opts.defaults ?? {};
  const env = opts.env ?? {};
  const io: CliIo = {
    out: opts.io?.out ?? ((s) => console.log(s)),
    err: opts.io?.err ?? ((s) => console.error(s)),
    fetch: opts.io?.fetch ?? fetch,
    // 檔案讀寫由入口（bin/mailroom.mjs）注入：這支不碰 node 內建模組，型別檢查與 Worker 打包都乾淨。
    readFile: opts.io?.readFile ?? (async () => { throw new Error('file access not provided'); }),
    writeFile: opts.io?.writeFile ?? (async () => { throw new Error('file access not provided'); }),
    now: opts.io?.now ?? (() => new Date()),
  };
  const words = [...argv];
  if (words[0] === 'campaign') words.shift();
  const parsed = parseArgs(words, { values: VALUES, booleans: BOOLEANS });
  let json = false;
  try {
    if ('error' in parsed) throw new CliError(`${parsed.error}\n\n${HELP}`, 2);
    const { positional, flags } = parsed;
    json = flags.json === true;
    if (flags.help === true || positional.length === 0) {
      io.out(HELP);
      return positional.length === 0 && flags.help !== true ? 2 : 0;
    }
    const cmd = positional[0];
    const baseUrl = String(flags['base-url'] ?? d.baseUrl ?? env.MAILROOM_URL ?? '').replace(/\/+$/, '');
    const token = env.MAILROOM_ADMIN_TOKEN ?? '';
    const yes = flags.yes === true;
    const idArg = (): string => {
      const id = positional[1];
      if (!id || !ID.test(id)) throw new CliError(`${cmd} needs an issue id (lowercase letters, digits, hyphens).`, 2);
      return id;
    };
    const need = (name: string): string => {
      const v = flags[name];
      if (typeof v !== 'string' || !v.trim()) throw new CliError(`--${name} is required for ${cmd}.`, 2);
      return v.trim();
    };

    async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
      if (!baseUrl || !token) throw new CliError('Missing connection settings.\nNext: set MAILROOM_URL and MAILROOM_ADMIN_TOKEN (or pass --base-url), then run again.');
      let res: Response;
      try {
        res = await io.fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        throw new CliError(`Could not reach the mailroom (${e instanceof Error ? e.message.slice(0, 100) : 'network error'}).\nNext: check MAILROOM_URL and the network, then run again. Nothing was changed.`);
      }
      const text = await res.text();
      let b: Record<string, any> = {};
      try {
        b = text ? JSON.parse(text) : {};
      } catch {
        if (res.status === 404 || res.status === 401) throw new CliError(`The mailroom answered ${res.status} without details.\nNext: check MAILROOM_ADMIN_TOKEN, and that the newsletter desk is enabled on this deployment.`);
        if (res.status === 429) throw new CliError('Rate limited by the mailroom (admin calls are limited per minute).\nNext: wait a minute and run again.');
        throw new CliError(`Unexpected answer (${res.status}) from the mailroom.\nNext: try again; if it repeats, look at the Worker logs.`);
      }
      return { status: res.status, body: b };
    }
    /** 呼叫並把失敗翻成人話。 */
    async function call(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
      const r = await api(method, path, body);
      if (r.status >= 400 || r.body.ok === false) {
        const extra = r.body.twin ? `The existing issue is "${r.body.twin}".` : r.body.status ? `Current state: ${r.body.status}.` : r.body.error ? String(r.body.error) : undefined;
        throw new CliError(friendly(String(r.body.reason ?? `http_${r.status}`), extra));
      }
      return r.body;
    }
    const emit = (human: string[], data: Record<string, unknown>) => io.out(json ? JSON.stringify({ ok: true, command: cmd, ...data }) : human.join('\n'));
    const dry = (what: string[], data: Record<string, unknown>) => {
      emit([...what, '', 'DRY RUN: nothing was changed. Add --yes to do it.'], { dryRun: true, ...data });
      return 0;
    };

    switch (cmd) {
      case 'throttle': {
        const t = await call('GET', '/v1/throttle');
        emit([`domain ${t.domain}  day ${t.day}`, t.hold ? `DOMAIN ON HOLD: ${t.hold.reason} (since ${t.hold.created_at})` : 'domain: not on hold', `issues in flight: ${t.campaigns.map((c: any) => `${c.id}(${c.status})`).join(', ') || 'none'}`], { throttle: t });
        return 0;
      }
      case 'status': {
        const id = idArg();
        const [s, t] = await Promise.all([call('GET', `/v1/campaigns/${id}`), call('GET', '/v1/throttle')]);
        const light = brakeLight(s, t);
        const lines = [`${id}: ${s.status}${s.pauseReason ? ` (${s.pauseReason})` : ''}   brake light: ${light.icon} ${light.text}`, `subject: ${s.subject}`];
        if (s.scheduledAt && s.status === 'scheduled') lines.push(`scheduled for ${s.scheduledAt}`);
        if (s.status === 'draft' || s.status === 'approved') lines.push(`pre-send check: ${s.preflight ? (s.preflight.ok ? 'passed' : `FAILED (${(s.preflight.errors ?? []).join(', ')})`) : 'not run'}   previewed: ${s.previewed ? 'yes' : 'no'}   approved: ${s.approved ? `yes (${s.approvedNote})` : 'no'}`);
        const byState = new Map<string, number>();
        for (const r of s.recipients as { state: string; skip_reason: string | null; n: number }[]) byState.set(r.skip_reason ? `${r.state}/${r.skip_reason}` : r.state, (byState.get(r.skip_reason ? `${r.state}/${r.skip_reason}` : r.state) ?? 0) + Number(r.n));
        if (byState.size) lines.push(`recipients: ${[...byState.entries()].map(([k, n]) => `${k} ${n}`).join(', ')}`);
        const r = s.rates;
        if (r && r.sent > 0) lines.push(`so far: ${r.sent} sent, hard bounces ${r.hardBounces} (${pct(r.hardBounceRate)}), complaints ${r.complaints} (${pct(r.complaintRate)}), opens ${r.opens} (${pct(r.openRate)})`);
        if (t.hold) lines.push(`SENDER DOMAIN ON HOLD: ${t.hold.reason}`);
        if (s.pauseExplain) lines.push('', `why: ${s.pauseExplain.summary}`, ...(s.pauseExplain.threshold ? [`threshold: ${JSON.stringify(s.pauseExplain.threshold)}`] : []), `next: ${s.pauseExplain.suggestion}`, s.pauseExplain.needsDomainRelease ? `then: campaign resume ${id} --note "..." --release-domain --yes` : s.pauseExplain.resumable ? `then: campaign resume ${id} --note "..." --yes` : 'this one cannot simply be resumed: fix the cause first');
        else lines.push('', nextStep(s));
        emit(lines, { status: s, throttle: { hold: t.hold, day: t.day, today: t.today }, brakeLight: light });
        return 0;
      }
      case 'audience': {
        const a = await call('GET', `/v1/campaigns/${idArg()}/audience`);
        emit(audienceLines(a), { audience: a });
        return 0;
      }
      case 'reconcile': {
        const r = await call('POST', `/v1/campaigns/${idArg()}/reconcile`, {});
        emit([`reconcile: ${r.ok ? 'all numbers add up' : 'MISMATCH'}`, `frozen ${r.frozen} = sent ${r.sent} + skipped ${JSON.stringify(r.skipped)} + failed ${r.failed} + uncertain ${r.uncertain} + pending ${r.pending}`, ...(r.problems?.length ? [`problems: ${r.problems.join(', ')}`, 'Next: do not release the next warm-up step until a person has explained the differences.'] : []), ...(r.awaiting?.length ? [`still waiting for provider events: ${JSON.stringify(r.awaiting)} (run again after 72 hours)`] : [])], { reconcile: r });
        return r.ok ? 0 : 1;
      }
      case 'create': return await create();
      case 'preview': {
        const id = idArg();
        if (!yes) {
          const p = await call('GET', `/v1/campaigns/${id}/preview`);
          await writePreview(id, p);
          return dry(previewLines(id, p, false), { preview: slim(p) });
        }
        const p = await call('POST', `/v1/campaigns/${id}/preview`, {});
        await writePreview(id, p);
        emit(previewLines(id, p, true), { preview: slim(p), previewUrl: d.previewUrl?.(id) ?? null });
        return 0;
      }
      case 'test': {
        const id = idArg();
        const to = flags['to-defaults'] === true ? d.testRecipients ?? [] : typeof flags.to === 'string' ? flags.to.split(',').map((x) => x.trim()).filter(Boolean) : [];
        if (!to.length) throw new CliError('Give test addresses with --to a@x,b@x, or use --to-defaults (needs testRecipients in the defaults).', 2);
        if (!yes) return dry([`Would send a test copy of ${id} to: ${to.join(', ')} (subject prefix "${d.subjectPrefix ?? '[Test] '}", real headers, not counted in any statistics).`], { to });
        const r = await call('POST', `/v1/campaigns/${id}/test`, { to, ...(d.subjectPrefix !== undefined ? { subjectPrefix: d.subjectPrefix } : {}) });
        const bad = (r.results as { ok: boolean }[]).filter((x) => !x.ok).length;
        emit([...(r.results as { to: string; ok: boolean; error?: string }[]).map((x) => `${x.ok ? 'sent   ' : 'FAILED '} ${x.to}${x.error ? `  ${x.error}` : ''}`), bad ? 'Next: failed addresses were NOT retried automatically; check the reason, then run test again for them.' : 'Next: open the test mails in each mailbox (light and dark mode), then ask the owner to look at the preview.'], { results: r.results });
        return bad ? 1 : 0;
      }
      case 'approve': {
        const id = idArg();
        const note = need('note');
        const s = await call('GET', `/v1/campaigns/${id}`);
        const problems = [s.status !== 'draft' ? `state is ${s.status}, approve only works on a draft` : '', s.preflight?.ok !== true ? 'the pre-send check has not passed' : '', s.previewed ? '' : 'the current content has not been previewed (run preview --yes)'].filter(Boolean);
        if (problems.length) throw new CliError(`Cannot approve ${id}: ${problems.join('; ')}.\nNext: ${s.status !== 'draft' ? `campaign status ${id}` : s.preflight?.ok !== true ? 'fix the issues and run create again' : `campaign preview ${id} --yes`}`);
        if (!yes) return dry([`Would approve ${id} ("${s.subject}") with note: ${note}`, 'Only do this after the owner has looked at the preview and said yes.'], { note });
        const r = await call('POST', `/v1/campaigns/${id}/approve`, { note });
        emit([`${id}: ${r.status}`, `Next: campaign schedule ${id} --at "YYYY-MM-DD HH:MM" --yes`], { result: r });
        return 0;
      }
      case 'schedule':
      case 'start': {
        const id = idArg();
        const offset = offsetOf(typeof flags.tz === 'string' ? flags.tz : d.utcOffset);
        let at: string;
        if (cmd === 'start') at = new Date(io.now().getTime() + 1000).toISOString();
        else {
          const parsedAt = parseAt(need('at'), offset);
          if (!parsedAt) throw new CliError(friendly('bad_time'), 2);
          if (Date.parse(parsedAt) < io.now().getTime() - 60_000) throw new CliError(`${parsedAt} is in the past: scheduling it would start sending immediately.\nNext: pick a future time, or use \`campaign start ${id} --yes\` if you really mean now.`);
          at = parsedAt;
        }
        const a = await call('GET', `/v1/campaigns/${id}/audience`);
        const what = [cmd === 'start' ? `Would START ${id} NOW.` : `Would schedule ${id} for ${at}.`, '', ...audienceLines(a)];
        if (a.blocked) what.push('', `WARNING: this issue cannot start right now: ${a.blocked}`);
        if (!yes) return dry(what, { at, audience: a });
        const r = await call('POST', `/v1/campaigns/${id}/schedule`, { at });
        emit([...what, '', `${id}: ${r.status} at ${r.scheduledAt}`, 'Next: the per-minute job starts it at that time; watch it with `campaign status`.'], { result: r, audience: a });
        return 0;
      }
      case 'unschedule': {
        const id = idArg();
        if (!yes) return dry([`Would take ${id} off the schedule (back to approved).`], {});
        emit([`${id}: ${(await call('POST', `/v1/campaigns/${id}/unschedule`, {})).status}`], {});
        return 0;
      }
      case 'pause': {
        const id = idArg();
        const reason = need('reason');
        if (!yes) return dry([`Would pause ${id}: ${reason}. Mails already handed to the provider still go out; nothing new is handed over.`], { reason });
        emit([`${id}: ${(await call('POST', `/v1/campaigns/${id}/pause`, { reason })).status}`, `Next: when ready, campaign resume ${id} --note "..." --yes`], {});
        return 0;
      }
      case 'resume':
      case 'release': {
        const id = idArg();
        const note = need('note');
        const [s, t] = await Promise.all([call('GET', `/v1/campaigns/${id}`), call('GET', '/v1/throttle')]);
        if (s.status !== 'paused') throw new CliError(`${id} is ${s.status}, not paused: nothing to release.\nNext: campaign status ${id}`);
        const ex = s.pauseExplain;
        const lines = [`${id} is paused: ${s.pauseReason}`, ...(ex ? [`why: ${ex.summary}`, ...(ex.threshold ? [`threshold: ${JSON.stringify(ex.threshold)}`] : []), `suggestion: ${ex.suggestion}`] : [])];
        if (ex && !ex.resumable && flags.force !== true) throw new CliError(`${lines.join('\n')}\n\nThis pause is about a cause that must be fixed first; resuming would just stop again or send something wrong.\nNext: fix the cause, then run again with --force.`);
        const held = !!t.hold;
        if (held && flags['release-domain'] !== true) throw new CliError(`${lines.join('\n')}\n\nThe sender domain is on hold (${t.hold.reason}); that stops every newsletter, not only this issue.\nNext: if the numbers are explained, run again with --release-domain (it releases the hold with the same note, then resumes).`);
        const plan = [...lines, '', ...(held ? [`Would release the sender-domain hold (${t.hold.reason}).`] : []), `Would resume ${id} with note: ${note}`, ...(ex?.code === 'hard_bounce_rate' || ex?.code === 'complaint_rate' || ex?.code === 'wave_gate' ? ['That brake restarts counting from the resume.'] : [])];
        if (!yes) return dry(plan, { pauseExplain: ex ?? null, domainHold: t.hold ?? null });
        if (held) await call('POST', '/v1/broadcast/release-hold', { note });
        let r: Record<string, any>;
        try {
          r = await call('POST', `/v1/campaigns/${id}/resume`, { note });
        } catch (e) {
          throw new CliError(`${held ? 'The domain hold WAS released, but resuming failed:\n' : ''}${e instanceof Error ? e.message : String(e)}`);
        }
        emit([...plan, '', `${id}: ${r.status}`], { result: r, domainReleased: held });
        return 0;
      }
      case 'cancel': {
        const id = idArg();
        const reason = need('reason');
        if (!yes) return dry([`Would cancel ${id}: ${reason}. This cannot be undone; people not yet mailed are marked skipped/cancelled.`], { reason });
        emit([`${id}: ${(await call('POST', `/v1/campaigns/${id}/cancel`, { reason })).status}`], {});
        return 0;
      }
      case 'retry-failed': {
        const id = idArg();
        if (!yes) return dry([`Would retry the failed recipients of ${id} with the same de-duplication key (nobody gets two copies). Only works while the issue is sending or paused.`], {});
        const r = await call('POST', `/v1/campaigns/${id}/retry-failed`, {});
        emit([`${id}: ${r.requeued} recipient(s) queued again`, 'Next: if they fail again the reason is recorded; leave them.'], { result: r });
        return 0;
      }
      case 'resolve': {
        const id = idArg();
        const contact = Number(need('contact'));
        const as = need('as');
        if (!Number.isInteger(contact) || (as !== 'sent' && as !== 'failed')) throw new CliError('--contact must be a number and --as must be sent or failed.', 2);
        const note = need('note');
        if (!yes) return dry([`Would mark recipient ${contact} of ${id} as ${as} (they were "uncertain": the provider may or may not have accepted the mail). Note: ${note}`], {});
        emit([`${id}: recipient ${contact} marked ${as}`], { result: await call('POST', `/v1/campaigns/${id}/resolve`, { contact, as, note }) });
        return 0;
      }
      case 'hold': {
        if (positional[1] !== 'release') throw new CliError('Usage: hold release --note "..." --yes', 2);
        const note = need('note');
        const t = await call('GET', '/v1/throttle');
        if (!t.hold) throw new CliError('The sender domain is not on hold: nothing to release.');
        if (!yes) return dry([`Would release the sender-domain hold (${t.hold.reason}). Paused issues stay paused until resumed one by one.`], { hold: t.hold });
        emit([`released ${(await call('POST', '/v1/broadcast/release-hold', { note })).released} hold(s)`, 'Next: resume each paused issue with `campaign resume <id> --note "..." --yes`.'], {});
        return 0;
      }
      default:
        throw new CliError(`unknown command "${cmd}"\n\n${HELP}`, 2);
    }

    async function create(): Promise<number> {
      const issue = need('issue');
      if (!ID.test(issue)) throw new CliError('--issue: lowercase letters, digits and hyphens only (max 40).', 2);
      if (!d.template) throw new CliError('No email template is configured.\nNext: pass `template` in the defaults (see docs/composing.md).');
      const post = typeof flags.post === 'string' ? d.sourceFor?.(flags.post) : undefined;
      if (typeof flags.post === 'string' && !post) throw new CliError('--post needs `sourceFor` in the defaults; use --source <file.md> instead.', 2);
      const sourcePath = post?.path ?? (typeof flags.source === 'string' ? flags.source : '');
      if (!sourcePath) throw new CliError('Give the source with --source <file.md> (or --post <name>).', 2);
      let source: string;
      try {
        source = await io.readFile(sourcePath);
      } catch {
        throw new CliError(`Could not read the source file "${sourcePath}".\nNext: check the path.`);
      }
      const list = (typeof flags.list === 'string' ? flags.list : d.list) ?? '';
      const from = (typeof flags.from === 'string' ? flags.from : d.from) ?? '';
      if (!list || !from) throw new CliError('The list and the sender are required: pass --list/--from or set them in the defaults.', 2);
      let audience: unknown = d.audience;
      if (typeof flags.audience === 'string') {
        try {
          audience = flags.audience.trim().startsWith('{') ? JSON.parse(flags.audience) : { plan: flags.audience.trim() };
        } catch {
          throw new CliError('--audience must be a plan name or a JSON object like {"waves":[["*"]]}.', 2);
        }
      }
      if (!audience) throw new CliError('No audience: pass --audience or set it in the defaults.', 2);
      const template = createTemplate(d.template);
      const composed = compose({ ...d.composeDefaults, source, template, issue, ...(typeof flags.subject === 'string' ? { subject: flags.subject } : {}) });
      const webUrl = (typeof flags['web-url'] === 'string' ? flags['web-url'] : undefined) ?? post?.webUrl ?? d.webUrlFor?.(composed.frontmatter);
      if (!webUrl) throw new CliError('The web version URL is unknown.\nNext: pass --web-url https://... (the page of this issue on the website).', 2);
      const check: PreflightResult = await preflight(composed, { template, webUrl, checkLinks: flags.offline !== true, fetch: io.fetch });
      const errors = check.issues.filter((i) => i.severity === 'error');
      const lines = [
        `${issue}: "${composed.subject}"`, `from ${from}   list ${list}   web version ${webUrl}`, `HTML ${composed.htmlBytes} bytes, ${composed.links.length} links, ${composed.images.length} images`,
        `pre-send check: ${check.ok ? 'PASSED' : `FAILED (${errors.length} error${errors.length === 1 ? '' : 's'})`}`,
        ...check.issues.map((i) => `  [${i.severity}] ${i.code}: ${i.message}${i.where ? ` (${i.where})` : ''}`),
      ];
      const data = { issue, subject: composed.subject, checkOk: check.ok, issues: check.issues };
      if (!yes) return dry(lines, data);
      const sourceRef = (typeof flags['source-ref'] === 'string' ? flags['source-ref'] : undefined) ?? post?.ref ?? sourcePath;
      const saved = await call('PUT', `/v1/campaigns/${issue}`, { list, subject: composed.subject, preheader: composed.preheader || undefined, from, ...(d.replyTo ? { replyTo: d.replyTo } : {}), html: composed.html, text: composed.text, headers: composed.headers, webUrl, sourceRef, audience });
      const rec = await call('POST', `/v1/campaigns/${issue}/preflight`, { ok: check.ok, issues: check.issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message })) });
      emit([...lines, '', `saved as draft (${saved.changed ? 'new or changed' : 'unchanged'}); check recorded: ${rec.preflightOk ? 'passed' : 'failed'}`, rec.preflightOk ? `Next: campaign preview ${issue} --yes` : 'Next: fix the errors above in the source, then run create again (same id updates the draft).'], { ...data, saved, preflightOk: rec.preflightOk });
      return rec.preflightOk ? 0 : 1;
    }

    function previewLines(id: string, p: Record<string, any>, marked: boolean): string[] {
      const pf = p.preflight as { ok?: boolean; errors?: string[]; issues?: { severity: string; code: string; message: string }[] } | null;
      return [
        `${id}: "${p.subject}" (${p.status})`, `HTML ${p.htmlBytes} bytes   pre-send check: ${pf ? (pf.ok ? 'passed' : `FAILED (${(pf.errors ?? []).join(', ')})`) : 'not run'}`,
        ...(pf?.issues ?? []).map((i) => `  [${i.severity}] ${i.code}: ${i.message}`),
        marked ? 'marked as previewed (approval is now possible for this exact content)' : 'not marked as previewed (add --yes)',
        ...(d.previewUrl ? [`owner's preview page: ${d.previewUrl(id)}`] : []),
        ...(marked ? [`Next: ask the owner to look at the preview; after a clear yes: campaign approve ${id} --note "..." --yes`] : []),
      ];
    }
    async function writePreview(id: string, p: Record<string, any>): Promise<void> {
      const out = typeof flags.out === 'string' ? flags.out.replace(/\/+$/, '') : '';
      if (!out) return;
      await io.writeFile(`${out}/email.html`, String(p.html));
      await io.writeFile(`${out}/email.txt`, String(p.text));
      await io.writeFile(`${out}/email-no-name.html`, String(p.htmlNoName));
      await io.writeFile(`${out}/check.json`, JSON.stringify(p.preflight, null, 2));
    }
  } catch (e) {
    if (e instanceof CliError) {
      if (json) io.out(JSON.stringify({ ok: false, error: e.message }));
      else io.err(e.message);
      return e.code;
    }
    throw e;
  }
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const slim = (p: Record<string, any>) => ({ id: p.id, status: p.status, subject: p.subject, htmlBytes: p.htmlBytes, preflight: p.preflight, previewed: p.previewed });

function audienceLines(a: Record<string, any>): string[] {
  return [
    `audience${a.plan ? ` (warm-up plan ${a.plan}, step ${a.step})` : ''}: ${a.willSend} will receive it (of ${a.subscribed} subscribed)`,
    ...(a.waves as { wave: number; count: number; segments: { name: string; count: number }[] }[]).map((w) => `  wave ${w.wave}: ${w.count}  (${w.segments.map((s) => `${s.name} ${s.count}`).join(', ')})`),
    `skipped: ${a.skipped.suppressed} on the suppression list, ${a.skipped.warmup} not in this step of the warm-up`,
  ];
}

/** 煞車燈號：紅＝暫停或網域停寄；黃＝任何比率已到門檻的一半；綠＝其他。 */
function brakeLight(s: Record<string, any>, t: Record<string, any>): { icon: string; text: string } {
  if (t.hold) return { icon: 'RED', text: `sender domain on hold (${t.hold.reason})` };
  if (s.status === 'paused') return { icon: 'RED', text: 'paused' };
  const cfg = t.config ?? {};
  const r = s.rates ?? { sent: 0 };
  const near: string[] = [];
  if (r.sent >= 20 && cfg.brakeHardBounceRate && r.hardBounceRate >= cfg.brakeHardBounceRate / 2) near.push(`hard bounces ${pct(r.hardBounceRate)} (brake ${pct(cfg.brakeHardBounceRate)})`);
  if (r.complaints > 0 && cfg.brakeComplaintRate && r.complaintRate >= cfg.brakeComplaintRate / 2) near.push(`complaints ${r.complaints} (${pct(r.complaintRate)})`);
  return near.length ? { icon: 'YELLOW', text: near.join('; ') } : { icon: 'GREEN', text: 'no brake close' };
}

function nextStep(s: Record<string, any>): string {
  const id = s.id;
  switch (s.status) {
    case 'draft': return s.preflight?.ok ? (s.previewed ? `next: after the owner says yes, campaign approve ${id} --note "..." --yes` : `next: campaign preview ${id} --yes`) : 'next: fix the pre-send check errors and run create again';
    case 'approved': return `next: campaign schedule ${id} --at "YYYY-MM-DD HH:MM" --yes`;
    case 'scheduled': return 'next: nothing; it starts at the scheduled time (campaign unschedule to take it back)';
    case 'sending': return 'next: watch; campaign pause is the emergency stop';
    case 'done': return `next: campaign reconcile ${id} (again after 72 hours)`;
    default: return '';
  }
}

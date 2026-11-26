// 群發測試用的小世界：假時鐘、假 Queue（會延遲、會重送、會掉訊息）、假郵差（事件照延遲回來）。
import { listDb, count } from './lists-helpers.ts';
import { listSubscribe, setSegments, upsertList } from '../src/lists.ts';
import {
  approveCampaign, consumeBatch, FakePostman, ingestEvent, recordPreflight, saveDraft, scheduleCampaign, tick,
  type Audience, type BroadcastConfig, type BroadcastDeps, type BroadcastMessage, type FakePostmanOptions, type ProviderEvent, type TickReport,
} from '../src/broadcast/index.ts';

export const DOMAIN = 'mail.example.com';
export const START = Date.parse('2027-03-01T01:00:00.000Z'); // 台北 09:00

export interface QueuedMsg { body: BroadcastMessage; availableAt: number; tries: number }

export interface WorldOptions {
  members?: number;
  /** 第 i 個人的分群；預設全部 'core'。 */
  segmentOf?: (i: number) => string;
  /** 第 i 個人的地址；預設 r{i}@example.com。 */
  emailOf?: (i: number) => string;
  postman?: Omit<FakePostmanOptions, 'emit' | 'now'>;
  config?: Partial<BroadcastConfig>;
  start?: number;
  /** 事件要不要回來（false＝郵差不回報）。 */
  events?: boolean;
}

export async function makeWorld(opts: WorldOptions = {}) {
  const clock = { t: opts.start ?? START };
  const now = () => new Date(clock.t);
  const db = listDb();
  await upsertList(db, { id: 'weekly', name: 'Weekly' }, now);
  const n = opts.members ?? 20;
  const emailOf = opts.emailOf ?? ((i: number) => `r${i}@example.com`);
  const segmentOf = opts.segmentOf ?? (() => 'core');
  const segs = [];
  for (let i = 0; i < n; i++) {
    await listSubscribe(db, { list: 'weekly', email: emailOf(i), source: 'test' }, now);
    segs.push({ email: emailOf(i), segment: segmentOf(i) });
  }
  for (let i = 0; i < segs.length; i += 5000) await setSegments(db, 'weekly', segs.slice(i, i + 5000), now);

  const queue: QueuedMsg[] = [];
  const pendingEvents: { event: ProviderEvent; at: number }[] = [];
  const sentBatches: number[] = [];
  const postman = new FakePostman({
    ...opts.postman,
    now,
    emit: opts.events === false ? undefined : (event, delay) => void pendingEvents.push({ event, at: clock.t + delay }),
  });
  const alerts: string[] = [];
  const deps: BroadcastDeps = {
    db,
    postman,
    domain: DOMAIN,
    render: (c) => ({ html: c.html, text: c.text }),
    queue: {
      sendBatch: async (msgs) => {
        sentBatches.push(msgs.length);
        for (const m of msgs) queue.push({ body: m.body, availableAt: clock.t + (m.delaySeconds ?? 0) * 1000, tries: 0 });
      },
    },
    config: opts.config,
    now,
    sleep: async () => {},
    alert: (a) => void alerts.push(`${a.level}:${a.code}:${a.campaign ?? '-'}`),
  };

  async function flushEvents(): Promise<void> {
    pendingEvents.sort((a, b) => a.at - b.at);
    while (pendingEvents.length && pendingEvents[0].at <= clock.t) {
      const { event } = pendingEvents.shift()!;
      await ingestEvent(db, event, { now });
    }
  }

  /** 把現在可以取的 Queue 訊息一批 10 則交給消費端；retry 的放回去（照延遲）。duplicate＝模擬「至少一次」：每則 ack 後再送一次。 */
  async function drain(opts2: { duplicate?: boolean } = {}): Promise<void> {
    for (let guard = 0; guard < 100_000; guard++) {
      const ready = queue.filter((m) => m.availableAt <= clock.t).slice(0, 10);
      if (!ready.length) return;
      for (const m of ready) queue.splice(queue.indexOf(m), 1);
      const wrapped = ready.map((m) => ({
        body: m.body,
        ack: () => {
          if (opts2.duplicate && m.tries === 0) queue.push({ ...m, tries: 1, availableAt: clock.t });
        },
        retry: (o?: { delaySeconds?: number }) => void queue.push({ ...m, tries: m.tries + 1, availableAt: clock.t + (o?.delaySeconds ?? 0) * 1000 }),
      }));
      await consumeBatch(deps, wrapped);
    }
    throw new Error('drain did not settle');
  }

  const reports: TickReport[] = [];
  /** 跑 minutes 分鐘：每分鐘 事件→tick→消費→事件，時鐘 +1 分。 */
  async function run(minutes: number, o: { duplicate?: boolean; dropQueue?: boolean; until?: () => Promise<boolean> } = {}): Promise<void> {
    for (let i = 0; i < minutes; i++) {
      await flushEvents();
      reports.push(await tick(deps));
      if (o.dropQueue) queue.length = 0;
      else await drain({ duplicate: o.duplicate });
      clock.t += 30_000;
      await flushEvents();
      if (!o.dropQueue) await drain({ duplicate: o.duplicate });
      clock.t += 30_000;
      if (o.until && (await o.until())) return;
    }
  }

  async function campaign(id: string, audience: Audience = { waves: [['*']] }, at = clock.t): Promise<void> {
    const r1 = await saveDraft(db, { id, list: 'weekly', subject: `Issue ${id}`, from: `Weekly <news@${DOMAIN}>`, html: `<p>${id}</p>`, text: id, webUrl: `https://www.example.com/issues/${id}`, audience }, { marketingDomain: DOMAIN, now });
    if (!r1.ok) throw new Error(`saveDraft ${r1.reason}`);
    const r2 = await recordPreflight(db, id, { ok: true, issues: [] }, now);
    if (!r2.ok || !r2.preflightOk) throw new Error('preflight');
    const r3 = await approveCampaign(db, id, 'owner said yes in chat (test)', now);
    if (!r3.ok) throw new Error(`approve ${r3.reason}`);
    const r4 = await scheduleCampaign(db, id, new Date(at).toISOString(), now);
    if (!r4.ok) throw new Error(`schedule ${r4.reason}`);
  }

  const status = async (id: string) => (await db.prepare('SELECT status, pause_reason FROM campaigns WHERE id = ?').bind(id).first<{ status: string; pause_reason: string | null }>())!;
  const states = async (id: string) => {
    const rows = (await db.prepare('SELECT state, COALESCE(skip_reason, \'\') AS why, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? GROUP BY state, why').bind(id).all<{ state: string; why: string; n: number }>()).results;
    return Object.fromEntries(rows.map((r) => [r.why ? `${r.state}:${r.why}` : r.state, Number(r.n)]));
  };
  /** 每個地址收到幾封（假郵差確實收下的）。 */
  const perAddress = () => {
    const m = new Map<string, number>();
    for (const a of postman.accepted) m.set(`${a.tags.campaign}|${a.to}`, (m.get(`${a.tags.campaign}|${a.to}`) ?? 0) + 1);
    return m;
  };
  const maxPerAddress = () => Math.max(0, ...perAddress().values());

  return { clock, now, db, deps, postman, queue, pendingEvents, alerts, reports, sentBatches, run, drain, flushEvents, campaign, status, states, perAddress, maxPerAddress, count: (t: string, w?: string) => count(db, t, w) };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

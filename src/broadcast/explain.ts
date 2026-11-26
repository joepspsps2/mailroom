// 把「暫停原因」翻成人看得懂的說明：哪一道門檻、當時的分子分母、建議下一步。唯讀，不改任何狀態。
// 原因字串的格式由 dispatch.ts 的 brake() 寫入（brake:hard_bounce_rate:3/200、brake:wave_gate:wave1:2/30…）。

import type { BroadcastConfig } from './config.ts';

export interface PauseExplanation {
  /** 原因代碼（不含數字），例 hard_bounce_rate。 */
  code: string;
  /** 英文一句話，給人看。 */
  summary: string;
  /** 當時的分子與分母（有的話）。 */
  numerator?: number;
  denominator?: number;
  rate?: number;
  /** 這道門檻本身的設定。 */
  threshold?: Record<string, number>;
  /** 建議的下一步（指令名稱＋要先查什麼）。 */
  suggestion: string;
  /** 放行前要先解除整個寄件網域停寄。 */
  needsDomainRelease: boolean;
  /** 這個原因能不能直接放行：false＝要先修好根因（例如渲染出錯、對帳不符）。 */
  resumable: boolean;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

export function explainPause(reason: string | null | undefined, cfg: BroadcastConfig): PauseExplanation | null {
  if (!reason) return null;
  const nd = /(\d+)\/(\d+)\s*$/.exec(reason);
  const n = nd ? Number(nd[1]) : undefined;
  const d = nd ? Number(nd[2]) : undefined;
  const rate = n !== undefined && d !== undefined ? ratio(n, d) : undefined;
  const base = { numerator: n, denominator: d, rate };
  const m = /^brake:([a-z_]+)/.exec(reason);
  const code = m ? m[1] : (reason.split(':')[0] ?? reason).trim();

  switch (code) {
    case 'hard_bounce_rate':
      return { code, ...base, summary: `Hard bounces reached the issue brake: ${n} of ${d} sent.`, threshold: { hardBounceRate: cfg.brakeHardBounceRate, minSent: cfg.brakeMinSent }, suggestion: 'Check the bounce reasons and the list source; resume only if the bounces are explained (counting restarts from the resume).', needsDomainRelease: false, resumable: true };
    case 'complaint_rate':
      return { code, ...base, summary: `Complaints reached the issue brake: ${n} of ${d} sent.`, threshold: { complaintCount: cfg.brakeComplaintCount, complaintRate: cfg.brakeComplaintRate }, suggestion: 'Look at who complained (their segment and source) before resuming; complaints are the strongest signal to providers.', needsDomainRelease: false, resumable: true };
    case 'wave_gate':
      return { code, ...base, summary: `The previous wave had too many hard bounces to open the next wave: ${n} of ${d} sent.`, threshold: { waveGateBounceRate: cfg.waveGateBounceRate, waveGateMinSent: cfg.waveGateMinSent }, suggestion: 'Small waves make this brake touchy: check whether the bounces are real (same domain? typos?) and consider raising waveGateMinSent.', needsDomainRelease: false, resumable: true };
    case 'domain_hold': {
      const dr = /(?:bounce_rate|complaint_rate):(\d+)\/(\d+)/.exec(reason);
      const dn = dr ? Number(dr[1]) : undefined;
      const dd = dr ? Number(dr[2]) : undefined;
      const isComplaint = reason.includes('complaint_rate');
      return { code, numerator: dn, denominator: dd, rate: dn !== undefined && dd !== undefined ? ratio(dn, dd) : undefined, summary: `The sender domain is on hold: ${isComplaint ? 'complaints' : 'hard bounces'} ${dn} of ${dd} sent in the rolling window.`, threshold: isComplaint ? { complaintRate: cfg.domainComplaintRate, minSent: cfg.domainMinSent, minComplaints: cfg.domainMinComplaints } : { hardBounceRate: cfg.domainBounceRate, minSent: cfg.domainMinSent }, suggestion: 'All newsletters on the domain stopped. Check the numbers (a single complaint can trip it on a small sample), then release the domain hold and resume.', needsDomainRelease: true, resumable: true };
    }
    case 'queue_stalled':
      return { code, summary: `Work was handed to the queue but nothing came back for ${cfg.stallMinutes} minutes.`, threshold: { stallMinutes: cfg.stallMinutes }, suggestion: 'Check the queue and consumer logs (and the dead-letter queue) first; resume once results flow again.', needsDomainRelease: false, resumable: true };
    case 'provider_enforcement':
    case 'provider_account_paused':
      return { code, summary: `The provider reports the account is not healthy (${reason.split(':').slice(2).join(':') || code}).`, suggestion: 'Look at the provider console. Do not resume until the provider says the account is healthy again.', needsDomainRelease: false, resumable: true };
    case 'start_stale':
      return { code, summary: `The issue started but not one mail was handed to the provider within ${cfg.startGraceMinutes} minutes.`, threshold: { startGraceMinutes: cfg.startGraceMinutes }, suggestion: 'Usually the provider limits could not be read when it started (key or API problem) or the queue is not moving. Fix that first; resuming restarts the timer.', needsDomainRelease: false, resumable: true };
    case 'permanent_streak':
      return { code, summary: `Sending stopped after ${reason.split(':')[2] ?? cfg.permanentStreak} permanent failures in a row.`, suggestion: 'A run of permanent failures usually means a configuration problem (sender, domain verification, key), not bad addresses. Fix the cause before resuming.', needsDomainRelease: false, resumable: false };
    case 'freeze_blocked':
      return { code, summary: `The list could not be frozen: ${reason.split(':').slice(2).join(':')}.`, suggestion: 'Fix the audience or warm-up plan, then cancel and rebuild this issue.', needsDomainRelease: false, resumable: false };
    case 'reconcile_mismatch':
      return { code, summary: `Reconciliation does not add up: ${reason.slice(reason.indexOf(':') + 1)}.`, suggestion: 'Run the reconcile command and read the differences; do not resume until a person has explained them.', needsDomainRelease: false, resumable: false };
    case 'render_error':
    case 'rejected':
      return { code, summary: `Sending stopped on an error: ${reason.slice(reason.indexOf(':') + 1)}.`, suggestion: 'This is a configuration or content problem, not a rate. Fix the cause before resuming.', needsDomainRelease: false, resumable: false };
    case 'manual':
    case 'cancelled':
      return { code, summary: `Paused by a person: ${reason.slice(reason.indexOf(':') + 1).trim()}`, suggestion: 'Resume with a note when the reason no longer applies.', needsDomainRelease: false, resumable: code === 'manual' };
    default:
      return { code, summary: `Paused: ${reason}`, suggestion: 'Unknown reason: read the issue status before resuming.', needsDomainRelease: false, resumable: true };
  }
}

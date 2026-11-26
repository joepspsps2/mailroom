// 群發的設定值（門檻、配速、暖機過關條件）。引擎給保守預設值；部署端用 JSON 只覆寫想改的欄位。

export interface BroadcastConfig {
  /** 電子報那類帳本列的「站名」（messages.site）。 */
  site: string;
  /** 自己的每日上限（防程式錯誤一次寄爆），跟郵差給的每日上限取小。 */
  maxPerDay: number;
  /** 每分鐘放水最多用到郵差每秒上限的幾成（×60）。 */
  rateFactor: number;
  /** 一期要拉多長寄完（分鐘）：每分鐘放水 ≤ ceil(這期要寄的人數 ÷ 這個數)。 */
  paceMinutes: number;
  /** 下一波最早在上一波開始後幾分鐘開始。 */
  waveGapMinutes: number;
  /** 上一波最後一封寄出後，至少等幾分鐘收退信，才判斷能不能開下一波。 */
  waveGateWaitMinutes: number;
  /** 上一波的永久退信率達到（≥）這個值，下一波不開、這期暫停。 */
  waveGateBounceRate: number;
  /** 本期寄出滿這麼多封，才開始算「寄到一半停」的比率。 */
  brakeMinSent: number;
  /** 本期永久退信率 ≥ 這個值 → 暫停本期。 */
  brakeHardBounceRate: number;
  /** 本期檢舉件數 ≥ 這個值、且檢舉率 ≥ brakeComplaintRate → 暫停本期。 */
  brakeComplaintCount: number;
  brakeComplaintRate: number;
  /** 寄件網域的滾動退信率 ≥ 這個值 → 整個寄件網域停寄。 */
  domainBounceRate: number;
  /** 寄件網域的滾動檢舉率 ≥ 這個值 → 整個寄件網域停寄。 */
  domainComplaintRate: number;
  /** 滾動比率看最近幾天寄出的信。 */
  domainWindowDays: number;
  /** 視窗內寄出少於這個數，不算滾動比率（樣本太小）。 */
  domainMinSent: number;
  /** 寄件網域檢舉率要停整個網域，除了比率之外，視窗內至少要有這麼多件檢舉（預設 1＝沒有額外下限，照原本規則）。樣本小時 1 件就過線，試寄演練前依實況決定要不要調高。 */
  domainMinComplaints: number;
  /** 分波閘門要判斷上一波，至少要有這麼多封已寄出（預設 1＝沒有額外下限）。每波人數少時 1 封退信就會讓比率過線。 */
  waveGateMinSent: number;
  /** 已排程的期過了原定時間超過這麼多分鐘還沒開寄（郵差不健康、網域停寄、Worker 停擺…），就退回「已核准」等人重排，不自動開寄。 */
  startGraceMinutes: number;
  /** 「已交 Queue」超過幾分鐘沒有結果 → 退回待放水、重新放（去重鍵保證不重寄）。 */
  stuckMinutes: number;
  /** 有交出去的工作、卻這麼多分鐘沒有任何一封有結果 → 判定 Queue 壞了，暫停本期。 */
  stallMinutes: number;
  /** 同一人暫時失敗最多試幾次，之後記成失敗。 */
  maxAttempts: number;
  /** 最近連續這麼多位都被郵差永久拒收（中間沒有寄成功的）→ 暫停本期（多半是設定問題）。 */
  permanentStreak: number;
  /** 郵差回限流時，那一封幾秒後再試。 */
  throttleRetrySeconds: number;
  /** 「今天」的時差（小時），每日上限以這個日期換日。 */
  utcOffsetHours: number;
  /** 多久重新讀一次郵差的上限與健康狀態（分鐘）。 */
  limitsRefreshMinutes: number;
  /** 暖機過關：上一期結束後滿幾小時才評。 */
  gateWaitHours: number;
  /** 暖機過關：永久退信率要 ≤ 這個值。 */
  gateBounceRate: number;
  /** 暖機過關：檢舉率要 ≤ 這個值。 */
  gateComplaintRate: number;
  /** 暖機過關：開信率不得比同一批人的基準低超過這麼多（0.05＝5 個百分點）。 */
  gateOpenDrop: number;
  /** 連續幾期不過關 → 這條梯子鎖住，要明確解鎖才繼續寄。 */
  gateMaxFails: number;
}

export const DEFAULT_BROADCAST_CONFIG: Readonly<BroadcastConfig> = Object.freeze({
  site: 'newsletter',
  maxPerDay: 3000,
  rateFactor: 0.8,
  paceMinutes: 150,
  waveGapMinutes: 60,
  waveGateWaitMinutes: 30,
  waveGateBounceRate: 0.02,
  brakeMinSent: 200,
  brakeHardBounceRate: 0.04,
  brakeComplaintCount: 3,
  brakeComplaintRate: 0.001,
  domainBounceRate: 0.04,
  domainComplaintRate: 0.0008,
  domainWindowDays: 30,
  domainMinSent: 200,
  domainMinComplaints: 1,
  waveGateMinSent: 1,
  startGraceMinutes: 360,
  stuckMinutes: 10,
  stallMinutes: 30,
  maxAttempts: 3,
  permanentStreak: 5,
  throttleRetrySeconds: 30,
  utcOffsetHours: 8,
  limitsRefreshMinutes: 60,
  gateWaitHours: 72,
  gateBounceRate: 0.02,
  gateComplaintRate: 0.001,
  gateOpenDrop: 0.05,
  gateMaxFails: 2,
});

const SITE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * 合併設定：只收「型別對、數值合理」的欄位，其他一律用預設值（寫錯不能變成「不設防」）。
 * 比率要在 0～1 之間；次數、分鐘要是正數。
 */
export function resolveConfig(over?: Partial<BroadcastConfig> | string | null): BroadcastConfig {
  let o: Record<string, unknown> = {};
  if (typeof over === 'string') {
    try {
      const parsed = JSON.parse(over);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) o = parsed;
    } catch {
      console.error('bad broadcast config json');
    }
  } else if (over && typeof over === 'object') o = over as Record<string, unknown>;
  const out: BroadcastConfig = { ...DEFAULT_BROADCAST_CONFIG };
  for (const key of Object.keys(DEFAULT_BROADCAST_CONFIG) as (keyof BroadcastConfig)[]) {
    const v = o[key];
    if (v === undefined || v === null) continue;
    if (key === 'site') {
      if (typeof v === 'string' && SITE.test(v)) out.site = v;
      continue;
    }
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    const isRate = key.endsWith('Rate') || key === 'rateFactor' || key === 'gateOpenDrop';
    if (isRate ? n < 0 || n > 1 : key === 'utcOffsetHours' ? n < -14 || n > 14 : n <= 0) continue;
    (out as unknown as Record<string, number>)[key] = n;
  }
  return out;
}

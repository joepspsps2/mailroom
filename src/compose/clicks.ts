// 假點擊標記：資安掃描器會在信寄出後立刻把信裡的連結全部點一遍，這些點擊不是人點的。
// 這裡只放判斷規則（純函式）；事件的記錄與寫入屬轉址服務那一側，它拿到點擊清單後呼叫這個函式，
// 對回傳的點擊在事件的 detail 寫 suspect='scanner'。只標記、不刪除；報表算點擊時排除。

export interface ClickEvent {
  /** 事件編號（任意唯一值，原樣回傳）。 */
  id: string;
  /** 哪一封信（一位收件人一期＝一封）。 */
  messageId: string;
  /** 點的是第幾個連結（compose 的 links[].index）。 */
  linkIndex: number;
  /** 點擊時間（毫秒）。 */
  at: number;
}

export interface ScannerRule {
  /** 寄出後幾毫秒內的點擊才算（預設 60 秒）。 */
  windowMs?: number;
  /** 窗內同一封信點了幾個「不同連結」以上就判定（預設 3）。 */
  minDistinctLinks?: number;
}

/**
 * 規則：寄出後 60 秒內、同一封信點了 3 個以上不同連結 → 這封信窗內的所有點擊都標為疑似掃描器。
 * @param sentAt 每封信的寄出時間（毫秒）；查不到寄出時間的信不標記。
 * @returns 要標 suspect='scanner' 的事件編號。
 */
export function detectScannerClicks(clicks: ClickEvent[], sentAt: Map<string, number> | Record<string, number>, rule: ScannerRule = {}): Set<string> {
  const windowMs = rule.windowMs ?? 60_000;
  const minLinks = rule.minDistinctLinks ?? 3;
  const sent = (m: string): number | undefined => (sentAt instanceof Map ? sentAt.get(m) : Object.prototype.hasOwnProperty.call(sentAt, m) ? sentAt[m] : undefined);
  const byMessage = new Map<string, ClickEvent[]>();
  for (const c of clicks) {
    const t0 = sent(c.messageId);
    if (t0 === undefined || c.at < t0 || c.at - t0 > windowMs) continue;
    const list = byMessage.get(c.messageId) ?? [];
    list.push(c);
    byMessage.set(c.messageId, list);
  }
  const flagged = new Set<string>();
  for (const list of byMessage.values()) {
    if (new Set(list.map((c) => c.linkIndex)).size >= minLinks) for (const c of list) flagged.add(c.id);
  }
  return flagged;
}

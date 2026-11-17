// 測試用：Node 內建 SQLite 包成 D1 那一小塊介面，跑 migrations/ 同一份 SQL。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { Db, Stmt } from '../src/core.ts';

export function memoryDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) raw.exec(readFileSync(new URL(f, dir), 'utf8'));
  const make = (sql: string, values: unknown[] = []): Stmt => ({
    bind: (...v: unknown[]) => make(sql, v),
    first: async <T>() => ((raw.prepare(sql).get(...(values as never[])) as T | undefined) ?? null),
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...(values as never[])).changes) } }),
    all: async <T>() => ({ results: raw.prepare(sql).all(...(values as never[])) as T[] }),
  });
  return { raw, prepare: (sql: string) => make(sql) };
}

export type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** 假郵差：依網址回 Resend／SMTP2GO 的回應，記下每一次呼叫。 */
export function fakeFetch(plan: { resend?: number | 'throw' | (() => number | 'throw'); smtp2go?: number | 'fail' | 'throw' }, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body ?? '{}')) });
    if (url.includes('resend')) {
      const r = typeof plan.resend === 'function' ? plan.resend() : plan.resend ?? 200;
      if (r === 'throw') throw new Error('network down');
      return new Response(JSON.stringify(r < 300 ? { id: 're_123' } : { name: 'validation_error' }), { status: r });
    }
    const s = plan.smtp2go ?? 200;
    if (s === 'throw') throw new Error('network down');
    if (s === 'fail') return new Response(JSON.stringify({ data: { succeeded: 0, error_code: 'E_ApiResponseCodes.X' } }), { status: 200 });
    return new Response(JSON.stringify({ data: { succeeded: 1, email_id: 's2g_1' } }), { status: s });
  }) as typeof fetch;
}

// 名單測試用：在 memoryDb 上補 D1 的 batch（整批同一個交易，失敗就整批退回）。
import type { Stmt } from '../src/core.ts';
import type { ListDb } from '../src/lists.ts';
import { memoryDb } from './helpers.ts';

export function listDb(withBatch = true): ListDb & { raw: ReturnType<typeof memoryDb>['raw'] } {
  const base = memoryDb();
  const db: ListDb & { raw: typeof base.raw } = { raw: base.raw, prepare: base.prepare };
  if (withBatch) {
    db.batch = async (stmts: Stmt[]) => {
      base.raw.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        base.raw.exec('COMMIT');
        return out;
      } catch (e) {
        base.raw.exec('ROLLBACK');
        throw e;
      }
    };
  }
  return db;
}

export const count = (db: { raw: ReturnType<typeof memoryDb>['raw'] }, table: string, where = '1=1'): number =>
  Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n);

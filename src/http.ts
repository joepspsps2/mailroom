// 小工具：比對口令、讀 Bearer。獨立成檔，路由模組與測試不必 import cloudflare:workers。

export function sameToken(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearer(request: Request): string {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
  return m ? m[1].trim() : '';
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export const notFound = () => new Response('Not found', { status: 404 });

// AWS Signature Version 4（只用 WebCrypto，不裝 AWS SDK、不加相依套件）。
// 只做郵務室用得到的那一小塊：一個 HTTPS 請求、標頭簽章（Authorization 標頭）、內文整段雜湊。
// 規格：https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
// 測試用 AWS 官方 SigV4 測試向量（tests/aws-sigv4.test.ts）。
// 不 import cloudflare:*；鑰匙不進 log、不進錯誤訊息。

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** 臨時憑證才有。 */
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: string;
  /** 要一起簽的標頭（host 與 x-amz-date 會自動補上）。 */
  headers?: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now?: Date;
  /** 測試向量不簽 x-amz-content-sha256；正式送 AWS 也不需要（S3 才要）。 */
  contentSha256Header?: boolean;
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', Uint8Array.from(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

/** RFC 3986 編碼（AWS 版本：保留 A-Z a-z 0-9 - _ . ~，其他一律 %XX 大寫）。 */
export function uriEncode(s: string, keepSlash = false): string {
  let out = '';
  for (const b of enc.encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([uriEncode(k), uriEncode(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function canonicalPath(url: URL): string {
  // 非 S3 服務：路徑每一段各自再編碼一次（URL 物件給的已經是編碼過一次的樣子）。
  const path = url.pathname || '/';
  return path.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).join('/') || '/';
}

export function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
}

/** 簽好的標頭（含 authorization、x-amz-date、host）。呼叫端把它們原樣放進 fetch。 */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const date = amzDate(input.now ?? new Date());
  const day = date.slice(0, 8);
  const body = input.body ?? '';
  const payloadHash = await sha256Hex(body);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host = url.host;
  headers['x-amz-date'] = date;
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;
  if (input.contentSha256Header) headers['x-amz-content-sha256'] = payloadHash;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath(url), canonicalQuery(url), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, await sha256Hex(canonicalRequest)].join('\n');
  let key = await hmac(`AWS4${input.credentials.secretAccessKey}`, day);
  key = await hmac(key, input.region);
  key = await hmac(key, input.service);
  key = await hmac(key, 'aws4_request');
  const signature = hex(await hmac(key, stringToSign));
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

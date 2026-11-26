// SigV4：用 AWS 官方 SigV4 測試向量（aws-sig-v4-test-suite 的 get-vanilla 等，憑證是官方範例值）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, uriEncode } from '../src/aws-sigv4.ts';

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const now = new Date('2015-08-30T12:36:00Z');
const base = { region: 'us-east-1', service: 'service', credentials, now };
const sig = (h: Record<string, string>) => /Signature=([0-9a-f]{64})$/.exec(h.authorization)?.[1];

test('官方向量 get-vanilla', async () => {
  const h = await signRequest({ ...base, method: 'GET', url: 'https://example.amazonaws.com/' });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(h['x-amz-date'], '20150830T123600Z');
});

test('官方向量 post-vanilla', async () => {
  const h = await signRequest({ ...base, method: 'POST', url: 'https://example.amazonaws.com/' });
  assert.equal(sig(h), '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b');
});

test('官方向量 post-x-www-form-urlencoded（內文與 content-type 一起簽）', async () => {
  const h = await signRequest({ ...base, method: 'POST', url: 'https://example.amazonaws.com/', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'Param1=value1' });
  assert.match(h.authorization, /SignedHeaders=content-type;host;x-amz-date,/);
  assert.equal(sig(h), 'ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a');
});

test('官方向量 get-vanilla-query-order-key-case（查詢參數排序）', async () => {
  const h = await signRequest({ ...base, method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1' });
  assert.equal(sig(h), 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
});

test('任何一個輸入變了，簽章就不同；臨時憑證帶 security token 並簽進去', async () => {
  const a = sig(await signRequest({ ...base, method: 'POST', url: 'https://example.amazonaws.com/', body: '{"a":1}' }));
  const b = sig(await signRequest({ ...base, method: 'POST', url: 'https://example.amazonaws.com/', body: '{"a":2}' }));
  const c = sig(await signRequest({ ...base, region: 'us-west-2', method: 'POST', url: 'https://example.amazonaws.com/', body: '{"a":1}' }));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  const t = await signRequest({ ...base, credentials: { ...credentials, sessionToken: 'token-example' }, method: 'GET', url: 'https://example.amazonaws.com/' });
  assert.equal(t['x-amz-security-token'], 'token-example');
  assert.match(t.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);
});

test('uriEncode：保留 unreserved，其餘 %XX 大寫，UTF-8', () => {
  assert.equal(uriEncode('a b/c~d'), 'a%20b%2Fc~d');
  assert.equal(uriEncode('a/b', true), 'a/b');
  assert.equal(uriEncode('中'), '%E4%B8%AD');
});

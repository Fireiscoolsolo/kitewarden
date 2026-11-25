// The redaction rules alone: what must go, and what must stay readable.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MASK, isSecretName, redactBody, redactHeaders, redactText, redactUrl, redactValue } from '../../shared/redact.mjs';

const SECRET = ['password', 'passwd', 'pwd', 'user_password', 'passwordHash', 'new-password', 'secret', 'clientSecret', 'client_secret', 'token', 'access_token', 'refreshToken', 'id_token', 'csrf', 'csrf_token', 'X-CSRF-Token', 'xsrf', 'auth', 'x-auth', 'Authorization', 'apiKey', 'api_key', 'x-api-key', 'accessKey', 'private_key', 'session', 'session_id', 'sessionId', 'PHPSESSID', 'JSESSIONID', 'sid', 'connect.sid', 'otp', 'cvv', 'cvc', 'pin', 'jwt', 'bearer', 'credential', 'credentials', 'signature', 'sig', 'code_verifier', 'auth_code', 'verification_code', 'Cookie', 'Set-Cookie', 'ssn', 'iban'];
const PLAIN = ['theme', 'author', 'page', 'keyword', 'sort', 'passenger', 'tokenizer', 'token_count', 'client_id', 'assignee', 'design', 'sessions_per_day', 'spin', 'opinion', 'key', 'id', 'name', 'content-type', 'signal', 'passing'];

test('names: credential-like ones are known, harmless ones are not', () => {
  for (const n of SECRET) assert.equal(isSecretName(n), true, n);
  for (const n of PLAIN) assert.equal(isSecretName(n), false, n);
});

test('every secret name is masked in an address, a header, a body, a form and in text; harmless ones stay', () => {
  for (const n of SECRET) {
    const v = 'hunter22';
    assert.ok(!redactUrl(`https://a.example/p?${encodeURIComponent(n)}=${v}`).includes(v), `address ${n}`);
    assert.equal(redactHeaders([{ name: n, value: v }])[0].value, MASK, `header ${n}`);
    assert.ok(!redactBody(JSON.stringify({ a: [{ [n]: v }] }), 'application/json').includes(v), `JSON ${n}`);
    assert.ok(!redactBody(`x=1&${encodeURIComponent(n)}=${v}`, 'application/x-www-form-urlencoded').includes(v), `form ${n}`);
    for (const t of [`${n}=${v}`, `${n}: ${v}`, `{"${n}":"${v}"}`, `${n} = '${v}'`]) assert.ok(!redactText(t).includes(v), `text ${t}`);
  }
  for (const n of PLAIN) {
    assert.ok(redactUrl(`https://a.example/p?${n}=blue`).includes('blue'), n);
    assert.ok(redactBody(JSON.stringify({ [n]: 'blue' })).includes('blue'), n);
    assert.ok(redactText(`${n}=blue`).includes('blue'), n);
  }
});

test('shapes: tokens go whatever their name, ordinary text and addresses stay', () => {
  const tokens = ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123', 'ghp_abcdefghijkl1234567890', 'Bearer abcdef123456', 'sk-ant-abcdefghij1234567890', '4111 1111 1111 1111', 'q8Zk2LmN0pRtVwXy4B6c'];
  for (const t of tokens) {
    assert.equal(redactValue('note', t), MASK, t);
    if (!/^4111|^q8/.test(t)) assert.ok(!redactText(`got ${t} now`).includes(t), t);
  }
  assert.equal(redactText('The quick brown fox, 42 items, /static/js/main.js'), 'The quick brown fox, 42 items, /static/js/main.js');
  assert.equal(redactUrl('https://user:pw@a.example:8443/items/12?page=2#top'), 'https://a.example:8443/items/12?page=2#top');
  assert.equal(redactUrl('https://a.example/cb?code=abc&state=x'), 'https://a.example/cb?code=REDACTED&state=x');
  assert.equal(redactUrl('https://a.example/#access_token=abc'), 'https://a.example/#…');
  assert.ok(!/q8Zk|1234/.test(redactText('see https://a.example/reset/q8Zk2LmN0pRtVwXy4B6c?sid=1234 now')));
  assert.equal(redactUrl('data:text/plain,hello'), 'data:…');
  assert.equal(redactUrl('nonsense'), '(invalid address)');
});

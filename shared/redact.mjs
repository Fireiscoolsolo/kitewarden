// One rule set that takes credential-like values out of what a model sees: addresses, headers, bodies, storage, console text.
// It works by names and shapes, so a secret under an unusual name and in plain words is not recognized.
import { looksSecret } from './protocol.mjs';

export const MASK = '[redacted]';

// Any of these words in a name, or one of these at its end.
const STRONG = new Set(['password', 'passwd', 'pwd', 'passphrase', 'passcode', 'secret', 'credential', 'credentials', 'authorization', 'csrf', 'xsrf', 'csrftoken', 'otp', 'cvv', 'cvc', 'jwt', 'apikey', 'accesstoken', 'authtoken', 'sessionid', 'phpsessid', 'jsessionid', 'sessid', 'sid', 'bearer']);
const LAST = new Set(['token', 'tokens', 'pass', 'auth', 'pin', 'sig', 'signature', 'session', 'cookie', 'ssn', 'iban']);
const PAIRS = /\b(api|access|private|secret|session|signing|encryption) (key|id|code)$|\b(auth|authorization|verification|code) (code|verifier)$/;

export function isSecretName(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => STRONG.has(w)) || LAST.has(words.at(-1)) || PAIRS.test(words.join(' '));
}

/** The value of something that has a name. */
export const redactValue = (name, value) => (value !== '' && (isSecretName(name) || looksSecret(value)) ? MASK : redactText(value));

/** An address that can be shown: no user name, and no path part, parameter or fragment that looks like a credential. */
export function redactUrl(text) {
  let u;
  try {
    u = new URL(text);
  } catch {
    return '(invalid address)';
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return `${u.protocol}…`;
  const path = u.pathname.split('/').map((p) => (looksSecret(p) ? '…' : p)).join('/');
  // `code` in a query is a login that can be used once, whatever it looks like.
  const query = [...u.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${v && (k === 'code' || isSecretName(k) || looksSecret(v)) ? 'REDACTED' : encodeURIComponent(v)}`).join('&');
  const hash = u.hash && (/[=&]/.test(u.hash) || looksSecret(u.hash.slice(1)) ? '#…' : u.hash);
  return u.origin + path + (query && `?${query}`) + hash;
}

const KNOWN = /\b(?:(?:Bearer|Basic)\s+[\w.~+/=-]{8,}|eyJ[\w-]{5,}\.[\w-]{5,}(?:\.[\w-]*)?|(?:sk|pk|rk|ghp|gho|ghs|glpat|xox[a-z]|AKIA|AIza)[-_A-Za-z0-9]{12,})/g;
const NAMED = /((["']?)([A-Za-z][\w.-]{0,60})\2\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"',;&<>{}]+)/g;

/** Plain text of a page, a log or an error. */
export function redactText(text) {
  const parts = String(text).split(/((?:https?|wss?):\/\/[^\s"'<>`]+)/);
  return parts
    .map((p, i) => {
      if (i % 2) return redactUrl(p.replace(/[.,;)\]}]+$/, '')) + (/[.,;)\]}]+$/.exec(p)?.[0] ?? '');
      return p
        .replace(KNOWN, MASK)
        .replace(NAMED, (all, head, q, name, value) => (isSecretName(name) && value.replace(/^["']|["']$/g, '') !== '' ? head + (/^["']/.test(value) ? value[0] + MASK + value[0] : MASK) : all))
        .replace(/[A-Za-z0-9+_=-]{24,}/g, (v) => (looksSecret(v) ? MASK : v));
    })
    .join('');
}

const walk = (v, name) => {
  if (Array.isArray(v)) return v.map((x) => walk(x, name));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
  if (typeof v === 'string') return redactValue(name, v);
  return typeof v === 'number' && isSecretName(name) ? MASK : v;
};

/** Any plain data. */
export const redactData = (v) => walk(v, '');

const decode = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

/** A body: JSON and form fields by name, anything else as text. */
export function redactBody(text, type = '') {
  if (/json/i.test(type) || /^\s*[[{]/.test(text)) {
    try {
      return JSON.stringify(redactData(JSON.parse(text)));
    } catch {
      // cut, or not JSON after all
    }
  }
  if (!/x-www-form-urlencoded/i.test(type)) return redactText(text);
  return text.split('&').map((p) => p.split('=')).map(([k, ...v]) => `${k}=${redactValue(decode(k), decode(v.join('='))) === MASK ? MASK : v.join('=')}`).join('&');
}

/** Headers as [{name, value}], with the values that a model may see. */
export const redactHeaders = (list) =>
  (list ?? []).map(({ name, value = '' }) => ({
    name,
    value: /^(set-)?cookie2?$|^(proxy-)?auth/i.test(name) ? MASK : /^(location|referer|content-location)$/i.test(name) && /^https?:/.test(value) ? redactUrl(value) : redactValue(name, value),
  }));

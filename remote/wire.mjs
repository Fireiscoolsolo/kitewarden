// What both ends of the remote link share.
import { createHash } from 'node:crypto';

/** TLS 1.2 is the version for which Node has keys instead of certificates. One modern suite, with a fresh key agreement each time. */
export const TLS = { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'ECDHE-PSK-CHACHA20-POLY1305', ecdhCurve: 'X25519' };

/** What the user compares on both computers. */
export const fingerprint = (key) => createHash('sha256').update(`firefox-companion-remote|${key}`).digest('hex').slice(0, 24).replace(/(.{4})(?!$)/g, '$1-');

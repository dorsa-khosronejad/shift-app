const crypto = require('crypto');
const db = require('../db/database');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const character of value.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('Invalid base32 secret');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function createTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

function totpCode(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
  return code;
}

function verifyTotp(secret, suppliedCode) {
  if (!secret || !/^\d{6}$/.test(String(suppliedCode || ''))) return false;
  const now = Date.now();
  return [-1, 0, 1].some((step) => crypto.timingSafeEqual(Buffer.from(totpCode(secret, now + step * 30000)), Buffer.from(String(suppliedCode))));
}

function recordLogin({ userId = null, email, success, method = 'password', request, failureReason = null }) {
  db.prepare(`INSERT INTO login_history (user_id, email, success, method, ip_address, user_agent, failure_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    userId,
    email,
    success ? 1 : 0,
    method,
    request.ip,
    request.get('user-agent') || null,
    failureReason
  );
}

function recordAudit({ actorUserId = null, action, targetUserId = null, details = null, request }) {
  db.prepare(`INSERT INTO audit_log (actor_user_id, action, target_user_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?)`).run(
    actorUserId,
    action,
    targetUserId,
    details ? JSON.stringify(details) : null,
    request?.ip || null
  );
}

module.exports = { createTotpSecret, totpCode, verifyTotp, recordLogin, recordAudit };

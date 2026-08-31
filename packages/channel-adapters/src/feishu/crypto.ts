import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

export function verifyFeishuSignature(
  rawBody: string | Uint8Array,
  timestamp: string,
  nonce: string,
  encryptKey: string,
  signature: string
): boolean {
  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  const expected = createHash('sha256').update(timestamp).update(nonce).update(encryptKey).update(body).digest('hex');
  return safeEqual(expected, signature.toLowerCase());
}

export function decryptFeishuPayload(encrypted: string, encryptKey: string): string {
  let data: Buffer;
  try { data = Buffer.from(encrypted, 'base64'); }
  catch { throw new Error('feishu_invalid_encrypted_payload'); }
  if (data.byteLength <= 16) throw new Error('feishu_invalid_encrypted_payload');
  try {
    const key = createHash('sha256').update(encryptKey).digest();
    const decipher = createDecipheriv('aes-256-cbc', key, data.subarray(0, 16));
    return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('feishu_invalid_encrypted_payload');
  }
}

export function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

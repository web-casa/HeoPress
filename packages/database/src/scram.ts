import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * A PostgreSQL SCRAM-SHA-256 password verifier, computed here (HeoPress P06; Codex review of task 5.2):
 * `ALTER ROLE … PASSWORD '<verifier>'` stores it as is, so the plaintext password never reaches the
 * server, nor its statement or error logs. Same format and iteration count as PostgreSQL's own
 * (`SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, RFC 5803).
 *
 * The statement still carries the verifier, which a statement log would keep: it does not reveal the
 * password, but allows offline guessing — use long random passwords.
 *
 * Printable ASCII only: the server normalises other passwords (SASLprep) before hashing, which this
 * does not, so a non-ASCII password is refused rather than stored unusable.
 */
export function scramVerifier(password: string, opts: { iterations?: number; salt?: Buffer } = {}): string {
  if (!/^[\x20-\x7e]+$/.test(password)) throw new Error('role passwords must be printable ASCII (generate a random one)');
  const iterations = opts.iterations ?? 4096;
  const salt = opts.salt ?? randomBytes(16);
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

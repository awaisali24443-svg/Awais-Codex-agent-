/**
 * Encryption for the `secrets` table.
 *
 * AES-256-GCM, with the *name* of the secret bound in as associated data. That
 * last part is the whole reason this is a module rather than five lines in the
 * route handler: without it, an attacker (or a bug) could copy the ciphertext of
 * `gemini_api_key` into the `whatsapp_token` row and the decryption would still
 * succeed — the store would happily hand one credential to the other consumer.
 * Binding the name makes a swapped row fail authentication.
 *
 * Shapes match the columns the schema already had: base64 ciphertext, base64 IV,
 * base64 tag. Nothing here knows about HTTP, the database, or the settings UI.
 *
 * The master key is 32 bytes of hex (`openssl rand -hex 32`). It is the one
 * value that cannot live in the database — losing it loses every stored secret,
 * which is why `openSecret` failures are reported as "the key changed" rather
 * than as a corruption, and why the store treats them as an empty value instead
 * of crashing a boot.
 */
import crypto from 'node:crypto';

/** Domain separator, so a ciphertext from another feature cannot be replayed here. */
const AAD_PREFIX = 'awais-codex:secret:';

export const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;

/** 64 hex characters — the only shape `loadConfig` accepts. */
export function isMasterKey(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

export class SecretDecryptionError extends Error {
  constructor(readonly secretName: string, cause?: unknown) {
    super(
      `Could not decrypt the stored secret "${secretName}". ` +
        'This normally means MASTER_KEY changed since it was saved. ' +
        'Re-enter the value (or restore the old MASTER_KEY) to fix it.',
    );
    this.name = 'SecretDecryptionError';
    this.cause = cause;
  }
}

function keyFrom(masterKeyHex: string): Buffer {
  const hex = masterKeyHex.trim();
  if (!isMasterKey(hex)) {
    throw new Error('MASTER_KEY must be 64 hex characters — e.g. `openssl rand -hex 32`');
  }
  return Buffer.from(hex, 'hex');
}

function associatedData(secretName: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}${secretName}`, 'utf-8');
}

export function sealSecret(masterKeyHex: string, secretName: string, plaintext: string): SealedSecret {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(masterKeyHex), iv);
  cipher.setAAD(associatedData(secretName));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function openSecret(masterKeyHex: string, secretName: string, sealed: SealedSecret): string {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      keyFrom(masterKeyHex),
      Buffer.from(sealed.iv, 'base64'),
    );
    decipher.setAAD(associatedData(secretName));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf-8');
  } catch (err) {
    throw new SecretDecryptionError(secretName, err);
  }
}

/**
 * A short, non-reversible label for a stored value ("a1b2c3d4e5f6").
 *
 * Its purpose is to answer "is the key I just pasted the same one that is
 * already in there?" without ever sending the value back to a browser. It is a
 * truncated SHA-256, so it reveals nothing useful about a real credential — but
 * it does mean two identical *test* keys look identical, which is fine.
 */
export function fingerprintOf(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext, 'utf-8').digest('hex').slice(0, 12);
}

/**
 * Masked display form for logs. Never used for storage — a secret is either
 * encrypted or absent, never truncated-then-kept.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-2)} (${plaintext.length} chars)`;
}

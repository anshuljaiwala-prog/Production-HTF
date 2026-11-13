// At-rest encryption for exchange API secrets (connections.api_secret).
//
// Secrets are AES-GCM encrypted with a 256-bit key. The key comes from the
// environment when a deployment secret named SECRETS_KEY is set (base64 of
// 32 bytes, configured through Sites → Secrets or development.variables);
// without one, each workspace lazily gets a random key stored in its own
// `connection_keys` table — which still hides the secret from casual row
// dumps but should be upgraded to an environment key for real deployments.
//
// Storage format inside the column: `enc:v1:<keyId>:<iv b64>:<cipher b64>`
// where keyId fingerprints the encrypting key (SHA-256, first 8 bytes, hex).
// The fingerprint lets rows encrypted by an older key decrypt alongside rows
// from a newer one, and marks migrated rows so plaintext never gets
// double-encrypted. Values without the prefix are legacy plaintext and are
// returned unchanged by the reader until migration re-encrypts them.

const FORMAT_PREFIX = 'enc:v1'

/** One usable key: its fingerprint plus the imported AES-GCM handle. */
export interface SecretKey {
  id: string
  key: CryptoKey
}

export const hasCipherPrefix = (value: unknown): boolean => typeof value === 'string' && value.startsWith(`${FORMAT_PREFIX}:`)

const bytesToB64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

const b64ToBytes = (b64: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))

const view = (buffer: ArrayBuffer | Uint8Array): ArrayBuffer =>
  buffer instanceof Uint8Array ? (buffer.buffer as ArrayBuffer).slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer

/** Fingerprint a key's raw bytes so ciphertext records who encrypted it. */
export async function keyFingerprint(raw: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', view(raw))
  return Array.from(new Uint8Array(digest).subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Import 32 raw bytes of key material as an AES-GCM key. */
export async function importSecretKey(raw: Uint8Array): Promise<SecretKey> {
  const id = await keyFingerprint(raw)
  const key = await crypto.subtle.importKey('raw', view(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { id, key }
}

/** Parse the env-provided deployment key; malformed input is ignored, the
 * workspace falls back to its own stored key. */
function deploymentKey(value: string | undefined): Uint8Array | null {
  if (!value) return null
  try {
    const raw = b64ToBytes(value.trim())
    return raw.length === 32 ? raw : null
  } catch {
    return null
  }
}

type KeyRow = Record<string, unknown>

/** Every key that might have encrypted this workspace's secrets: the
 * deployment key first (new writes use it), then the workspace's own key. */
export async function loadSecretKeys(db: D1Database, owner: string, envKey?: string): Promise<SecretKey[]> {
  const keys: SecretKey[] = []
  const fromEnv = deploymentKey(envKey)
  if (fromEnv) keys.push(await importSecretKey(fromEnv))

  const row = await db.prepare(`SELECT key_b64 FROM connection_keys WHERE owner_sub = ?`).bind(owner).first<KeyRow>()
  let stored = row ? String(row.key_b64 ?? '') : ''
  if (!stored) {
    stored = bytesToB64(crypto.getRandomValues(new Uint8Array(32)))
    await db
      .prepare(`INSERT INTO connection_keys (owner_sub, key_b64, created_at) VALUES (?, ?, ?) ON CONFLICT (owner_sub) DO NOTHING`)
      .bind(owner, stored, Date.now())
      .run()
    keys.push(await importSecretKey(b64ToBytes(stored)))
    // The workspace key was created for this workspace: nothing else to load.
    return dedupeKeys(keys)
  }
  keys.push(await importSecretKey(b64ToBytes(stored)))
  return dedupeKeys(keys)
}

function dedupeKeys(keys: SecretKey[]): SecretKey[] {
  const seen = new Set<string>()
  return keys.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)))
}

/** Encrypt a plaintext secret with the primary (newest) key. */
export async function encryptSecret(keys: SecretKey[], plaintext: string): Promise<string> {
  const primary = keys[0]
  if (!primary) throw new Error('No encryption key available for API secrets.')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(plaintext)
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, primary.key, view(data))
  return [
    FORMAT_PREFIX,
    primary.id,
    bytesToB64(iv),
    bytesToB64(new Uint8Array(cipher)),
  ].join(':')
}

/** Decode a stored secret. Legacy plaintext passes through unchanged (the
 * caller's existing behavior), `enc:` rows decrypt with the matching key —
 * null means the value is unreadable: unknown key or tampered ciphertext. */
export async function decryptSecret(keys: SecretKey[], value: string): Promise<string | null> {
  if (!hasCipherPrefix(value)) return value
  // `enc:v1:<keyId>:<iv>:<cipher>` — the prefix itself contains a colon, so
  // the id/the fields start at index 2.
  const keyId = value.split(':')[2]
  const ivB64 = value.split(':')[3]
  const cipherB64 = value.split(':').slice(4).join(':')
  const match = keys.find((entry) => entry.id === keyId)
  if (!match) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(ivB64) },
      match.key,
      view(b64ToBytes(cipherB64)),
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

/** Re-encrypt legacy plaintext rows in place. Callers pass the connection
 * rows they already fetched (SELECT * includes api_secret); encrypted rows
 * and empty cells are left alone. Returns how many rows were migrated. */
export async function migrateSecretEncryption(db: D1Database, owner: string, keys: SecretKey[], rows: KeyRow[]): Promise<number> {
  let migrated = 0
  for (const row of rows) {
    const value = String(row.api_secret ?? '')
    if (!value || hasCipherPrefix(value)) continue
    const cipher = await encryptSecret(keys, value)
    await db.prepare(`UPDATE connections SET api_secret = ? WHERE id = ? AND owner_sub = ?`).bind(cipher, String(row.id), owner).run()
    migrated++
  }
  return migrated
}

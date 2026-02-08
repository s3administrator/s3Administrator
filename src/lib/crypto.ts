import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto"

const ALGORITHM = "aes-256-gcm"
const KEY_LENGTH = 32
const IV_LENGTH = 16

function deriveKey(): Buffer {
  const masterSecret = process.env.ENCRYPTION_MASTER_KEY!
  const salt = process.env.ENCRYPTION_SALT!
  return scryptSync(masterSecret, salt, KEY_LENGTH)
}

export function encrypt(plaintext: string): { ciphertext: string; iv: string } {
  const key = deriveKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  let encrypted = cipher.update(plaintext, "utf8", "hex")
  encrypted += cipher.final("hex")
  const authTag = cipher.getAuthTag().toString("hex")

  return {
    ciphertext: encrypted + ":" + authTag,
    iv: iv.toString("hex"),
  }
}

export function decrypt(ciphertext: string, ivHex: string): string {
  const key = deriveKey()
  const iv = Buffer.from(ivHex, "hex")
  const [encrypted, authTagHex] = ciphertext.split(":")
  const authTag = Buffer.from(authTagHex, "hex")

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encrypted, "hex", "utf8")
  decrypted += decipher.final("utf8")
  return decrypted
}

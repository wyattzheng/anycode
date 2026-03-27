import { createHash } from "crypto"

export namespace Hash {
  export function fast(input: string | Buffer): string {
    return createHash("sha1").update(input).digest("hex")
  }

  /** SHA-256, returns 64-char hex string */
  export function sha256(input: string | Buffer): string {
    return createHash("sha256").update(input).digest("hex")
  }

  /** Convert a hex string into UUID v4 format (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) */
  export function hexToUUID(hex: string): string {
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-")
  }
}

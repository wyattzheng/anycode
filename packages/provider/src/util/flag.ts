/**
 * Minimal Flag stub for provider package.
 * Only contains flags used by the provider subsystem.
 */
export namespace Flag {
  export let OPENCODE_ENABLE_EXPERIMENTAL_MODELS = false
  export let OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number | undefined
  export let OPENCODE_DISABLE_CLAUDE_CODE = false

  export function init(env: Record<string, string | undefined>) {
    const truthy = (key: string) => {
      const v = env[key]?.toLowerCase()
      return v === "true" || v === "1"
    }
    const number = (key: string) => {
      const v = env[key]
      if (!v) return undefined
      const n = Number(v)
      return Number.isInteger(n) && n > 0 ? n : undefined
    }
    Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS = truthy("OPENCODE_ENABLE_EXPERIMENTAL_MODELS")
    Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
    Flag.OPENCODE_DISABLE_CLAUDE_CODE = truthy("OPENCODE_DISABLE_CLAUDE_CODE")
  }
}

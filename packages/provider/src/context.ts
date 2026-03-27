/**
 * Slim context interface for ProviderService.
 * Callers construct this from their own context (e.g. AgentContext).
 */
export interface ProviderContext {
  /** Resolved config object (provider config, model, etc.) */
  config: Record<string, any>
  /** Environment variable service */
  env: {
    get(key: string): string | undefined
    all(): Record<string, string | undefined>
  }
  /** Logger */
  log: {
    create(meta: { service: string }): {
      info(...args: any[]): void
      warn(...args: any[]): void
      error(...args: any[]): void
      time(label: string): { [Symbol.dispose](): void }
    }
  }
}

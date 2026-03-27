

/**
 * EnvService — per-instance environment variable snapshot.
 *
 * Each CodeAgent instance gets its own env copy so tests / parallel
 * agents don't leak state into each other via process.env.
 */
export class EnvService {
  private env: Record<string, string | undefined>

  constructor(initialEnv: Record<string, string | undefined> = {}) {
    this.env = { ...initialEnv }
  }

  get(key: string): string | undefined {
    return this.env[key]
  }

  all(): Record<string, string | undefined> {
    return this.env
  }

  set(key: string, value: string): void {
    this.env[key] = value
  }

  remove(key: string): void {
    delete this.env[key]
  }
}



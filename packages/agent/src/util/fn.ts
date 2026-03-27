/**
 * Create a typed function with schema attached for introspection.
 * No runtime validation — just passes through to the callback.
 */
export function fn<Input, Result>(cb: (input: Input) => Result) {
  return cb
}

export function iife<T>(fn: () => T) {
  return fn()
}

export function defer<T extends () => void | Promise<void>>(
  fn: T,
): T extends () => Promise<void> ? { [Symbol.asyncDispose]: () => Promise<void> } : { [Symbol.dispose]: () => void } {
  return {
    [Symbol.dispose]() {
      fn()
    },
    [Symbol.asyncDispose]() {
      return Promise.resolve(fn())
    },
  } as any
}

export namespace Token {
  const CHARS_PER_TOKEN = 4

  export function estimate(input: string) {
    return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
  }
}

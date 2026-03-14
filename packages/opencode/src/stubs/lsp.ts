/**
 * LSP stub module — original lsp/ was removed during agent-mode cleanup.
 * Provides no-op implementations for all LSP functions used by tool/* and session/*
 */
import z from "zod"

export namespace LSP {
  export const Range = z
    .object({
      start: z.object({
        line: z.number(),
        character: z.number(),
      }),
      end: z.object({
        line: z.number(),
        character: z.number(),
      }),
    })
    .meta({ ref: "LSPRange" })
  export type Range = z.infer<typeof Range>

  export type DiagnosticInfo = {
    range: Range
    severity: number
    message: string
    source?: string
    code?: string | number
  }

  export const Diagnostic = {
    pretty(d: DiagnosticInfo): string {
      return `${d.range.start.line}:${d.range.start.character} ${d.severity === 1 ? "error" : "warning"}: ${d.message}`
    },
  }

  export type Position = {
    textDocument: { uri: string }
    position: { line: number; character: number }
  }

  /** Stub: no LSP server in agent mode */
  export async function init() {}

  /** Stub: no-op file touch */
  export async function touchFile(_filepath: string, _wait?: boolean) {}

  /** Stub: always returns empty diagnostics */
  export async function diagnostics(): Promise<Map<string, DiagnosticInfo[]>> {
    return new Map()
  }

  /** Stub: no LSP clients available */
  export async function hasClients(_file: string): Promise<boolean> {
    return false
  }

  /** Stub: no-op definition lookup */
  export async function definition(_position: Position): Promise<unknown[]> {
    return []
  }

  /** Stub: no-op references lookup */
  export async function references(_position: Position): Promise<unknown[]> {
    return []
  }

  /** Stub: no-op hover */
  export async function hover(_position: Position): Promise<unknown> {
    return null
  }

  /** Stub: no-op document symbol */
  export async function documentSymbol(_uri: string): Promise<unknown[]> {
    return []
  }

  /** Stub: no-op workspace symbol */
  export async function workspaceSymbol(_query: string): Promise<unknown[]> {
    return []
  }

  /** Stub: no-op implementation */
  export async function implementation(_position: Position): Promise<unknown[]> {
    return []
  }

  /** Stub: no-op call hierarchy */
  export async function prepareCallHierarchy(_position: Position): Promise<unknown[]> {
    return []
  }

  /** Stub: no-op incoming calls */
  export async function incomingCalls(_position: Position): Promise<unknown[]> {
    return []
  }

  /** Stub: no-op outgoing calls */
  export async function outgoingCalls(_position: Position): Promise<unknown[]> {
    return []
  }
}

/**
 * Hooks — PostToolUse hook system compatible with Claude Code's settings.json format.
 *
 * Reads hook configuration from Settings.hooks and executes
 * shell commands after tool invocations, passing the tool payload via stdin.
 */

import { spawn } from "child_process"
import { Log } from "./util/log"

const log = Log.create({ module: "hooks" })

export namespace Hooks {
  export interface HookDef {
    type: "command"
    command: string
    timeout?: number
  }

  export interface HookRule {
    matcher: string
    /** Regex patterns — if file_path matches any, this rule is skipped */
    ignore?: string[]
    hooks: HookDef[]
  }

  export interface HooksConfig {
    [eventName: string]: HookRule[]
  }

  export interface HookPayload {
    session_id: string
    cwd: string
    hook_event_name: string
    tool_name: string
    tool_input: any
    tool_response: any
  }

  const DEFAULT_TIMEOUT = 15 // seconds

  /**
   * Convert a camelCase key to snake_case.
   * e.g. "filePath" → "file_path", "oldString" → "old_string"
   */
  function toSnakeCase(key: string): string {
    return key.replace(/[A-Z]/g, (ch) => "_" + ch.toLowerCase())
  }

  /**
   * Recursively convert all object keys from camelCase to snake_case.
   * Primitives, arrays, and null/undefined pass through unchanged.
   */
  function keysToSnakeCase(obj: any): any {
    if (obj === null || obj === undefined || typeof obj !== "object") return obj
    if (Array.isArray(obj)) return obj.map(keysToSnakeCase)
    const out: any = {}
    for (const [key, value] of Object.entries(obj)) {
      out[toSnakeCase(key)] = keysToSnakeCase(value)
    }
    return out
  }

  /**
   * Find hook definitions that match the given tool name.
   * Rules whose ignore patterns match the filePath are skipped.
   */
  export function matchTool(rules: HookRule[], toolName: string, filePath?: string): HookDef[] {
    const matched: HookDef[] = []
    for (const rule of rules) {
      try {
        if (!new RegExp(rule.matcher, "i").test(toolName)) continue
        if (filePath && rule.ignore?.some((pat) => {
          try { return new RegExp(pat, "i").test(filePath) } catch { return false }
        })) continue
        matched.push(...rule.hooks)
      } catch {
        // invalid regex, skip
      }
    }
    return matched
  }

  /**
   * Execute a single hook command, passing payload via stdin.
   */
  function execute(hook: HookDef, payload: object, cwd: string): void {
    const timeout = (hook.timeout ?? DEFAULT_TIMEOUT) * 1000
    const payloadStr = JSON.stringify(payload)

    try {
      const proc = spawn("bash", ["-c", hook.command], {
        cwd,
        stdio: ["pipe", "ignore", "ignore"],
        env: process.env,
        detached: true,
      })

      // Unref so the hook process doesn't prevent Node from exiting
      proc.unref()

      // Write payload to stdin
      proc.stdin?.write(payloadStr)
      proc.stdin?.end()

      // Timeout kill
      const timer = setTimeout(() => {
        try { proc.kill("SIGTERM") } catch { /* already exited */ }
      }, timeout)

      proc.on("exit", () => clearTimeout(timer))
      proc.on("error", () => clearTimeout(timer))
    } catch (err) {
      log.info(`Hook execution failed: ${err}`)
    }
  }

  /**
   * Fire PostToolUse hooks for a completed tool invocation.
   * This is fire-and-forget — errors are logged but never thrown.
   */
  export function runPostToolUse(
    hooksConfig: HooksConfig,
    toolName: string,
    toolInput: any,
    toolResponse: any,
    sessionID: string,
    cwd: string,
  ): void {
    const rules = hooksConfig["PostToolUse"]
    if (!rules || rules.length === 0) return

    const filePath = toolInput?.filePath ?? toolInput?.file_path
    const hooks = matchTool(rules, toolName, filePath)
    if (hooks.length === 0) return

    const payload: HookPayload = {
      session_id: sessionID,
      cwd,
      hook_event_name: "PostToolUse",
      tool_name: toolName,
      tool_input: keysToSnakeCase(toolInput),
      tool_response: keysToSnakeCase(toolResponse),
    }

    for (const hook of hooks) {
      execute(hook, payload, cwd)
    }
  }
}

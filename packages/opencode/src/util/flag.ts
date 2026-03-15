/**
 * Flag — environment-based feature flags.
 *
 * Must be initialized via `Flag.init(env)` before use.
 * The `env` record is injected from outside (no process.env dependency).
 */

let _env: Record<string, string | undefined> = {}

function truthy(key: string) {
  const value = _env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = _env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

function number(key: string) {
  const value = _env[key]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export namespace Flag {
  /**
   * Initialize flags from an environment record.
   * Must be called before any flag is accessed.
   */
  export function init(env: Record<string, string | undefined>) {
    _env = env
    // Re-evaluate all eager flags
    Flag.OPENCODE_AUTO_SHARE = truthy("OPENCODE_AUTO_SHARE")
    Flag.OPENCODE_GIT_BASH_PATH = _env["OPENCODE_GIT_BASH_PATH"]
    Flag.OPENCODE_CONFIG = _env["OPENCODE_CONFIG"]
    Flag.OPENCODE_CONFIG_CONTENT = _env["OPENCODE_CONFIG_CONTENT"]
    Flag.OPENCODE_DISABLE_AUTOUPDATE = truthy("OPENCODE_DISABLE_AUTOUPDATE")
    Flag.OPENCODE_DISABLE_PRUNE = truthy("OPENCODE_DISABLE_PRUNE")
    Flag.OPENCODE_DISABLE_TERMINAL_TITLE = truthy("OPENCODE_DISABLE_TERMINAL_TITLE")
    Flag.OPENCODE_PERMISSION = _env["OPENCODE_PERMISSION"]
    Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS = truthy("OPENCODE_DISABLE_DEFAULT_PLUGINS")
    Flag.OPENCODE_DISABLE_LSP_DOWNLOAD = truthy("OPENCODE_DISABLE_LSP_DOWNLOAD")
    Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS = truthy("OPENCODE_ENABLE_EXPERIMENTAL_MODELS")
    Flag.OPENCODE_DISABLE_AUTOCOMPACT = truthy("OPENCODE_DISABLE_AUTOCOMPACT")
    Flag.OPENCODE_DISABLE_MODELS_FETCH = truthy("OPENCODE_DISABLE_MODELS_FETCH")
    Flag.OPENCODE_DISABLE_CLAUDE_CODE = truthy("OPENCODE_DISABLE_CLAUDE_CODE")
    Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT =
      Flag.OPENCODE_DISABLE_CLAUDE_CODE || truthy("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT")
    Flag.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS =
      Flag.OPENCODE_DISABLE_CLAUDE_CODE || truthy("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS")
    Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS =
      Flag.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS || truthy("OPENCODE_DISABLE_EXTERNAL_SKILLS")
    Flag.OPENCODE_FAKE_VCS = _env["OPENCODE_FAKE_VCS"]
    Flag.OPENCODE_SERVER_PASSWORD = _env["OPENCODE_SERVER_PASSWORD"]
    Flag.OPENCODE_SERVER_USERNAME = _env["OPENCODE_SERVER_USERNAME"]
    Flag.OPENCODE_ENABLE_QUESTION_TOOL = truthy("OPENCODE_ENABLE_QUESTION_TOOL")
    Flag.OPENCODE_EXPERIMENTAL = truthy("OPENCODE_EXPERIMENTAL")
    Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER = truthy("OPENCODE_EXPERIMENTAL_FILEWATCHER")
    Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER")
    Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY =
      Flag.OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY")
    Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = (() => {
      const copy = _env["OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
      return copy === undefined ? false : truthy("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
    })()
    Flag.OPENCODE_ENABLE_EXA =
      truthy("OPENCODE_ENABLE_EXA") || Flag.OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_EXA")
    Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
    Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
    Flag.OPENCODE_EXPERIMENTAL_OXFMT = Flag.OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_OXFMT")
    Flag.OPENCODE_EXPERIMENTAL_LSP_TY = truthy("OPENCODE_EXPERIMENTAL_LSP_TY")
    Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL = Flag.OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_LSP_TOOL")
    Flag.OPENCODE_DISABLE_FILETIME_CHECK = truthy("OPENCODE_DISABLE_FILETIME_CHECK")
    Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE = Flag.OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_PLAN_MODE")
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = Flag.OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_WORKSPACES")
    Flag.OPENCODE_EXPERIMENTAL_MARKDOWN = !falsy("OPENCODE_EXPERIMENTAL_MARKDOWN")
    Flag.OPENCODE_MODELS_URL = _env["OPENCODE_MODELS_URL"]
    Flag.OPENCODE_MODELS_PATH = _env["OPENCODE_MODELS_PATH"]
    Flag.OPENCODE_DISABLE_CHANNEL_DB = truthy("OPENCODE_DISABLE_CHANNEL_DB")
    Flag.OPENCODE_SKIP_MIGRATIONS = truthy("OPENCODE_SKIP_MIGRATIONS")
    Flag.OPENCODE_STRICT_CONFIG_DEPS = truthy("OPENCODE_STRICT_CONFIG_DEPS")
  }

  // ── Mutable flag values (set by init) ──────────────────────────────

  export let OPENCODE_AUTO_SHARE = false
  export let OPENCODE_GIT_BASH_PATH: string | undefined
  export let OPENCODE_CONFIG: string | undefined
  export let OPENCODE_CONFIG_CONTENT: string | undefined
  export let OPENCODE_DISABLE_AUTOUPDATE = false
  export let OPENCODE_DISABLE_PRUNE = false
  export let OPENCODE_DISABLE_TERMINAL_TITLE = false
  export let OPENCODE_PERMISSION: string | undefined
  export let OPENCODE_DISABLE_DEFAULT_PLUGINS = false
  export let OPENCODE_DISABLE_LSP_DOWNLOAD = false
  export let OPENCODE_ENABLE_EXPERIMENTAL_MODELS = false
  export let OPENCODE_DISABLE_AUTOCOMPACT = false
  export let OPENCODE_DISABLE_MODELS_FETCH = false
  export let OPENCODE_DISABLE_CLAUDE_CODE = false
  export let OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = false
  export let OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = false
  export let OPENCODE_DISABLE_EXTERNAL_SKILLS = false
  export let OPENCODE_FAKE_VCS: string | undefined
  export let OPENCODE_SERVER_PASSWORD: string | undefined
  export let OPENCODE_SERVER_USERNAME: string | undefined
  export let OPENCODE_ENABLE_QUESTION_TOOL = false
  export let OPENCODE_EXPERIMENTAL = false
  export let OPENCODE_EXPERIMENTAL_FILEWATCHER = false
  export let OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = false
  export let OPENCODE_EXPERIMENTAL_ICON_DISCOVERY = false
  export let OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = false
  export let OPENCODE_ENABLE_EXA = false
  export let OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: number | undefined
  export let OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number | undefined
  export let OPENCODE_EXPERIMENTAL_OXFMT = false
  export let OPENCODE_EXPERIMENTAL_LSP_TY = false
  export let OPENCODE_EXPERIMENTAL_LSP_TOOL = false
  export let OPENCODE_DISABLE_FILETIME_CHECK = false
  export let OPENCODE_EXPERIMENTAL_PLAN_MODE = false
  export let OPENCODE_EXPERIMENTAL_WORKSPACES = false
  export let OPENCODE_EXPERIMENTAL_MARKDOWN = true
  export let OPENCODE_MODELS_URL: string | undefined
  export let OPENCODE_MODELS_PATH: string | undefined
  export let OPENCODE_DISABLE_CHANNEL_DB = false
  export let OPENCODE_SKIP_MIGRATIONS = false
  export let OPENCODE_STRICT_CONFIG_DEPS = false
  export declare const OPENCODE_CLIENT: string
}

// Dynamic getters for flags that must be evaluated at access time

Object.defineProperty(Flag, "OPENCODE_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("OPENCODE_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "OPENCODE_TUI_CONFIG", {
  get() {
    return _env["OPENCODE_TUI_CONFIG"]
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "OPENCODE_CONFIG_DIR", {
  get() {
    return _env["OPENCODE_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "OPENCODE_CLIENT", {
  get() {
    return _env["OPENCODE_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})

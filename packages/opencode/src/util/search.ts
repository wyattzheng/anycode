/**
 * SearchProvider — abstraction for search & file-listing commands.
 *
 * Separates "search / listing" capabilities from VFS (file I/O).
 * Implementations can delegate to system `grep`, ripgrep, or do
 * in-memory search. Injected via Instance.provide({ search }).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface GrepMatch {
  /** Absolute file path */
  file: string
  /** 1-indexed line number */
  line: number
  /** Column offset (0-indexed) */
  column: number
  /** Matched line content (trimmed trailing newline) */
  content: string
}

// ── Interface ──────────────────────────────────────────────────────────────

export interface SearchProvider {
  /**
   * Search file contents by regex pattern.
   * Returns matches with file/line/column/content.
   */
  grep(options: {
    /** Regex pattern to search for */
    pattern: string
    /** Directory to search in (absolute path) */
    path: string
    /** Glob filter, e.g. "*.ts" */
    include?: string
    /** Maximum length of a matched line to return. If longer, it will be truncated. */
    maxLineLength?: number
    /** Abort signal for cancellation */
    signal?: AbortSignal
  }): Promise<GrepMatch[]>

  /**
   * List files under a directory.
   * Returns relative paths (relative to cwd).
   * Replaces Ripgrep.files().
   */
  listFiles(options: {
    /** Root directory to list from (absolute path) */
    cwd: string
    /** Glob filters (include/exclude, e.g. ["*.ts", "!node_modules/"]) */
    glob?: string[]
    /** Include hidden files (default: true) */
    hidden?: boolean
    /** Follow symlinks */
    follow?: boolean
    /** Max directory depth */
    maxDepth?: number
    /** Max number of results */
    limit?: number
    /** Abort signal for cancellation */
    signal?: AbortSignal
  }): Promise<string[]>
}

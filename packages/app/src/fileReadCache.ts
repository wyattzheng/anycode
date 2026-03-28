/**
 * FileReadCache + PreloadEngine
 *
 * - FileReadCache: LRU cache for file content + highlighted HTML, capped at MAX_BYTES.
 * - PreloadEngine: discovers visible files from expanded file tree dirs,
 *   fetches their content, highlights them in the background, and populates
 *   the cache — all without blocking the main thread.
 */

import type { CodeHighlighter } from "./components/CodeViewer";
import type { FileTreeModel } from "./fileTree";
import { createContext, useContext } from "react";

// ── FileReadCache ────────────────────────────────────────────────────────────

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

interface CacheEntry {
    content: string;        // raw file content
    highlightHtml?: string; // Shiki-highlighted HTML (may arrive later)
    size: number;           // estimated byte size of this entry
}

function estimateBytes(content: string, html?: string): number {
    // UTF-16: each char ≈ 2 bytes
    return (content.length + (html?.length ?? 0)) * 2;
}

export class FileReadCache {
    private _map = new Map<string, CacheEntry>();
    private _totalSize = 0;

    // ── Content ──

    hasContent(filePath: string): boolean {
        return this._map.has(filePath);
    }

    getContent(filePath: string): string | null {
        const entry = this._map.get(filePath);
        if (!entry) return null;
        // LRU refresh
        this._map.delete(filePath);
        this._map.set(filePath, entry);
        return entry.content;
    }

    setContent(filePath: string, content: string): void {
        const old = this._map.get(filePath);
        if (old) {
            this._totalSize -= old.size;
            this._map.delete(filePath);
        }
        const size = estimateBytes(content);
        if (size > MAX_BYTES) return;
        this._evictUntil(size);
        const entry: CacheEntry = { content, size };
        this._map.set(filePath, entry);
        this._totalSize += size;
    }

    // ── Highlight HTML ──

    hasHighlight(filePath: string): boolean {
        return this._map.get(filePath)?.highlightHtml != null;
    }

    getHighlight(filePath: string): string | null {
        const entry = this._map.get(filePath);
        if (!entry?.highlightHtml) return null;
        // LRU refresh
        this._map.delete(filePath);
        this._map.set(filePath, entry);
        return entry.highlightHtml;
    }

    setHighlight(filePath: string, html: string): void {
        const entry = this._map.get(filePath);
        if (!entry) return; // content must be cached first
        const oldSize = entry.size;
        const newSize = estimateBytes(entry.content, html);
        const delta = newSize - oldSize;
        if (this._totalSize + delta > MAX_BYTES) {
            this._evictUntil(delta);
        }
        entry.highlightHtml = html;
        entry.size = newSize;
        this._totalSize += delta;
    }

    // ── Management ──

    invalidate(filePath: string): void {
        const entry = this._map.get(filePath);
        if (entry) {
            this._totalSize -= entry.size;
            this._map.delete(filePath);
        }
    }

    clear(): void {
        this._map.clear();
        this._totalSize = 0;
    }

    get size(): number { return this._map.size; }
    get totalBytes(): number { return this._totalSize; }

    private _evictUntil(needed: number): void {
        while (this._totalSize + needed > MAX_BYTES && this._map.size > 0) {
            const oldest = this._map.keys().next().value!;
            const entry = this._map.get(oldest)!;
            this._totalSize -= entry.size;
            this._map.delete(oldest);
        }
    }
}

// ── React context ────────────────────────────────────────────────────────────

export const FileReadCacheContext = createContext<FileReadCache | null>(null);
export function useFileReadCache(): FileReadCache | null {
    return useContext(FileReadCacheContext);
}

// ── PreloadEngine ────────────────────────────────────────────────────────────

/** File extensions we know Shiki can highlight */
const HIGHLIGHTABLE = new Set([
    "ts", "tsx", "js", "jsx", "json", "md", "css", "scss", "html", "xml",
    "svg", "py", "rb", "rs", "go", "java", "kt", "swift", "c", "cpp", "h",
    "hpp", "sh", "bash", "zsh", "sql", "yaml", "yml", "toml", "vue", "svelte",
    "graphql", "gql", "lua", "php", "r", "txt", "conf", "cfg", "ini", "env",
    "gitignore", "dockerignore", "makefile", "dockerfile",
]);

function isHighlightable(name: string): boolean {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const baseName = name.toLowerCase();
    return HIGHLIGHTABLE.has(ext)
        || baseName === "dockerfile"
        || baseName === "makefile"
        || baseName === ".gitignore";
}

export class PreloadEngine {
    private _cache: FileReadCache;
    private _highlighter: CodeHighlighter;
    private _requestFile: (path: string) => Promise<string | null>;
    private _pending = new Set<string>();
    private _queue: string[] = [];
    private _processing = false;

    constructor(
        cache: FileReadCache,
        highlighter: CodeHighlighter,
        requestFile: (path: string) => Promise<string | null>,
    ) {
        this._cache = cache;
        this._highlighter = highlighter;
        this._requestFile = requestFile;
    }

    /**
     * Scan expanded directories in the file tree and preload all visible files.
     * Skips files already cached or in-flight.
     */
    preloadFromTree(model: FileTreeModel): void {
        const files = collectVisibleFiles(model);
        const newFiles = files.filter(
            f => !this._cache.hasHighlight(f) && !this._pending.has(f)
        );
        if (newFiles.length === 0) return;
        this._queue.push(...newFiles);
        this._processQueue();
    }

    /** Process queue one file at a time to avoid overwhelming network/CPU */
    private async _processQueue(): Promise<void> {
        if (this._processing) return;
        this._processing = true;

        while (this._queue.length > 0) {
            if (this._cache.totalBytes >= MAX_BYTES) {
                this._queue.length = 0;
                break;
            }

            const filePath = this._queue.shift()!;
            if (this._cache.hasHighlight(filePath) || this._pending.has(filePath)) continue;

            this._pending.add(filePath);
            try {
                // Fetch content (may already be cached)
                let content = this._cache.getContent(filePath);
                if (content == null) {
                    content = await this._requestFile(filePath);
                    if (content != null) this._cache.setContent(filePath, content);
                }
                // Highlight (yield to main thread first)
                if (content != null && this._highlighter.ready) {
                    await new Promise(r => setTimeout(r, 0));
                    const html = this._highlighter.highlight(content, filePath);
                    this._cache.setHighlight(filePath, html);
                }
            } catch {
                // Silently skip failed files
            } finally {
                this._pending.delete(filePath);
            }
        }

        this._processing = false;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Collect all file paths visible in expanded directories (including top-level). */
function collectVisibleFiles(model: FileTreeModel): string[] {
    const files: string[] = [];

    const collect = (dirPath: string, children: { name: string; type: string }[]) => {
        for (const child of children) {
            const fullPath = dirPath ? `${dirPath}/${child.name}` : child.name;
            if (child.type === "file" && isHighlightable(child.name)) {
                files.push(fullPath);
            } else if (child.type === "dir" && model.isExpanded(fullPath)) {
                const sub = model.getChildren(fullPath);
                if (sub) collect(fullPath, sub);
            }
        }
    };

    collect("", model.topLevel);
    return files;
}

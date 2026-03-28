/**
 * FileReadCache + PreloadEngine
 *
 * - FileReadCache: LRU cache for file content + highlighted HTML, capped at MAX_BYTES.
 * - PreloadEngine: discovers visible files from expanded file tree dirs,
 *   fetches their content, highlights them in the background, and populates
 *   the cache — all without blocking the main thread.
 */

import type { CodeHighlighter } from "./components/CodeViewer";
import type { FileTreeModel, DirEntry } from "./file-tree";
import { createContext, useContext } from "react";

// ── FileReadCache ────────────────────────────────────────────────────────────

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

interface CacheEntry {
    content?: string;       // raw file content (files only)
    entries?: DirEntry[];   // directory listing (dirs only)
    highlightHtml?: string; // Shiki-highlighted HTML (may arrive later)
    diff?: { added: number[]; removed: number[] }; // git diff data
    size: number;           // estimated byte size of this entry
}

function estimateBytes(content?: string, html?: string, entries?: DirEntry[]): number {
    // UTF-16: each char ≈ 2 bytes
    let bytes = ((content?.length ?? 0) + (html?.length ?? 0)) * 2;
    // Entries: rough estimate per entry
    if (entries) bytes += entries.length * 40;
    return bytes;
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
        return entry.content ?? null;
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

    // ── Entries (directory listings) ──

    getEntries(dirPath: string): DirEntry[] | null {
        const entry = this._map.get(dirPath);
        if (!entry?.entries) return null;
        // LRU refresh
        this._map.delete(dirPath);
        this._map.set(dirPath, entry);
        return entry.entries;
    }

    setEntries(dirPath: string, entries: DirEntry[]): void {
        const old = this._map.get(dirPath);
        if (old) {
            this._totalSize -= old.size;
            this._map.delete(dirPath);
        }
        const size = estimateBytes(undefined, undefined, entries);
        this._evictUntil(size);
        const entry: CacheEntry = { entries, size };
        this._map.set(dirPath, entry);
        this._totalSize += size;
    }

    // ── Diff ──

    getDiff(filePath: string): { added: number[]; removed: number[] } | null {
        return this._map.get(filePath)?.diff ?? null;
    }

    setDiff(filePath: string, diff: { added: number[]; removed: number[] }): void {
        const entry = this._map.get(filePath);
        if (entry) entry.diff = diff;
    }

    // ── Management ──

    invalidate(filePath: string): void {
        const entry = this._map.get(filePath);
        if (entry) {
            this._totalSize -= entry.size;
            this._map.delete(filePath);
        }
    }

    /** Invalidate all cached entries under a directory (including the dir itself). */
    invalidateDir(dirPath: string): void {
        // dirPath "" means root — invalidate everything
        if (dirPath === "") {
            this.clear();
            return;
        }
        const prefix = dirPath + "/";
        for (const [key, entry] of this._map) {
            if (key === dirPath || key.startsWith(prefix)) {
                this._totalSize -= entry.size;
                this._map.delete(key);
            }
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

export interface BatchFileResult {
    content: string | null;
    entries?: DirEntry[];
    diff?: { added: number[]; removed: number[] };
}

export class PreloadEngine {
    private _cache: FileReadCache;
    private _highlighter: CodeHighlighter;
    private _fetchBatch: (paths: string[], withDiff?: boolean) => Promise<Record<string, BatchFileResult>>;

    constructor(
        cache: FileReadCache,
        highlighter: CodeHighlighter,
        fetchBatch: (paths: string[], withDiff?: boolean) => Promise<Record<string, BatchFileResult>>,
    ) {
        this._cache = cache;
        this._highlighter = highlighter;
        this._fetchBatch = fetchBatch;
    }

    /**
     * Scan expanded directories in the file tree and preload all visible files.
     */
    async preloadFromTree(model: FileTreeModel): Promise<void> {
        const files = collectVisibleFiles(model);
        const uncached = files.filter(f => !this._cache.hasContent(f));
        if (uncached.length === 0) {
            this._highlightUncached(files);
            return;
        }
        try {
            const results = await this._fetchBatch(uncached);
            for (const [filePath, result] of Object.entries(results)) {
                if (result.content != null && this._cache.totalBytes < MAX_BYTES) {
                    this._cache.setContent(filePath, result.content);
                }
            }
            await this._highlightUncached(files);
        } catch { /* skip */ }
    }

    /**
     * Preload changed files with diff data.
     */
    async preloadChanges(changedFiles: string[]): Promise<void> {
        const uncached = changedFiles.filter(f => !this._cache.hasContent(f) || !this._cache.getDiff(f));
        if (uncached.length === 0) {
            this._highlightUncached(changedFiles);
            return;
        }
        try {
            const results = await this._fetchBatch(uncached, true);
            for (const [filePath, result] of Object.entries(results)) {
                if (result.content != null && this._cache.totalBytes < MAX_BYTES) {
                    if (!this._cache.hasContent(filePath)) {
                        this._cache.setContent(filePath, result.content);
                    }
                    if (result.diff) {
                        this._cache.setDiff(filePath, result.diff);
                    }
                }
            }
            await this._highlightUncached(changedFiles);
        } catch { /* skip */ }
    }

    /** Highlight cached files that don't have highlight HTML yet */
    private async _highlightUncached(files: string[]): Promise<void> {
        if (!this._highlighter.ready) return;
        for (const filePath of files) {
            if (this._cache.totalBytes >= MAX_BYTES) break;
            if (this._cache.hasHighlight(filePath)) continue;
            const content = this._cache.getContent(filePath);
            if (content == null) continue;
            await new Promise(r => setTimeout(r, 0));
            const html = this._highlighter.highlight(content, filePath);
            this._cache.setHighlight(filePath, html);
        }
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

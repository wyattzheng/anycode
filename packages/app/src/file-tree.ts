import { useSyncExternalStore, createContext, useContext } from "react";

export interface DirEntry {
    name: string;
    type: "file" | "dir";
}

type RequestLs = (path: string) => Promise<DirEntry[]>;
type SendMessage = (data: any) => void;

/**
 * FileTreeModel — owns all file tree state outside React.
 *
 * Responsibilities:
 *   - Stores top-level entries and expanded directory children
 *   - Fetches subdirectory contents on expand
 *   - Re-fetches all expanded directories on fs change events
 *   - Sends watch/unwatch messages to server for per-directory watching
 *   - Notifies React subscribers to re-render
 */
export class FileTreeModel {
    private _topLevel: DirEntry[] = [];
    private _expanded = new Map<string, DirEntry[]>();
    private _loading = new Set<string>();
    private _listeners = new Set<() => void>();
    private _requestLs: RequestLs;
    private _send: SendMessage;

    constructor(requestLs: RequestLs, send: SendMessage) {
        this._requestLs = requestLs;
        this._send = send;
    }

    // ── Getters ──────────────────────────────────────────────

    get topLevel() { return this._topLevel; }
    isExpanded(path: string) { return this._expanded.has(path); }
    isLoading(path: string) { return this._loading.has(path); }
    getChildren(path: string) { return this._expanded.get(path) ?? null; }

    // ── Mutations ────────────────────────────────────────────

    /** Load root directory via requestLs("") — same flow as any other directory. */
    async loadRoot(): Promise<void> {
        const entries = await this._requestLs("");
        this._topLevel = entries;
        this._notify();
    }

    async expand(path: string) {
        if (this._expanded.has(path)) return;
        this._loading.add(path);
        this._notify();
        const children = await this._requestLs(path);
        this._loading.delete(path);
        this._expanded.set(path, children);
        // Tell server to watch this directory
        this._send({ type: "watch.dir", path });
        this._notify();
    }

    collapse(path: string) {
        // Collapse this dir and all nested expanded dirs
        const prefix = path + "/";
        for (const key of this._expanded.keys()) {
            if (key === path || key.startsWith(prefix)) {
                this._expanded.delete(key);
                // Tell server to stop watching
                this._send({ type: "unwatch.dir", path: key });
            }
        }
        this._notify();
    }

    toggle(path: string) {
        if (this._expanded.has(path)) {
            this.collapse(path);
        } else {
            this.expand(path);
        }
    }

    /** Called when server reports file system changes. Re-fetches root + all expanded dirs. */
    onFsChanged() {
        const expandedPaths = [...this._expanded.keys()];

        // Re-fetch root + all expanded dirs in parallel
        Promise.all([
            this.loadRoot(),
            ...expandedPaths.map(async (p) => {
                const children = await this._requestLs(p);
                this._expanded.set(p, children);
            }),
        ]).then(() => this._notify());
    }

    // ── React integration (useSyncExternalStore) ─────────────

    /** Subscribe to changes — returns unsubscribe function */
    subscribe = (fn: () => void) => {
        this._listeners.add(fn);
        return () => { this._listeners.delete(fn); };
    };

    /** Snapshot identity — changes on every mutation */
    private _snapshot = 0;
    getSnapshot = () => this._snapshot;

    private _notify() {
        this._snapshot++;
        for (const fn of this._listeners) fn();
    }
}

// ── React hooks & context ────────────────────────────────────

export const FileTreeContext = createContext<FileTreeModel | null>(null);

export function useFileTree(): FileTreeModel {
    const model = useContext(FileTreeContext);
    if (!model) throw new Error("useFileTree must be used within FileTreeContext.Provider");
    return model;
}

/** Subscribe to the model and re-render on changes */
export function useFileTreeSnapshot(model: FileTreeModel) {
    useSyncExternalStore(model.subscribe, model.getSnapshot);
}

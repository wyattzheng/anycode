import { useState, useEffect, useRef, useCallback, useMemo, useContext } from "react";
import { createChannel, type Channel } from "./channel";
import { getApiBase, getServerUrl, setServerUrl, isConfigured } from "./server-url";
import { TabBar } from "./components/TabBar";
import { MainView } from "./components/MainView";
import { ConversationOverlay } from "./components/ConversationOverlay";
import { WindowSwitcher } from "./components/WindowSwitcher";
import { createCodeHighlighter, HighlighterContext } from "./components/CodeViewer";
import { FileTreeModel, FileTreeContext } from "./file-tree";
import { FileReadCache, FileReadCacheContext, PreloadEngine, type BatchFileResult } from "./file-cache";
import type { WindowInfo } from "./components/WindowSwitcher";

export type TabId = "files" | "changes" | "terminal" | "preview" | string;

export interface DirEntry {
    name: string;
    type: "file" | "dir";
}

export interface GitChange {
    file: string;
    status: string;
}

export interface FileContext {
    file: string;
    lines: number[];
}



// ── Per-window view — each instance keeps its own DOM and state alive ────

interface WindowViewProps {
    sessionId: string;
    visible: boolean;
    onWindowsChanged: () => void;
}

function WindowView({ sessionId, visible, onWindowsChanged }: WindowViewProps) {
    const [activeTab, setActiveTab] = useState<TabId>(() => {
        try {
            const saved = localStorage.getItem(`anycode:tab:${sessionId}`);
            return (saved as TabId) || "files";
        } catch { return "files"; }
    });

    // Persist active tab per window
    useEffect(() => {
        try { localStorage.setItem(`anycode:tab:${sessionId}`, activeTab); } catch { }
    }, [sessionId, activeTab]);
    const [directory, setDirectory] = useState("");
    const [topLevel, setTopLevel] = useState<DirEntry[]>([]);
    const [changes, setChanges] = useState<GitChange[]>([]);
    const [fileContext, setFileContext] = useState<FileContext | null>(null);
    const [previewPort, setPreviewPort] = useState<number | null>(null);
    const [previewNotify, setPreviewNotify] = useState(false);
    const [chatBusy, setChatBusy] = useState(false);
    const [contextUsed, setContextUsed] = useState(0);
    const [compactionThreshold, setCompactionThreshold] = useState(0);
    const chatHandlerRef = useRef<((data: any) => void) | undefined>(undefined);
    const [connectGeneration, setConnectGeneration] = useState(0);
    const channelRef = useRef<Channel | null>(null);

    const sendMessage = useCallback((data: any) => {
        channelRef.current?.send(data);
    }, []);

    // Real-time sync via WebSocket Channel
    useEffect(() => {
        let disposed = false;
        let retryDelay = 1000;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        function connect() {
            if (disposed) return;
            const ch = createChannel(sessionId);
            channelRef.current = ch;

            ch.onopen = () => {
                retryDelay = 1000;
                setConnectGeneration(g => g + 1);
                onWindowsChanged();
            };

            ch.onmessage = (data) => {
                if (data.type === "state") {
                    if (data.directory) setDirectory(data.directory);
                    setTopLevel(data.topLevel || []);
                    fileTreeRef.current.setTopLevel(data.topLevel || []);
                    setChanges(data.changes || []);
                    if (data.previewPort !== undefined) {
                        setPreviewPort(data.previewPort);
                        if (data.previewPort != null) setPreviewNotify(true);
                    }
                    if (data.chatBusy !== undefined) setChatBusy(data.chatBusy);
                    if (data.contextUsed !== undefined) setContextUsed(data.contextUsed);
                    if (data.compactionThreshold !== undefined) setCompactionThreshold(data.compactionThreshold);
                } else if (data.type === "fs.changed") {
                    // Invalidate cached files in changed directories
                    const dirs: string[] = data.dirs ?? [];
                    for (const dir of dirs) {
                        fileCacheRef.current.invalidateDir(dir);
                    }
                    fileTreeRef.current?.onFsChanged();
                    // Re-trigger preload after invalidation (subscribe fires via onFsChanged)
                } else if (data.type === "windows.updated") {
                    onWindowsChanged();
                } else if (data.type?.startsWith("chat.")) {
                    chatHandlerRef.current?.(data);
                }
            };

            ch.onclose = () => {
                channelRef.current = null;
                if (!disposed) {
                    retryTimer = setTimeout(() => {
                        retryDelay = Math.min(retryDelay * 1.5, 10000);
                        connect();
                    }, retryDelay);
                }
            };
        }

        connect();

        return () => {
            disposed = true;
            clearTimeout(retryTimer);
            channelRef.current?.close();
            channelRef.current = null;
        };
    }, [sessionId, onWindowsChanged]);

    // ── FileReadCache (must be before requestLs since it's a dependency) ──
    const [fileCache] = useState(() => new FileReadCache());
    const fileCacheRef = useRef(fileCache);

    // Unified batch file fetch — single endpoint for all file/dir reads
    const fetchBatch = useCallback(async (paths: string[], withDiff = false): Promise<Record<string, BatchFileResult>> => {
        try {
            const res = await fetch(
                `${getApiBase()}/api/sessions/${sessionId}/files`,
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths, withDiff }) }
            );
            if (!res.ok) return {};
            const data = await res.json();
            const result: Record<string, BatchFileResult> = {};
            for (const [p, v] of Object.entries(data.files ?? {})) {
                const entry = v as any;
                result[p] = {
                    content: entry.content ?? null,
                    entries: entry.entries,
                    diff: entry.diff,
                };
            }
            return result;
        } catch {
            return {};
        }
    }, [sessionId]);

    // Directory listing: cache → batch fallback (same pattern as requestFile)
    const requestLs = useCallback(async (subPath: string): Promise<DirEntry[]> => {
        const cached = fileCache.getEntries(subPath);
        if (cached) return cached;
        const results = await fetchBatch([subPath]);
        const entries = results[subPath]?.entries ?? [];
        if (entries.length > 0) fileCache.setEntries(subPath, entries);
        return entries;
    }, [fetchBatch, fileCache]);

    // FileTreeModel: owns all file tree state
    const fileTree = useMemo(() => new FileTreeModel(requestLs, sendMessage), [requestLs, sendMessage]);
    const fileTreeRef = useRef(fileTree);
    fileTreeRef.current = fileTree;

    // ── Highlighter + PreloadEngine ──
    const codeHighlighter = useContext(HighlighterContext);

    // Cache-aware requestFile: cache → batch fallback
    const requestFile = useCallback(async (filePath: string): Promise<string | null> => {
        const cached = fileCache.getContent(filePath);
        if (cached != null) return cached;
        const results = await fetchBatch([filePath]);
        const content = results[filePath]?.content ?? null;
        if (content != null) fileCache.setContent(filePath, content);
        return content;
    }, [fileCache, fetchBatch]);

    // Preload engine: preloads visible files from expanded dirs
    const preloadRef = useRef<PreloadEngine | null>(null);
    useEffect(() => {
        if (!codeHighlighter) return;
        preloadRef.current = new PreloadEngine(fileCache, codeHighlighter, fetchBatch);
    }, [fileCache, codeHighlighter, fetchBatch]);

    // Trigger preload whenever file tree changes (expand/collapse/top-level update)
    useEffect(() => {
        const unsub = fileTree.subscribe(() => {
            preloadRef.current?.preloadFromTree(fileTree);
        });
        // Also preload on initial mount
        preloadRef.current?.preloadFromTree(fileTree);
        return unsub;
    }, [fileTree]);

    // Preload changed files when changes list updates
    useEffect(() => {
        if (changes.length > 0) {
            preloadRef.current?.preloadChanges(changes.map(c => c.file));
        }
    }, [changes]);



    // Cache-aware requestDiff: cache → batch fallback
    const requestDiff = useCallback(async (filePath: string): Promise<{ added: number[]; removed: number[] }> => {
        const cached = fileCache.getDiff(filePath);
        if (cached) return cached;
        const results = await fetchBatch([filePath], true);
        const diff = results[filePath]?.diff ?? { added: [], removed: [] };
        fileCache.setDiff(filePath, diff);
        // Also cache content if we got it
        const content = results[filePath]?.content;
        if (content != null && !fileCache.hasContent(filePath)) {
            fileCache.setContent(filePath, content);
        }
        return diff;
    }, [fileCache, fetchBatch]);

    const [poppedOut, setPoppedOut] = useState(() => {
        try {
            return localStorage.getItem(`anycode:poppedOut:${sessionId}`) === 'true';
        } catch { return false; }
    });

    // Compute conversation mode:
    // - chat tab + not popped out = "full" (conversation fills the tab)
    // - chat tab + popped out = "hidden" (conversation is in overlay, tab shows placeholder)
    // - other tab + popped out = "overlay" (sidebar/floating)
    // - other tab + not popped out = "hidden"
    const convMode = activeTab === "chat"
        ? (poppedOut ? "hidden" : "full")
        : (poppedOut ? "overlay" : "hidden");

    useEffect(() => {
        try { localStorage.setItem(`anycode:poppedOut:${sessionId}`, String(poppedOut)); } catch { }
    }, [sessionId, poppedOut]);

    const handlePopOut = useCallback(() => {
        setPoppedOut(true);
        setActiveTab("files"); // switch away from chat tab
    }, []);
    const handlePopIn = useCallback(() => {
        setPoppedOut(false);
        setActiveTab("chat"); // switch back to chat tab
    }, []);

    return (
        <div className="app-content" style={{ display: visible ? "flex" : "none" }}>
            <div className="main-path-bar">
                {directory
                    ? <span className="main-path-text">{directory.split("/").filter(Boolean).pop() || directory}</span>
                    : <span className="main-path-text" style={{ opacity: 0.35 }}>AnyCode</span>
                }
            </div>
            <div className="app-middle">
                <div className="app-main">
                    {directory ? (
                        <div style={{ display: activeTab === "chat" ? "none" : "flex", flex: 1 }}>
                            <FileTreeContext.Provider value={fileTree}>
                            <FileReadCacheContext.Provider value={fileCache}>
                            <MainView
                                activeTab={activeTab}
                                changes={changes}
                                directory={directory}
                                sessionId={sessionId}
                                previewPort={previewPort}
                                requestFile={requestFile}
                                requestDiff={requestDiff}
                                onFileContext={setFileContext}
                            />
                            </FileReadCacheContext.Provider>
                            </FileTreeContext.Provider>
                        </div>
                    ) : (
                        <div className="main-view" style={{ display: activeTab === "chat" ? "none" : "flex", alignItems: "center", justifyContent: "center" }}>
                            <div style={{ textAlign: "center" }}>
                                <p style={{ color: "var(--color-text-dim)", fontSize: "14px", opacity: 0.4, fontWeight: 500 }}>
                                    通过对话面板
                                </p>
                                <p style={{ color: "var(--color-text-dim)", fontSize: "11px", opacity: 0.3, marginTop: "6px" }}>
                                    打开一个项目并开始
                                </p>
                            </div>
                        </div>
                    )}
                </div>
                <ConversationOverlay sessionId={sessionId} fileContext={fileContext} chatHandlerRef={chatHandlerRef} connectGeneration={connectGeneration} chatBusy={chatBusy} sendMessage={sendMessage} mode={convMode as any} onPopOut={handlePopOut} onPopIn={handlePopIn} contextUsed={contextUsed} compactionThreshold={compactionThreshold} />
            </div>
            <TabBar activeTab={activeTab} onTabChange={(tab) => { if (tab === 'preview') setPreviewNotify(false); setActiveTab(tab); }} changeCount={changes.length} chatBusy={chatBusy} hideChatTab={poppedOut} previewNotify={previewNotify} />
        </div>
    );
}

// ── Capacitor / native app mode ─────────────────────────────────────────

function isNativeApp(): boolean {
    const origin = location.origin;
    return origin.startsWith("capacitor://") || origin.startsWith("ionic://");
}

function needsSetup(): boolean {
    return isNativeApp() && !isConfigured();
}

/** Enable viewport-fit=cover for safe area insets (Dynamic Island etc.) */
function applyNativeViewport() {
    if (!isNativeApp()) return;
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && !meta.getAttribute("content")?.includes("viewport-fit")) {
        meta.setAttribute("content", meta.getAttribute("content") + ", viewport-fit=cover");
    }
}

function ServerSetup({ onDone }: { onDone: () => void }) {
    const [url, setUrl] = useState(getServerUrl() || "https://");
    const [status, setStatus] = useState<"idle" | "connecting" | "error">("idle");
    const [errorMsg, setErrorMsg] = useState("");

    // Trigger iOS Local Network permission dialog immediately on mount
    useEffect(() => {
        fetch("https://captive.apple.com").catch(() => { });
    }, []);

    const handleSubmit = async () => {
        const trimmed = url.trim();
        if (!trimmed || trimmed === "https://" || trimmed === "http://") return;

        setStatus("connecting");
        setErrorMsg("");

        // Save first so getApiBase() returns the new URL
        setServerUrl(trimmed);

        try {
            // Test connection using the server's status endpoint
            const res = await fetch(`${trimmed}/api/status`, { signal: AbortSignal.timeout(10000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            onDone();
        } catch (e: any) {
            setStatus("error");
            setErrorMsg(e.message || "无法连接到服务器");
        }
    };

    return (
        <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "32px" }}>
            <div style={{ width: "100%", maxWidth: "360px", textAlign: "center" }}>
                <h2 style={{ color: "var(--color-text)", fontSize: "20px", fontWeight: 600, marginBottom: "8px" }}>AnyCode</h2>
                <p style={{ color: "var(--color-text-dim)", fontSize: "13px", marginBottom: "24px", opacity: 0.6 }}>
                    输入服务器地址以连接
                </p>
                <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://your-server.com"
                    onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                    disabled={status === "connecting"}
                    style={{
                        width: "100%", padding: "12px 16px", borderRadius: "10px",
                        border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.06)",
                        color: "var(--color-text)", fontSize: "15px", outline: "none",
                        boxSizing: "border-box",
                        opacity: status === "connecting" ? 0.5 : 1,
                    }}
                    autoFocus
                />
                {status === "error" && (
                    <p style={{ color: "var(--red, #f47067)", fontSize: "12px", marginTop: "8px" }}>
                        {errorMsg}
                    </p>
                )}
                <button
                    onClick={handleSubmit}
                    disabled={status === "connecting"}
                    style={{
                        width: "100%", marginTop: "16px", padding: "12px",
                        borderRadius: "10px", border: "none",
                        background: "var(--blue, #6cb6ff)", color: "#fff",
                        fontSize: "15px", fontWeight: 600, cursor: "pointer",
                        opacity: status === "connecting" ? 0.6 : 1,
                    }}
                >
                    {status === "connecting" ? "连接中…" : status === "error" ? "重试" : "连接"}
                </button>
            </div>
        </div>
    );
}

// ── App shell — manages windows list and renders all WindowViews ─────────

export function App() {
    const [codeHighlighter] = useState(() => createCodeHighlighter());
    const [setupDone, setSetupDone] = useState(!needsSetup());
    const [activeWindowId, setActiveWindowId] = useState<string | null>(null);
    const [windows, setWindows] = useState<WindowInfo[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => { applyNativeViewport(); }, []);

    const fetchWindows = useCallback(async () => {
        try {
            const res = await fetch(`${getApiBase()}/api/windows`);
            if (res.ok) {
                const list = await res.json();
                setWindows(list);
            }
        } catch { /* ignore */ }
    }, []);

    // Bootstrap: get or create default session, then load windows
    useEffect(() => {
        if (!setupDone) return;
        (async () => {
            try {
                const res = await fetch(`${getApiBase()}/api/sessions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);
                // Restore last window from localStorage, fallback to returned id
                const savedWindowId = localStorage.getItem('anycode:lastWindow');
                setActiveWindowId(savedWindowId || data.id);
                fetchWindows();
            } catch (e: any) {
                setError(e.message);
            }
        })();
    }, [fetchWindows, setupDone]);

    // If saved window doesn't exist in the list, fall back
    useEffect(() => {
        if (!activeWindowId || windows.length === 0) return;
        if (!windows.some(w => w.id === activeWindowId)) {
            const fallback = windows.find(w => w.isDefault) || windows[0];
            if (fallback) {
                setActiveWindowId(fallback.id);
                try { localStorage.setItem('anycode:lastWindow', fallback.id); } catch { }
            }
        }
    }, [activeWindowId, windows]);

    const handleWindowSwitch = useCallback((id: string) => {
        setActiveWindowId(id);
        try { localStorage.setItem('anycode:lastWindow', id); } catch { }
    }, []);

    const [windowCreating, setWindowCreating] = useState(false);

    const handleWindowCreate = useCallback(async () => {
        if (windowCreating) return;
        setWindowCreating(true);
        try {
            const res = await fetch(`${getApiBase()}/api/windows`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            const data = await res.json();
            if (data.error) return;
            await fetchWindows();
            setActiveWindowId(data.id);
            try { localStorage.setItem('anycode:lastWindow', data.id); } catch { }
        } catch { /* ignore */ } finally {
            setWindowCreating(false);
        }
    }, [fetchWindows, windowCreating]);

    const handleWindowDelete = useCallback(async (id: string) => {
        try {
            const res = await fetch(`${getApiBase()}/api/windows/${id}`, { method: "DELETE" });
            if (!res.ok) return;
            if (id === activeWindowId) {
                const remaining = windows.filter((w) => w.id !== id);
                const fallback = remaining.find((w) => w.isDefault) || remaining[0];
                if (fallback) setActiveWindowId(fallback.id);
            }
            fetchWindows();
        } catch { /* ignore */ }
    }, [activeWindowId, windows, fetchWindows]);

    if (!setupDone) {
        return <ServerSetup onDone={() => setSetupDone(true)} />;
    }

    if (error) {
        return (
            <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "16px" }}>
                <p style={{ color: "var(--red)", fontSize: "14px" }}>连接失败: {error}</p>
                <button
                    onClick={() => { setServerUrl(""); location.reload(); }}
                    style={{ padding: "8px 20px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.08)", color: "var(--color-text-dim)", fontSize: "13px", cursor: "pointer" }}
                >
                    重新配置服务器
                </button>
            </div>
        );
    }

    if (!activeWindowId) {
        return (
            <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>连接服务器中…</p>
            </div>
        );
    }

    return (
        <HighlighterContext.Provider value={codeHighlighter}>
        <div className="app-root">
            <WindowSwitcher
                windows={windows}
                activeWindowId={activeWindowId}
                onSwitch={handleWindowSwitch}
                onCreate={handleWindowCreate}
                onDelete={handleWindowDelete}
                creating={windowCreating}
            />
            {windows.map((w) => (
                <WindowView
                    key={w.id}
                    sessionId={w.id}
                    visible={w.id === activeWindowId}
                    onWindowsChanged={fetchWindows}
                />
            ))}
        </div>
        </HighlighterContext.Provider>
    );
}

import { useState, useEffect, useRef, useCallback } from "react";
import { createChannel, type Channel } from "./channel";
import { TabBar } from "./components/TabBar";
import { MainView } from "./components/MainView";
import { ConversationOverlay } from "./components/ConversationOverlay";
import { WindowSwitcher } from "./components/WindowSwitcher";
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

const API_BASE = "";


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
        try { localStorage.setItem(`anycode:tab:${sessionId}`, activeTab); } catch {}
    }, [sessionId, activeTab]);
    const [directory, setDirectory] = useState("");
    const [topLevel, setTopLevel] = useState<DirEntry[]>([]);
    const [changes, setChanges] = useState<GitChange[]>([]);
    const [fileContext, setFileContext] = useState<FileContext | null>(null);
    const [previewPort, setPreviewPort] = useState<number | null>(null);
    const chatHandlerRef = useRef<((data: any) => void) | undefined>(undefined);
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
                onWindowsChanged();
            };

            ch.onmessage = (data) => {
                if (data.type === "state") {
                    if (data.directory) setDirectory(data.directory);
                    setTopLevel(data.topLevel || []);
                    setChanges(data.changes || []);
                    if (data.previewPort !== undefined) setPreviewPort(data.previewPort);
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

    const requestLs = useCallback(async (subPath: string): Promise<DirEntry[]> => {
        try {
            const res = await fetch(
                `${API_BASE}/api/sessions/${sessionId}/ls?path=${encodeURIComponent(subPath)}`
            );
            if (!res.ok) return [];
            const data = await res.json();
            return data.entries ?? [];
        } catch {
            return [];
        }
    }, [sessionId]);

    const requestFile = useCallback(async (filePath: string): Promise<string | null> => {
        try {
            const res = await fetch(
                `${API_BASE}/api/sessions/${sessionId}/file?path=${encodeURIComponent(filePath)}`
            );
            if (!res.ok) return null;
            const data = await res.json();
            return data.content ?? null;
        } catch {
            return null;
        }
    }, [sessionId]);

    const requestDiff = useCallback(async (filePath: string): Promise<{ added: number[]; removed: number[] }> => {
        try {
            const res = await fetch(
                `${API_BASE}/api/sessions/${sessionId}/diff?path=${encodeURIComponent(filePath)}`
            );
            if (!res.ok) return { added: [], removed: [] };
            return await res.json();
        } catch {
            return { added: [], removed: [] };
        }
    }, [sessionId]);

    return (
        <div className="app-content" style={{ display: visible ? "flex" : "none" }}>
            {directory && (
                <div className="main-path-bar">
                    <span className="main-path-text">{directory}</span>
                </div>
            )}
            <div className="app-middle">
                <div className="app-main">
                    {directory ? (
                        <MainView
                            activeTab={activeTab}
                            topLevel={topLevel}
                            changes={changes}
                            directory={directory}
                            sessionId={sessionId}
                            previewPort={previewPort}
                            requestLs={requestLs}
                            requestFile={requestFile}
                            requestDiff={requestDiff}
                            onFileContext={setFileContext}
                        />
                    ) : (
                        <div className="main-view" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
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
                <ConversationOverlay sessionId={sessionId} fileContext={fileContext} chatHandlerRef={chatHandlerRef} sendMessage={sendMessage} />
            </div>
            <TabBar activeTab={activeTab} onTabChange={setActiveTab} changeCount={changes.length} />
        </div>
    );
}

// ── App shell — manages windows list and renders all WindowViews ─────────

export function App() {
    const [activeWindowId, setActiveWindowId] = useState<string | null>(null);
    const [windows, setWindows] = useState<WindowInfo[]>([]);
    const [error, setError] = useState<string | null>(null);


    const fetchWindows = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/windows`);
            if (res.ok) {
                const list = await res.json();
                setWindows(list);
            }
        } catch { /* ignore */ }
    }, []);

    // Bootstrap: get or create default session, then load windows
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/sessions`, {
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
    }, [fetchWindows]);

    // If saved window doesn't exist in the list, fall back
    useEffect(() => {
        if (!activeWindowId || windows.length === 0) return;
        if (!windows.some(w => w.id === activeWindowId)) {
            const fallback = windows.find(w => w.isDefault) || windows[0];
            if (fallback) {
                setActiveWindowId(fallback.id);
                try { localStorage.setItem('anycode:lastWindow', fallback.id); } catch {}
            }
        }
    }, [activeWindowId, windows]);

    const handleWindowSwitch = useCallback((id: string) => {
        setActiveWindowId(id);
        try { localStorage.setItem('anycode:lastWindow', id); } catch {}
    }, []);

    const handleWindowCreate = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/windows`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            const data = await res.json();
            if (data.error) return;
            setActiveWindowId(data.id);
            try { localStorage.setItem('anycode:lastWindow', data.id); } catch {}
            fetchWindows();
        } catch { /* ignore */ }
    }, [fetchWindows]);

    const handleWindowDelete = useCallback(async (id: string) => {
        try {
            const res = await fetch(`${API_BASE}/api/windows/${id}`, { method: "DELETE" });
            if (!res.ok) return;
            if (id === activeWindowId) {
                const remaining = windows.filter((w) => w.id !== id);
                const fallback = remaining.find((w) => w.isDefault) || remaining[0];
                if (fallback) setActiveWindowId(fallback.id);
            }
            fetchWindows();
        } catch { /* ignore */ }
    }, [activeWindowId, windows, fetchWindows]);

    if (error) {
        return (
            <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <p style={{ color: "var(--red)", fontSize: "14px" }}>连接失败: {error}</p>
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
        <div className="app-root">
            <WindowSwitcher
                windows={windows}
                activeWindowId={activeWindowId}
                onSwitch={handleWindowSwitch}
                onCreate={handleWindowCreate}
                onDelete={handleWindowDelete}
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
    );
}

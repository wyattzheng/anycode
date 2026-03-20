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

function getUserId(): string {
    const KEY = "anycode-user-id";
    let id = localStorage.getItem(KEY);
    if (!id) {
        id = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
        localStorage.setItem(KEY, id);
    }
    return id;
}

// ── Per-window view — each instance keeps its own DOM and state alive ────

interface WindowViewProps {
    sessionId: string;
    visible: boolean;
    onWindowsChanged: () => void;
}

function WindowView({ sessionId, visible, onWindowsChanged }: WindowViewProps) {
    const [activeTab, setActiveTab] = useState<TabId>("files");
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

    // Real-time sync via Channel (WebSocket or HTTP polling)
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
                    <div className="main-view" style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "16px" }}>
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-dim)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                        <p style={{ color: "var(--color-text-dim)", fontSize: "13px", opacity: 0.5, textAlign: "center", lineHeight: 1.6, maxWidth: "220px" }}>
                            通过对话面板<br />打开一个项目开始编辑
                        </p>
                    </div>
                )}
                <TabBar activeTab={activeTab} onTabChange={setActiveTab} changeCount={changes.length} />
            </div>
            <ConversationOverlay sessionId={sessionId} fileContext={fileContext} chatHandlerRef={chatHandlerRef} sendMessage={sendMessage} />
        </div>
    );
}

// ── App shell — manages windows list and renders all WindowViews ─────────

export function App() {
    const [activeWindowId, setActiveWindowId] = useState<string | null>(null);
    const [windows, setWindows] = useState<WindowInfo[]>([]);
    const [error, setError] = useState<string | null>(null);

    const userId = useRef(getUserId());

    const fetchWindows = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/windows?userId=${userId.current}`);
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
                    body: JSON.stringify({ userId: userId.current }),
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);
                setActiveWindowId(data.id);
                fetchWindows();
            } catch (e: any) {
                setError(e.message);
            }
        })();
    }, [fetchWindows]);

    const handleWindowSwitch = useCallback((id: string) => {
        setActiveWindowId(id);
    }, []);

    const handleWindowCreate = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/windows`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: userId.current }),
            });
            const data = await res.json();
            if (data.error) return;
            setActiveWindowId(data.id);
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
            {windows.map((w) => (
                <WindowView
                    key={w.id}
                    sessionId={w.id}
                    visible={w.id === activeWindowId}
                    onWindowsChanged={fetchWindows}
                />
            ))}
            <WindowSwitcher
                windows={windows}
                activeWindowId={activeWindowId}
                onSwitch={handleWindowSwitch}
                onCreate={handleWindowCreate}
                onDelete={handleWindowDelete}
            />
        </div>
    );
}

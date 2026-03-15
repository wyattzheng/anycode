import { useState, useEffect, useRef } from "react";
import { TabBar } from "./components/TabBar";
import { MainView } from "./components/MainView";
import { ConversationOverlay } from "./components/ConversationOverlay";

export type TabId = "files" | "changes" | string;

export interface DirEntry {
    name: string;
    type: "file" | "dir";
}

export interface GitChange {
    file: string;
    status: string;
}

/** WebSocket message: server → client */
export type WsMessage =
    | { type: "state"; directory: string; changes: GitChange[]; topLevel: DirEntry[] }
    | { type: "ls"; path: string; entries: DirEntry[] }
    | { type: "fileContent"; path: string; content: string | null; error?: string };

const API_BASE = "";

export function App() {
    const [activeTab, setActiveTab] = useState<TabId>("files");
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [directory, setDirectory] = useState<string>("");
    const [topLevel, setTopLevel] = useState<DirEntry[]>([]);
    const [changes, setChanges] = useState<GitChange[]>([]);
    const [error, setError] = useState<string | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

    // ls request-response handlers
    const lsCallbacks = useRef<Map<string, (entries: DirEntry[]) => void>>(new Map());
    // readFile request-response handlers
    const readFileCallbacks = useRef<Map<string, (content: string | null) => void>>(new Map());

    // Restore or create session on mount
    useEffect(() => {
        (async () => {
            try {
                // 1. Try to restore session from sessionStorage
                const savedId = sessionStorage.getItem("anycode-session-id");
                if (savedId) {
                    const res = await fetch(`${API_BASE}/api/sessions/${savedId}`);
                    if (res.ok) {
                        const data = await res.json();
                        setSessionId(data.id);
                        if (data.directory) setDirectory(data.directory);
                        return;
                    }
                    // Session expired — clear stale id
                    sessionStorage.removeItem("anycode-session-id");
                }

                // 2. Check for existing sessions with a workspace
                const listRes = await fetch(`${API_BASE}/api/sessions`);
                if (listRes.ok) {
                    const sessions: { id: string; directory: string }[] = await listRes.json();
                    const active = sessions.find((s) => s.directory);
                    if (active) {
                        setSessionId(active.id);
                        setDirectory(active.directory);
                        sessionStorage.setItem("anycode-session-id", active.id);
                        return;
                    }
                }

                // 3. No existing session — create new
                const res = await fetch(`${API_BASE}/api/sessions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                });
                const data = await res.json();
                setSessionId(data.id);
                sessionStorage.setItem("anycode-session-id", data.id);
                if (data.directory) setDirectory(data.directory);
            } catch (e: any) {
                setError(e.message);
            }
        })();
    }, []);

    // Connect WebSocket when session is ready
    useEffect(() => {
        if (!sessionId) return;

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const host = API_BASE ? new URL(API_BASE).host : window.location.host;
        const ws = new WebSocket(`${protocol}//${host}?sessionId=${sessionId}`);
        wsRef.current = ws;

        ws.onmessage = (event) => {
            try {
                const msg: WsMessage = JSON.parse(event.data);

                if (msg.type === "state") {
                    if (msg.directory) setDirectory(msg.directory);
                    setChanges(msg.changes);
                    setTopLevel(msg.topLevel);
                }

                if (msg.type === "ls") {
                    const cb = lsCallbacks.current.get(msg.path);
                    if (cb) {
                        cb(msg.entries);
                        lsCallbacks.current.delete(msg.path);
                    }
                }

                if (msg.type === "fileContent") {
                    const cb = readFileCallbacks.current.get(msg.path);
                    if (cb) {
                        cb(msg.content);
                        readFileCallbacks.current.delete(msg.path);
                    }
                }
            } catch { /* ignore */ }
        };

        ws.onclose = () => {
            wsRef.current = null;
        };

        return () => {
            ws.close();
            wsRef.current = null;
        };
    }, [sessionId]);

    // Also poll directory (fallback if WebSocket hasn't connected yet)
    useEffect(() => {
        if (!sessionId || directory) return;
        const timer = setInterval(async () => {
            try {
                const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
                const data = await res.json();
                if (data.directory) setDirectory(data.directory);
            } catch { /* ignore */ }
        }, 2000);
        return () => clearInterval(timer);
    }, [sessionId, directory]);

    /** Request directory listing for a sub-path (lazy tree expand) */
    const requestLs = (subPath: string): Promise<DirEntry[]> => {
        return new Promise((resolve) => {
            const ws = wsRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                resolve([]);
                return;
            }
            lsCallbacks.current.set(subPath, resolve);
            ws.send(JSON.stringify({ type: "ls", path: subPath }));
            // Timeout: resolve empty after 5s if no response
            setTimeout(() => {
                if (lsCallbacks.current.has(subPath)) {
                    lsCallbacks.current.delete(subPath);
                    resolve([]);
                }
            }, 5000);
        });
    };

    /** Request file content by relative path */
    const requestFile = (filePath: string): Promise<string | null> => {
        return new Promise((resolve) => {
            const ws = wsRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                resolve(null);
                return;
            }
            readFileCallbacks.current.set(filePath, resolve);
            ws.send(JSON.stringify({ type: "readFile", path: filePath }));
            setTimeout(() => {
                if (readFileCallbacks.current.has(filePath)) {
                    readFileCallbacks.current.delete(filePath);
                    resolve(null);
                }
            }, 5000);
        });
    };

    if (error) {
        return (
            <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <p style={{ color: "var(--red)", fontSize: "14px" }}>连接失败: {error}</p>
            </div>
        );
    }

    if (!sessionId) {
        return (
            <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>连接服务器中…</p>
            </div>
        );
    }

    // No directory yet — empty main view + floating conversation + tab bar
    if (!directory) {
        return (
            <div className="app">
                <div className="main-view" style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "16px" }}>
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-dim)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <p style={{ color: "var(--color-text-dim)", fontSize: "13px", opacity: 0.5, textAlign: "center", lineHeight: 1.6, maxWidth: "200px" }}>
                        通过对话面板<br />打开一个新项目
                    </p>
                </div>
                <ConversationOverlay sessionId={sessionId} />
                <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
            </div>
        );
    }

    // Directory set — full UI
    return (
        <div className="app">
            <MainView activeTab={activeTab} topLevel={topLevel} changes={changes} requestLs={requestLs} requestFile={requestFile} />
            <ConversationOverlay sessionId={sessionId} />
            <TabBar
                activeTab={activeTab}
                onTabChange={setActiveTab}
            />
        </div>
    );
}

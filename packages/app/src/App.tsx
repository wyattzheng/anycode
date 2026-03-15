import { useState, useEffect, useRef, useCallback } from "react";
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

const API_BASE = "";

export function App() {
    const [activeTab, setActiveTab] = useState<TabId>("files");
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [directory, setDirectory] = useState<string>("");
    const [topLevel, setTopLevel] = useState<DirEntry[]>([]);
    const [changes, setChanges] = useState<GitChange[]>([]);
    const [error, setError] = useState<string | null>(null);

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

    // Poll state (directory, topLevel, changes) via HTTP
    // TODO: 目前只轮询根目录（topLevel），已展开的子目录不会自动刷新。
    //       未来可以让客户端上报已展开路径，服务端批量返回，或使用版本号对比局部刷新。
    const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
    useEffect(() => {
        if (!sessionId) return;

        const pollState = async () => {
            try {
                const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/state`);
                if (!res.ok) return;
                const data = await res.json();
                if (data.directory) setDirectory(data.directory);
                setTopLevel(data.topLevel);
                setChanges(data.changes);
            } catch { /* ignore */ }
        };

        // Immediate first poll
        pollState();
        pollRef.current = setInterval(pollState, 3000);

        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [sessionId]);

    /** Request directory listing for a sub-path (lazy tree expand) via HTTP */
    const requestLs = useCallback(async (subPath: string): Promise<DirEntry[]> => {
        if (!sessionId) return [];
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

    /** Request file content by relative path via HTTP */
    const requestFile = useCallback(async (filePath: string): Promise<string | null> => {
        if (!sessionId) return null;
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

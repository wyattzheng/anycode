import { useState, useEffect, useCallback, useRef } from "react";
import { TabBar } from "./components/TabBar";
import { MainView } from "./components/MainView";
import { ConversationOverlay } from "./components/ConversationOverlay";

export type TabId = "files" | "changes" | string;

export interface FileTreeNode {
    name: string;
    type: "file" | "dir";
    children?: FileTreeNode[];
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
    const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
    const [changes, setChanges] = useState<GitChange[]>([]);
    const [error, setError] = useState<string | null>(null);

    // Create session on mount
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/sessions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                });
                const data = await res.json();
                setSessionId(data.id);
                setDirectory(data.directory || "");
            } catch (e: any) {
                setError(e.message);
            }
        })();
    }, []);

    // Poll session status continuously (directory, file tree, changes)
    useEffect(() => {
        if (!sessionId) return;
        const poll = async () => {
            try {
                const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
                const data = await res.json();
                if (data.directory) setDirectory(data.directory);
                if (data.fileTree) setFileTree(data.fileTree);
                if (data.changes) setChanges(data.changes);
            } catch { /* ignore */ }
        };
        poll(); // immediate first poll
        const timer = setInterval(poll, 3000);
        return () => clearInterval(timer);
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
            <MainView activeTab={activeTab} fileTree={fileTree} changes={changes} />
            <ConversationOverlay sessionId={sessionId} />
            <TabBar
                activeTab={activeTab}
                onTabChange={setActiveTab}
            />
        </div>
    );
}

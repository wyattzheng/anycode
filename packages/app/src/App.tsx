import { useState, useEffect, useCallback } from "react";
import { TabBar } from "./components/TabBar";
import { MainView } from "./components/MainView";
import { ConversationOverlay } from "./components/ConversationOverlay";

export type TabId = "files" | "changes" | string;

const API_BASE = "";

export function App() {
    const [activeTab, setActiveTab] = useState<TabId>("files");
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [directory, setDirectory] = useState<string>("");
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

    // Poll session directory status
    useEffect(() => {
        if (!sessionId || directory) return;
        const timer = setInterval(async () => {
            try {
                const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
                const data = await res.json();
                if (data.directory) {
                    setDirectory(data.directory);
                }
            } catch { /* ignore */ }
        }, 2000);
        return () => clearInterval(timer);
    }, [sessionId, directory]);

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
                <div className="main-view" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <p style={{ color: "var(--color-text-dim)", fontSize: "13px", opacity: 0.5 }}>
                        等待选择工作目录…
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
            <MainView activeTab={activeTab} />
            <ConversationOverlay sessionId={sessionId} />
            <TabBar
                activeTab={activeTab}
                onTabChange={setActiveTab}
            />
        </div>
    );
}

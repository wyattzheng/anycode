import { useRef, useCallback } from "react";
import type { TabId } from "../App";
import { MonitorIcon, TerminalIcon, FolderIcon, DiffIcon, ChatIcon } from "./Icons";
import "./TabBar.css";

interface TabBarProps {
    activeTab: TabId;
    onTabChange: (tab: TabId) => void;
    changeCount?: number;
    chatBusy?: boolean;
    hideChatTab?: boolean;
    previewNotify?: boolean;
}

export function TabBar({ activeTab, onTabChange, changeCount, chatBusy, hideChatTab, previewNotify }: TabBarProps) {
    const dragging = useRef(false);
    const lastTab = useRef<string | null>(null);

    const activateAt = useCallback((x: number, y: number) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return;
        const btn = (el as HTMLElement).closest<HTMLElement>("[data-tab]");
        if (!btn) return;
        const tab = btn.dataset.tab as TabId;
        if (tab && tab !== lastTab.current) {
            lastTab.current = tab;
            onTabChange(tab);
        }
    }, [onTabChange]);

    const onTouchStart = useCallback(() => {
        dragging.current = true;
        lastTab.current = null;
    }, []);

    const onTouchMove = useCallback((e: React.TouchEvent) => {
        if (!dragging.current) return;
        const t = e.touches[0];
        activateAt(t.clientX, t.clientY);
    }, [activateAt]);

    const onTouchEnd = useCallback(() => {
        dragging.current = false;
        lastTab.current = null;
    }, []);

    const onMouseDown = useCallback(() => {
        dragging.current = true;
        lastTab.current = null;
    }, []);

    const onMouseMove = useCallback((e: React.MouseEvent) => {
        if (!dragging.current) return;
        activateAt(e.clientX, e.clientY);
    }, [activateAt]);

    const onMouseUp = useCallback(() => {
        dragging.current = false;
        lastTab.current = null;
    }, []);

    const onMouseLeave = useCallback(() => {
        dragging.current = false;
        lastTab.current = null;
    }, []);

    return (
        <nav
            className="tab-bar"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
        >
            <div className="tab-spacer" />

            {!hideChatTab && (
                <button
                    className={`tab-item ${activeTab === "chat" ? "active" : ""} tab-chat`}
                    data-tab="chat"
                    onClick={() => onTabChange("chat")}
                >
                    <span className="tab-icon">
                        <ChatIcon />
                        {chatBusy && <span className="tab-busy-dot" />}
                    </span>
                    <span className="tab-label">对话</span>
                </button>
            )}

            <button
                className={`tab-item ${activeTab === "terminal" ? "active" : ""}`}
                data-tab="terminal"
                onClick={() => onTabChange("terminal")}
            >
                <span className="tab-icon"><TerminalIcon /></span>
                <span className="tab-label">终端</span>
            </button>

            <button
                className={`tab-item ${activeTab === "files" ? "active" : ""}`}
                data-tab="files"
                onClick={() => onTabChange("files")}
            >
                <span className="tab-icon"><FolderIcon /></span>
                <span className="tab-label">文件</span>
            </button>

            <button
                className={`tab-item ${activeTab === "changes" ? "active" : ""}`}
                data-tab="changes"
                onClick={() => onTabChange("changes")}
            >
                <span className="tab-icon">
                    <DiffIcon />
                    {changeCount !== undefined && changeCount > 0 && (
                        <span className="tab-badge">{changeCount}</span>
                    )}
                </span>
                <span className="tab-label">变更</span>
            </button>

            <button
                className={`tab-item ${activeTab === "preview" ? "active" : ""}`}
                data-tab="preview"
                onClick={() => onTabChange("preview")}
            >
                <span className="tab-icon">
                    <MonitorIcon />
                    {previewNotify && <span className="tab-notify-dot" />}
                </span>
                <span className="tab-label">预览</span>
            </button>
        </nav>
    );
}

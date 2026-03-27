import type { TabId } from "../App";
import { MonitorIcon, TerminalIcon, FolderIcon, DiffIcon, ChatIcon } from "./Icons";
import "./TabBar.css";

interface TabBarProps {
    activeTab: TabId;
    onTabChange: (tab: TabId) => void;
    changeCount?: number;
    chatBusy?: boolean;
}

export function TabBar({ activeTab, onTabChange, changeCount, chatBusy }: TabBarProps) {
    return (
        <nav className="tab-bar">
            <div className="tab-spacer" />

            <button
                className={`tab-item ${activeTab === "chat" ? "active" : ""} tab-chat`}
                onClick={() => onTabChange("chat")}
            >
                <span className="tab-icon">
                    <ChatIcon />
                    {chatBusy && <span className="tab-busy-dot" />}
                </span>
                <span className="tab-label">对话</span>
            </button>

            <button
                className={`tab-item ${activeTab === "preview" ? "active" : ""}`}
                onClick={() => onTabChange("preview")}
            >
                <span className="tab-icon"><MonitorIcon /></span>
                <span className="tab-label">预览</span>
            </button>

            <button
                className={`tab-item ${activeTab === "terminal" ? "active" : ""}`}
                onClick={() => onTabChange("terminal")}
            >
                <span className="tab-icon"><TerminalIcon /></span>
                <span className="tab-label">终端</span>
            </button>

            <button
                className={`tab-item ${activeTab === "files" ? "active" : ""}`}
                onClick={() => onTabChange("files")}
            >
                <span className="tab-icon"><FolderIcon /></span>
                <span className="tab-label">文件</span>
            </button>

            <button
                className={`tab-item ${activeTab === "changes" ? "active" : ""}`}
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
        </nav>
    );
}

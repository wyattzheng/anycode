import type { TabId } from "../App";
import "./TabBar.css";

interface TabBarProps {
    activeTab: TabId;
    onTabChange: (tab: TabId) => void;
    chatOpen: boolean;
    onChatToggle: () => void;
}

export function TabBar({ activeTab, onTabChange, chatOpen, onChatToggle }: TabBarProps) {
    return (
        <nav className="tab-bar">
            <button
                className={`tab-item ${activeTab === "files" ? "active" : ""}`}
                onClick={() => onTabChange("files")}
            >
                <span className="tab-icon">📁</span>
                <span className="tab-label">文件</span>
            </button>

            <button
                className={`tab-item ${activeTab === "changes" ? "active" : ""}`}
                onClick={() => onTabChange("changes")}
            >
                <span className="tab-icon">📝</span>
                <span className="tab-label">变更</span>
            </button>

            {/* 动态 Tab 区域：未来从 agent tablist JSON 读取 */}

            <div className="tab-spacer" />

            <button
                className={`tab-item tab-chat ${chatOpen ? "active" : ""}`}
                onClick={onChatToggle}
            >
                <span className="tab-icon">💬</span>
                <span className="tab-label">对话</span>
            </button>
        </nav>
    );
}

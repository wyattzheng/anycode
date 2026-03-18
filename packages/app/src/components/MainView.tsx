import { useState, useEffect } from "react";
import type { TabId, DirEntry, GitChange, FileContext } from "../App";
import { FileBrowser } from "./FileBrowser";
import { ChangesView } from "./ChangesView";
import { PreviewTab } from "./PreviewTab";
import { TerminalTab } from "./TerminalTab";

import "./MainView.css";

interface MainViewProps {
    activeTab: TabId;
    topLevel: DirEntry[];
    changes: GitChange[];
    directory: string;
    sessionId: string;
    previewPort: number | null;
    requestLs: (path: string) => Promise<DirEntry[]>;
    requestFile: (path: string) => Promise<string | null>;
    requestDiff: (path: string) => Promise<{ added: number[]; removed: number[] }>;
    onFileContext?: (ctx: FileContext | null) => void;
}

export function MainView({ activeTab, topLevel, changes, directory, sessionId, previewPort, requestLs, requestFile, requestDiff, onFileContext }: MainViewProps) {
    // Lazy-mount terminal: only create once the tab is first activated
    const [terminalMounted, setTerminalMounted] = useState(false);
    useEffect(() => {
        if (activeTab === "terminal") setTerminalMounted(true);
    }, [activeTab]);

    return (
        <div className="main-view">
            <div className="main-path-bar">
                <span className="main-path-text">{directory}</span>
            </div>
            <div className="main-tab-area">
                <div className="main-tab-panel" style={{ display: activeTab === "files" ? "flex" : "none" }}>
                    <FileBrowser topLevel={topLevel} requestLs={requestLs} requestFile={requestFile} onFileContext={onFileContext} />
                </div>
                <div className="main-tab-panel" style={{ display: activeTab === "changes" ? "flex" : "none" }}>
                    <ChangesView changes={changes} requestFile={requestFile} requestDiff={requestDiff} onFileContext={onFileContext} />
                </div>
                <div className="main-tab-panel" style={{ display: activeTab === "terminal" ? "flex" : "none" }}>
                    {terminalMounted && <TerminalTab sessionId={sessionId} />}
                </div>
                <div className="main-tab-panel" style={{ display: activeTab === "preview" ? "flex" : "none" }}>
                    <PreviewTab previewPort={previewPort} />
                </div>

                {/* 动态 Tab：渲染 iframe 访问 agent web 项目路由 */}
                {activeTab !== "files" && activeTab !== "changes" && activeTab !== "terminal" && activeTab !== "preview" && (
                    <iframe
                        className="main-view-iframe"
                        src={activeTab}
                        title="Agent View"
                    />
                )}
            </div>
        </div>
    );
}

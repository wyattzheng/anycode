import { useState, useEffect } from "react";
import type { TabId, GitChange, FileContext } from "../App";
import { FileBrowser } from "./FileBrowser";
import { ChangesView } from "./ChangesView";
import { PreviewTab } from "./PreviewTab";
import { TerminalTab } from "./TerminalTab";

import "./MainView.css";

interface MainViewProps {
    activeTab: TabId;
    changes: GitChange[];
    directory: string;
    sessionId: string;
    previewPort: number | null;
    previewBaseUrl: string | null;
    previewPath: string | null;
    requestFile: (path: string) => Promise<string | null>;
    requestDiff: (path: string) => Promise<{ added: number[]; removed: number[] }>;
    onFileContext?: (ctx: FileContext | null) => void;
}

export function MainView({ activeTab, changes, directory, sessionId, previewPort, previewBaseUrl, previewPath, requestFile, requestDiff, onFileContext }: MainViewProps) {
    // Lazy-mount terminal: only create once the tab is first activated
    const [terminalMounted, setTerminalMounted] = useState(false);
    useEffect(() => {
        if (activeTab === "terminal") setTerminalMounted(true);
    }, [activeTab]);

    return (
        <div className="main-view">
            <div className="main-tab-area">
                <div className="main-tab-panel" style={{ display: activeTab === "files" ? "flex" : "none" }}>
                    <FileBrowser requestFile={requestFile} onFileContext={onFileContext} />
                </div>
                <div className="main-tab-panel" style={{ display: activeTab === "changes" ? "flex" : "none" }}>
                    <ChangesView changes={changes} requestFile={requestFile} requestDiff={requestDiff} onFileContext={onFileContext} />
                </div>
                <div className="main-tab-panel" style={{ display: activeTab === "terminal" ? "flex" : "none" }}>
                    {terminalMounted && <TerminalTab sessionId={sessionId} />}
                </div>
                <div className="main-tab-panel" style={{ display: activeTab === "preview" ? "flex" : "none" }}>
                    <PreviewTab previewPort={previewPort} previewBaseUrl={previewBaseUrl} previewPath={previewPath} />
                </div>

                {/* 动态 Tab：渲染 iframe 访问 agent web 项目路由 */}
                {activeTab !== "files" && activeTab !== "changes" && activeTab !== "terminal" && activeTab !== "preview" && activeTab !== "chat" && (
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

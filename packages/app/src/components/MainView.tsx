import type { TabId, DirEntry, GitChange } from "../App";
import { FileBrowser } from "./FileBrowser";
import { ChangesView } from "./ChangesView";
import { PreviewTab } from "./PreviewTab";
import "./MainView.css";

interface MainViewProps {
    activeTab: TabId;
    topLevel: DirEntry[];
    changes: GitChange[];
    requestLs: (path: string) => Promise<DirEntry[]>;
    requestFile: (path: string) => Promise<string | null>;
}

export function MainView({ activeTab, topLevel, changes, requestLs, requestFile }: MainViewProps) {
    return (
        <div className="main-view">
            {activeTab === "files" && <FileBrowser topLevel={topLevel} requestLs={requestLs} requestFile={requestFile} />}
            {activeTab === "changes" && <ChangesView changes={changes} />}
            {activeTab === "preview" && <PreviewTab />}

            {/* 动态 Tab：渲染 iframe 访问 agent web 项目路由 */}
            {activeTab !== "files" && activeTab !== "changes" && activeTab !== "preview" && (
                <iframe
                    className="main-view-iframe"
                    src={activeTab}
                    title="Agent View"
                />
            )}
        </div>
    );
}

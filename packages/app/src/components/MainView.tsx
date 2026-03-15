import type { TabId, FileTreeNode, GitChange } from "../App";
import { FileBrowser } from "./FileBrowser";
import { ChangesView } from "./ChangesView";
import { PreviewTab } from "./PreviewTab";
import "./MainView.css";

interface MainViewProps {
    activeTab: TabId;
    fileTree: FileTreeNode[];
    changes: GitChange[];
}

export function MainView({ activeTab, fileTree, changes }: MainViewProps) {
    return (
        <div className="main-view">
            {activeTab === "files" && <FileBrowser fileTree={fileTree} />}
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


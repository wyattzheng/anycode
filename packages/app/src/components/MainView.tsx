import type { TabId } from "../App";
import { FileBrowser } from "./FileBrowser";
import { ChangesView } from "./ChangesView";
import "./MainView.css";

interface MainViewProps {
    activeTab: TabId;
}

export function MainView({ activeTab }: MainViewProps) {
    return (
        <div className="main-view">
            {activeTab === "files" && <FileBrowser />}
            {activeTab === "changes" && <ChangesView />}

            {/* 动态 Tab：渲染 iframe 访问 agent web 项目路由 */}
            {activeTab !== "files" && activeTab !== "changes" && (
                <iframe
                    className="main-view-iframe"
                    src={activeTab}
                    title="Agent View"
                />
            )}
        </div>
    );
}

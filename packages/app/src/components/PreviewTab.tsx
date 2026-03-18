import { MonitorIcon } from "./Icons";
import "./PreviewTab.css";

interface PreviewTabProps {
    previewPort: number | null;
}

export function PreviewTab({ previewPort }: PreviewTabProps) {
    if (!previewPort) {
        return (
            <div className="preview-tab">
                <div className="preview-empty">
                    <MonitorIcon size={36} />
                    <p>通过对话让 AI 生成界面，结果将展示在这里</p>
                </div>
            </div>
        );
    }

    const src = `${location.protocol}//${location.hostname}:${previewPort}`;

    return (
        <div className="preview-tab">
            <iframe className="preview-iframe" src={src} title="Preview" />
        </div>
    );
}

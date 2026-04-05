import { MonitorIcon } from "./Icons";
import { getServerUrl } from "../server-url";
import "./PreviewTab.css";

interface PreviewTabProps {
    previewPort: number | null;
    previewPath: string | null;
}

export function PreviewTab({ previewPort, previewPath }: PreviewTabProps) {
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

    // Use server URL's hostname if configured, otherwise use current hostname
    const serverUrl = getServerUrl();
    let hostname = location.hostname;
    let protocol = location.protocol;
    if (serverUrl) {
        try {
            const parsed = new URL(serverUrl);
            hostname = parsed.hostname;
            protocol = parsed.protocol;
        } catch { /* use defaults */ }
    }
    const path = previewPath && previewPath.trim() ? previewPath : "/";
    const src = `${protocol}//${hostname}:${previewPort}${path.startsWith("/") ? path : `/${path}`}`;

    return (
        <div className="preview-tab">
            <iframe className="preview-iframe" src={src} title="Preview" />
        </div>
    );
}

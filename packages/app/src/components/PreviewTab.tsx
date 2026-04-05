import { MonitorIcon } from "./Icons";
import { getServerUrl } from "../server-url";
import "./PreviewTab.css";

interface PreviewTabProps {
    previewPort: number | null;
    previewBaseUrl: string | null;
    previewPath: string | null;
}

function joinPreviewUrl(baseUrl: string, previewPath: string) {
    const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const normalizedPath = previewPath.startsWith("/") ? previewPath.slice(1) : previewPath;
    return new URL(normalizedPath || "", normalizedBase).toString();
}

export function PreviewTab({ previewPort, previewBaseUrl, previewPath }: PreviewTabProps) {
    if (!previewPort && !previewBaseUrl) {
        return (
            <div className="preview-tab">
                <div className="preview-empty">
                    <MonitorIcon size={36} />
                    <p>通过对话让 AI 生成界面，结果将展示在这里</p>
                </div>
            </div>
        );
    }

    const path = previewPath && previewPath.trim() ? previewPath : "/";
    let src = "";

    if (previewBaseUrl) {
        src = joinPreviewUrl(previewBaseUrl, path);
    } else {
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
        src = `${protocol}//${hostname}:${previewPort}${path.startsWith("/") ? path : `/${path}`}`;
    }

    return (
        <div className="preview-tab">
            <iframe className="preview-iframe" src={src} title="Preview" />
        </div>
    );
}

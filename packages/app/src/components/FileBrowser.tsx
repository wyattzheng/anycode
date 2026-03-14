import { useState, useRef, useCallback } from "react";
import { FolderOpenIcon, FileDocIcon, ChevronIcon } from "./Icons";
import "./FileBrowser.css";

export function FileBrowser() {
    const [sidebarHeight, setSidebarHeight] = useState(200);
    const [srcExpanded, setSrcExpanded] = useState(true);
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

    const onDragMove = useCallback((clientY: number) => {
        if (!dragRef.current || !containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const bottomY = containerRect.bottom;
        const newHeight = Math.max(80, Math.min(bottomY - clientY, containerRect.height - 80));
        setSidebarHeight(newHeight);
    }, []);

    const onDragEnd = useCallback(() => {
        dragRef.current = null;
    }, []);

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startHeight: sidebarHeight };
        const onMove = (ev: MouseEvent) => onDragMove(ev.clientY);
        const onUp = () => { onDragEnd(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    const handleTouchStart = (e: React.TouchEvent) => {
        const touch = e.touches[0];
        dragRef.current = { startY: touch.clientY, startHeight: sidebarHeight };
        const onMove = (ev: TouchEvent) => { ev.preventDefault(); onDragMove(ev.touches[0].clientY); };
        const onUp = () => { onDragEnd(); window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onUp); };
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("touchend", onUp);
    };

    return (
        <div className="file-browser" ref={containerRef}>
            <div className="file-browser-content">
                <div className="panel-header">main.tsx</div>
                <pre className="file-content">
                    <code>{`// 选择下方文件查看内容`}</code>
                </pre>
            </div>
            <div
                className="resize-handle"
                onMouseDown={handleMouseDown}
                onTouchStart={handleTouchStart}
            >
                <div className="resize-grip" />
            </div>
            <div className="file-browser-sidebar" style={{ height: sidebarHeight }}>
                <div className="file-tree">
                    <div className="file-tree-item folder" onClick={() => setSrcExpanded(!srcExpanded)}>
                        <span className={`chevron ${srcExpanded ? "expanded" : ""}`}><ChevronIcon /></span>
                        <span className="file-icon"><FolderOpenIcon /></span>
                        <span className="file-name">src/</span>
                    </div>
                    {srcExpanded && (
                        <>
                            <div className="file-tree-item file indent">
                                <span className="file-icon"><FileDocIcon /></span>
                                <span className="file-name">main.tsx</span>
                            </div>
                            <div className="file-tree-item file indent">
                                <span className="file-icon"><FileDocIcon /></span>
                                <span className="file-name">App.tsx</span>
                            </div>
                        </>
                    )}
                    <div className="file-tree-item file">
                        <span className="file-icon"><FileDocIcon /></span>
                        <span className="file-name">package.json</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

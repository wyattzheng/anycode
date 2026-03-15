import { useState, useRef, useCallback } from "react";
import type { FileTreeNode } from "../App";
import { FolderOpenIcon, FileDocIcon, ChevronIcon } from "./Icons";
import "./FileBrowser.css";

interface FileBrowserProps {
    fileTree: FileTreeNode[];
}

function TreeItem({ node, depth = 0 }: { node: FileTreeNode; depth?: number }) {
    const [expanded, setExpanded] = useState(depth < 2);

    if (node.type === "dir") {
        return (
            <>
                <div
                    className="file-tree-item folder"
                    style={{ paddingLeft: `${12 + depth * 16}px` }}
                    onClick={() => setExpanded(!expanded)}
                >
                    <span className={`chevron ${expanded ? "expanded" : ""}`}><ChevronIcon /></span>
                    <span className="file-icon"><FolderOpenIcon /></span>
                    <span className="file-name">{node.name}/</span>
                </div>
                {expanded && node.children?.map((child) => (
                    <TreeItem key={child.name} node={child} depth={depth + 1} />
                ))}
            </>
        );
    }

    return (
        <div
            className="file-tree-item file"
            style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
            <span className="file-icon"><FileDocIcon /></span>
            <span className="file-name">{node.name}</span>
        </div>
    );
}

export function FileBrowser({ fileTree }: FileBrowserProps) {
    const [sidebarHeight, setSidebarHeight] = useState(200);
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

    const isEmpty = fileTree.length === 0;

    return (
        <div className="file-browser" ref={containerRef}>
            <div className="file-browser-content">
                <div className="file-empty">
                    <FileDocIcon size={28} />
                    <p>选择文件查看内容</p>
                </div>
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
                    {isEmpty ? (
                        <div className="file-tree-empty">
                            <p>加载中…</p>
                        </div>
                    ) : (
                        fileTree.map((node) => (
                            <TreeItem key={node.name} node={node} />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

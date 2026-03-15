import { useState, useRef, useCallback } from "react";
import type { DirEntry } from "../App";
import { FolderOpenIcon, FileDocIcon, ChevronIcon } from "./Icons";
import "./FileBrowser.css";

interface FileBrowserProps {
    topLevel: DirEntry[];
    requestLs: (path: string) => Promise<DirEntry[]>;
    requestFile: (path: string) => Promise<string | null>;
}

function LazyTreeItem({
    entry,
    parentPath,
    requestLs,
    onFileClick,
    selectedFile,
    depth = 0,
}: {
    entry: DirEntry;
    parentPath: string;
    requestLs: (path: string) => Promise<DirEntry[]>;
    onFileClick: (path: string) => void;
    selectedFile: string | null;
    depth?: number;
}) {
    const [expanded, setExpanded] = useState(false);
    const [children, setChildren] = useState<DirEntry[] | null>(null);
    const [loading, setLoading] = useState(false);

    const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

    const toggle = async () => {
        if (entry.type !== "dir") return;
        if (expanded) {
            setExpanded(false);
            return;
        }
        if (children === null) {
            setLoading(true);
            const entries = await requestLs(fullPath);
            setChildren(entries);
            setLoading(false);
        }
        setExpanded(true);
    };

    if (entry.type === "file") {
        const isSelected = selectedFile === fullPath;
        return (
            <div
                className={`file-tree-item file${isSelected ? " selected" : ""}`}
                style={{ paddingLeft: `${12 + depth * 16}px` }}
                onClick={() => onFileClick(fullPath)}
            >
                <span className="file-icon"><FileDocIcon /></span>
                <span className="file-name">{entry.name}</span>
            </div>
        );
    }

    return (
        <>
            <div
                className="file-tree-item folder"
                style={{ paddingLeft: `${12 + depth * 16}px` }}
                onClick={toggle}
            >
                <span className={`chevron ${expanded ? "expanded" : ""}`}><ChevronIcon /></span>
                <span className="file-icon"><FolderOpenIcon /></span>
                <span className="file-name">{entry.name}/</span>
                {loading && <span className="tree-loading">…</span>}
            </div>
            {expanded && children?.map((child) => (
                <LazyTreeItem
                    key={child.name}
                    entry={child}
                    parentPath={fullPath}
                    requestLs={requestLs}
                    onFileClick={onFileClick}
                    selectedFile={selectedFile}
                    depth={depth + 1}
                />
            ))}
        </>
    );
}

export function FileBrowser({ topLevel, requestLs, requestFile }: FileBrowserProps) {
    const [sidebarHeight, setSidebarHeight] = useState(200);
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [fileContent, setFileContent] = useState<string | null>(null);
    const [fileLoading, setFileLoading] = useState(false);

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

    const handleFileClick = async (filePath: string) => {
        setSelectedFile(filePath);
        setFileContent(null);
        setFileLoading(true);
        const content = await requestFile(filePath);
        setFileContent(content);
        setFileLoading(false);
    };

    const isEmpty = topLevel.length === 0;

    return (
        <div className="file-browser" ref={containerRef}>
            <div className="file-browser-content">
                {selectedFile ? (
                    <>
                        <div className="file-content-header">
                            <FileDocIcon />
                            <span className="file-content-path">{selectedFile}</span>
                        </div>
                        <div className="file-content-body">
                            {fileLoading ? (
                                <div className="file-content-loading">加载中…</div>
                            ) : fileContent !== null ? (
                                <pre className="file-content-code">{fileContent}</pre>
                            ) : (
                                <div className="file-content-error">无法读取文件</div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="file-empty">
                        <FileDocIcon size={28} />
                        <p>选择文件查看内容</p>
                    </div>
                )}
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
                            <FolderOpenIcon size={40} />
                            <p>加载中…</p>
                        </div>
                    ) : (
                        topLevel.map((entry) => (
                            <LazyTreeItem
                                key={entry.name}
                                entry={entry}
                                parentPath=""
                                requestLs={requestLs}
                                onFileClick={handleFileClick}
                                selectedFile={selectedFile}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

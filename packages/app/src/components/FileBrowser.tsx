import { useState, useRef, useCallback } from "react";
import type { DirEntry, FileContext } from "../App";
import { FolderOpenIcon, FileDocIcon, ChevronIcon } from "./Icons";
import { CodeViewer } from "./CodeViewer";
import "./FileBrowser.css";

interface FileBrowserProps {
    topLevel: DirEntry[];
    requestLs: (path: string) => Promise<DirEntry[]>;
    requestFile: (path: string) => Promise<string | null>;
    onFileContext?: (ctx: FileContext | null) => void;
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
                style={{ paddingLeft: `${12 + depth * 16 + 18}px` }}
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

export function FileBrowser({ topLevel, requestLs, requestFile, onFileContext }: FileBrowserProps) {
    const [sidebarHeight, setSidebarHeight] = useState(120);
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [fileContent, setFileContent] = useState<string | null>(null);
    const [fileLoading, setFileLoading] = useState(false);

    const onDragMove = useCallback((clientY: number) => {
        if (!dragRef.current || !containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const topY = containerRect.top;
        const newHeight = Math.max(60, Math.min(clientY - topY, containerRect.height - 60));
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
        onFileContext?.(null); // clear selection on file switch
        const content = await requestFile(filePath);
        setFileContent(content);
        setFileLoading(false);
    };

    const handleSelectionChange = useCallback((lines: number[]) => {
        if (!selectedFile) return;
        if (lines.length === 0) {
            onFileContext?.(null);
        } else {
            onFileContext?.({ file: selectedFile, lines });
        }
    }, [selectedFile, onFileContext]);

    const [wordWrap, setWordWrap] = useState(true);
    const [menuOpen, setMenuOpen] = useState(false);

    const isEmpty = topLevel.length === 0;

    return (
        <div className="file-browser" ref={containerRef}>
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
                <div className="fb-resize-border" onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} />
            </div>
            <div className="file-browser-content">
                {selectedFile ? (
                    <>
                        <div className="file-content-header">
                            <FileDocIcon />
                            <span className="file-content-path">{selectedFile}</span>
                            <div className="file-content-menu">
                                <button className="file-content-menu-btn" onClick={() => setMenuOpen(!menuOpen)}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                                        <circle cx="12" cy="4" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="20" r="1.5" fill="currentColor" />
                                    </svg>
                                </button>
                                {menuOpen && (
                                    <div className="file-content-dropdown">
                                        <div className="file-content-dropdown-item" onClick={() => { setWordWrap(!wordWrap); setMenuOpen(false); }}>
                                            <input type="checkbox" checked={wordWrap} readOnly />
                                            <span>自动换行</span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="file-content-body">
                            {fileLoading ? (
                                <div className="file-content-loading">加载中…</div>
                            ) : fileContent !== null ? (
                                <CodeViewer code={fileContent} filePath={selectedFile} onSelectionChange={handleSelectionChange} wordWrap={wordWrap} />
                            ) : (
                                <div className="file-content-error">无法读取文件</div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="file-empty">
                        <FileDocIcon size={36} />
                        <p>选择文件查看内容</p>
                    </div>
                )}
            </div>
        </div>
    );
}

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import type { DirEntry, FileContext } from "../App";
import { ChevronIcon, FileDocIcon } from "./Icons";
import { FileIcon } from "./FileIcon";
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
                style={{ paddingLeft: `${12 + depth * 16 + 13}px` }}
                onClick={() => onFileClick(fullPath)}
            >
                <span className="file-icon"><FileIcon filename={entry.name} size={14} /></span>
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
                <span className="file-icon"><FileIcon filename={entry.name} isDir size={14} /></span>
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

const HORIZONTAL_BREAKPOINT = 360;

export function FileBrowser({ topLevel, requestLs, requestFile, onFileContext }: FileBrowserProps) {
    const [sidebarSize, setSidebarSize] = useState<number | null>(() => {
        const saved = localStorage.getItem('fb-sidebar-height');
        return saved ? Number(saved) : null;
    });
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startPos: number; startSize: number } | null>(null);
    const [horizontal, setHorizontal] = useState(true);

    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        // Synchronous initial measurement (skip if not laid out yet)
        const initW = el.getBoundingClientRect().width;
        if (initW > 0) setHorizontal(initW >= HORIZONTAL_BREAKPOINT);
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width ?? 0;
            if (w > 0) flushSync(() => setHorizontal(w >= HORIZONTAL_BREAKPOINT));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [fileContent, setFileContent] = useState<string | null>(null);
    const [fileLoading, setFileLoading] = useState(false);
    const resizeBorderRef = useRef<HTMLDivElement>(null);

    const onDragMove = useCallback((clientPos: number) => {
        if (!dragRef.current || !containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const delta = clientPos - dragRef.current.startPos;
        const maxSize = horizontal ? containerRect.width - 60 : containerRect.height - 60;
        const newSize = Math.max(60, Math.min(dragRef.current.startSize + delta, maxSize));
        setSidebarSize(newSize);
        localStorage.setItem('fb-sidebar-height', String(newSize));
    }, [horizontal]);

    const onDragEnd = useCallback(() => {
        dragRef.current = null;
        resizeBorderRef.current?.classList.remove('dragging');
    }, []);

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        resizeBorderRef.current?.classList.add('dragging');
        const defaultSize = containerRef.current
            ? (horizontal ? containerRef.current.getBoundingClientRect().width : containerRef.current.getBoundingClientRect().height) / 2
            : 200;
        const currentSize = sidebarSize ?? defaultSize;
        const pos = horizontal ? e.clientX : e.clientY;
        dragRef.current = { startPos: pos, startSize: currentSize };
        const onMove = (ev: MouseEvent) => onDragMove(horizontal ? ev.clientX : ev.clientY);
        const onUp = () => { onDragEnd(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    const handleTouchStart = (e: React.TouchEvent) => {
        const touch = e.touches[0];
        resizeBorderRef.current?.classList.add('dragging');
        const defaultSize = containerRef.current
            ? (horizontal ? containerRef.current.getBoundingClientRect().width : containerRef.current.getBoundingClientRect().height) / 2
            : 200;
        const currentSize = sidebarSize ?? defaultSize;
        const pos = horizontal ? touch.clientX : touch.clientY;
        dragRef.current = { startPos: pos, startSize: currentSize };
        const onMove = (ev: TouchEvent) => { ev.preventDefault(); onDragMove(horizontal ? ev.touches[0].clientX : ev.touches[0].clientY); };
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

    const sidebarStyle = horizontal
        ? (sidebarSize != null ? { width: sidebarSize, flex: 'none' } : { flex: '0 0 35%' })
        : (sidebarSize != null ? { height: sidebarSize, flex: 'none' } : { flex: 1 });

    return (
        <div className={`file-browser${horizontal ? ' file-browser--horizontal' : ''}`} ref={containerRef}>
            <div className="file-browser-sidebar" style={sidebarStyle as any}>
                <div className="file-tree">
                    {isEmpty ? (
                        <div className="file-tree-empty">
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
            <div className="fb-resize-border" ref={resizeBorderRef} onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} />
            <div className="file-browser-content">
                {selectedFile ? (
                    <>
                        <div className="file-content-header">
                            <FileIcon filename={selectedFile.split('/').pop() || selectedFile} />
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
                        <p>选择文件查看内容</p>
                    </div>
                )}
            </div>
        </div>
    );
}

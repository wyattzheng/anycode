import { useState, useRef, useCallback, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { useResizePanel } from "../hooks/useResizePanel";
import type { FileContext } from "../App";
import { ChevronIcon } from "./Icons";
import { FileIcon } from "./FileIcon";
import { CodeViewer } from "./CodeViewer";
import { useFileTree, useFileTreeSnapshot } from "../fileTree";
import "./FileBrowser.css";

interface FileBrowserProps {
    requestFile: (path: string) => Promise<string | null>;
    onFileContext?: (ctx: FileContext | null) => void;
}

function LazyTreeItem({
    name,
    type,
    fullPath,
    onFileClick,
    selectedFile,
    depth = 0,
}: {
    name: string;
    type: "file" | "dir";
    fullPath: string;
    onFileClick: (path: string) => void;
    selectedFile: string | null;
    depth?: number;
}) {
    const model = useFileTree();
    useFileTreeSnapshot(model);

    if (type === "file") {
        const isSelected = selectedFile === fullPath;
        return (
            <div
                className={`file-tree-item file${isSelected ? " selected" : ""}`}
                style={{ paddingLeft: `${12 + depth * 16 + 13}px` }}
                onClick={() => onFileClick(fullPath)}
            >
                <span className="file-icon"><FileIcon filename={name} size={14} /></span>
                <span className="file-name">{name}</span>
            </div>
        );
    }

    const expanded = model.isExpanded(fullPath);
    const loading = model.isLoading(fullPath);
    const children = model.getChildren(fullPath);

    return (
        <>
            <div
                className="file-tree-item folder"
                style={{ paddingLeft: `${12 + depth * 16}px` }}
                onClick={() => model.toggle(fullPath)}
            >
                <span className={`chevron ${expanded ? "expanded" : ""}`}><ChevronIcon /></span>
                <span className="file-icon"><FileIcon filename={name} isDir size={14} /></span>
                <span className="file-name">{name}/</span>
                {loading && <span className="tree-loading">…</span>}
            </div>
            {expanded && children?.map((child) => (
                <LazyTreeItem
                    key={child.name}
                    name={child.name}
                    type={child.type}
                    fullPath={fullPath ? `${fullPath}/${child.name}` : child.name}
                    onFileClick={onFileClick}
                    selectedFile={selectedFile}
                    depth={depth + 1}
                />
            ))}
        </>
    );
}

const HORIZONTAL_BREAKPOINT = 360;

export function FileBrowser({ requestFile, onFileContext }: FileBrowserProps) {
    const model = useFileTree();
    useFileTreeSnapshot(model);

    const topLevel = model.topLevel;

    const [sidebarSize, setSidebarSize] = useState<number | null>(() => {
        const saved = localStorage.getItem('fb-sidebar-height');
        return saved ? Number(saved) : null;
    });
    const containerRef = useRef<HTMLDivElement>(null);
    const [horizontal, setHorizontal] = useState(true);

    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
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
    const sidebarRef = useRef<HTMLDivElement>(null);

    const handleResize = useCallback((size: number) => {
        setSidebarSize(size);
        localStorage.setItem('fb-sidebar-height', String(size));
    }, []);

    const { borderRef: resizeBorderRef, handleMouseDown, handleTouchStart } = useResizePanel({
        horizontal,
        panelRef: sidebarRef,
        containerRef,
        onResize: handleResize,
    });

    const handleFileClick = async (filePath: string) => {
        setSelectedFile(filePath);
        setFileContent(null);
        setFileLoading(true);
        onFileContext?.(null);
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
        ? (sidebarSize != null ? { width: sidebarSize, flex: 'none' } : { flex: '0 0 30%', maxWidth: 280 })
        : (sidebarSize != null ? { height: sidebarSize, flex: 'none' } : { flex: 1 });

    return (
        <div className={`file-browser${horizontal ? ' file-browser--horizontal' : ''}`} ref={containerRef}>
            <div className="file-browser-sidebar" ref={sidebarRef} style={sidebarStyle as any}>
                <div className="file-tree">
                    {isEmpty ? (
                        <div className="file-tree-empty">
                            <p>加载中…</p>
                        </div>
                    ) : (
                        topLevel.map((entry) => (
                            <LazyTreeItem
                                key={entry.name}
                                name={entry.name}
                                type={entry.type}
                                fullPath={entry.name}
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

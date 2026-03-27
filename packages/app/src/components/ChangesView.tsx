import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import type { GitChange, FileContext } from "../App";
import { DiffIcon } from "./Icons";
import { FileIcon } from "./FileIcon";
import { CodeViewer } from "./CodeViewer";
import "./ChangesView.css";

interface ChangesViewProps {
    changes: GitChange[];
    requestFile: (path: string) => Promise<string | null>;
    requestDiff: (path: string) => Promise<{ added: number[]; removed: number[] }>;
    onFileContext?: (ctx: FileContext | null) => void;
}

function statusClass(status: string): string {
    switch (status) {
        case "A": case "?": return "added";
        case "M": return "modified";
        case "D": return "deleted";
        case "R": return "renamed";
        default: return "modified";
    }
}

function statusLabel(status: string): string {
    switch (status) {
        case "?": return "U";
        default: return status;
    }
}

const HORIZONTAL_BREAKPOINT = 360;

export function ChangesView({ changes, requestFile, requestDiff, onFileContext }: ChangesViewProps) {
    const [listSize, setListSize] = useState<number | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startPos: number; startSize: number } | null>(null);
    const [horizontal, setHorizontal] = useState(true);

    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        // Synchronous initial measurement
        setHorizontal(el.getBoundingClientRect().width >= HORIZONTAL_BREAKPOINT);
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width ?? 0;
            setHorizontal(w >= HORIZONTAL_BREAKPOINT);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [fileContent, setFileContent] = useState<string | null>(null);
    const [fileLoading, setFileLoading] = useState(false);
    const [addedLines, setAddedLines] = useState<Set<number>>(new Set());
    const [scrollToLine, setScrollToLine] = useState<number | null>(null);
    const contentBodyRef = useRef<HTMLDivElement>(null);

    // React to changes list updates: close if file gone, refresh if still present
    useEffect(() => {
        if (!selectedFile) return;
        if (!changes.some((c) => c.file === selectedFile)) {
            setSelectedFile(null);
            setFileContent(null);
            setAddedLines(new Set());
            onFileContext?.(null);
            return;
        }
        // File still in changes — silently refresh content + diff
        let cancelled = false;
        (async () => {
            const [content, diff] = await Promise.all([
                requestFile(selectedFile),
                requestDiff(selectedFile),
            ]);
            if (cancelled) return;
            setFileContent(content);
            setAddedLines(new Set(diff.added));
        })();
        return () => { cancelled = true; };
    }, [changes, selectedFile, onFileContext, requestFile, requestDiff]);

    const onDragMove = useCallback((clientPos: number) => {
        if (!dragRef.current || !containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const delta = clientPos - dragRef.current.startPos;
        const maxSize = horizontal ? containerRect.width - 60 : containerRect.height - 60;
        const newSize = Math.max(60, Math.min(dragRef.current.startSize + delta, maxSize));
        setListSize(newSize);
    }, [horizontal]);

    const onDragEnd = useCallback(() => {
        dragRef.current = null;
    }, []);

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        const defaultSize = containerRef.current
            ? (horizontal ? containerRef.current.getBoundingClientRect().width : containerRef.current.getBoundingClientRect().height) / 2
            : 200;
        const currentSize = listSize ?? defaultSize;
        const pos = horizontal ? e.clientX : e.clientY;
        dragRef.current = { startPos: pos, startSize: currentSize };
        const onMove = (ev: MouseEvent) => onDragMove(horizontal ? ev.clientX : ev.clientY);
        const onUp = () => { onDragEnd(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    const handleTouchStart = (e: React.TouchEvent) => {
        const touch = e.touches[0];
        const defaultSize = containerRef.current
            ? (horizontal ? containerRef.current.getBoundingClientRect().width : containerRef.current.getBoundingClientRect().height) / 2
            : 200;
        const currentSize = listSize ?? defaultSize;
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
        setAddedLines(new Set());
        setScrollToLine(null);
        setFileLoading(true);
        onFileContext?.(null); // clear selection on file switch
        // Reset scroll position immediately so the old file's position doesn't linger
        if (contentBodyRef.current) {
            contentBodyRef.current.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
        }

        const [content, diff] = await Promise.all([
            requestFile(filePath),
            requestDiff(filePath),
        ]);

        setFileContent(content);
        setAddedLines(new Set(diff.added));
        setFileLoading(false);

        // Scroll to first changed line
        const allChanged = [...diff.added].sort((a, b) => a - b);
        if (allChanged.length > 0) {
            setScrollToLine(allChanged[0]);
        }
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

    const isEmpty = changes.length === 0;

    const listStyle = horizontal
        ? (listSize != null ? { width: listSize, flex: 'none' } : { flex: 1 })
        : (listSize != null ? { height: listSize, flex: 'none' } : { flex: 1 });

    return (
        <div className={`changes-view${horizontal ? ' changes-view--horizontal' : ''}`} ref={containerRef}>
            <div className="changes-list" style={listStyle as any}>
                <div className="change-items">
                    {isEmpty ? (
                        <div className="changes-empty">
                            <p>暂无变更</p>
                        </div>
                    ) : (
                        changes.map((change) => (
                            <div
                                key={change.file}
                                className={`change-item ${statusClass(change.status)}${selectedFile === change.file ? " selected" : ""}`}
                                onClick={() => handleFileClick(change.file)}
                            >
                                <FileIcon filename={change.file.split('/').pop() || change.file} />
                                <span className="change-path">{change.file}</span>
                                <span className="change-badge">{statusLabel(change.status)}</span>
                            </div>
                        ))
                    )}
                </div>
            </div>
            <div className="cv-resize-border" onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} />
            <div className="changes-diff">
                {selectedFile ? (
                    <>
                        <div className="file-content-header" onMouseDown={handleMouseDown} onTouchStart={handleTouchStart}>
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
                        <div className="file-content-body" ref={contentBodyRef}>
                            {fileLoading ? (
                                <div className="file-content-loading">加载中…</div>
                            ) : fileContent !== null ? (
                                <CodeViewer
                                    code={fileContent}
                                    filePath={selectedFile}
                                    addedLines={addedLines}
                                    onSelectionChange={handleSelectionChange}
                                    scrollToLine={scrollToLine}
                                    wordWrap={wordWrap}
                                />
                            ) : (
                                <div className="file-content-error">无法读取文件</div>
                            )}
                        </div>
                    </>
                ) : null}
            </div>
        </div>
    );
}

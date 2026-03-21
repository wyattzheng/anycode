import { useState, useRef, useCallback, useEffect } from "react";
import type { GitChange, FileContext } from "../App";
import { FileDocIcon, DiffIcon } from "./Icons";
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

export function ChangesView({ changes, requestFile, requestDiff, onFileContext }: ChangesViewProps) {
    const [listHeight, setListHeight] = useState(120);
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

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

    const onDragMove = useCallback((clientY: number) => {
        if (!dragRef.current || !containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const delta = clientY - dragRef.current.startY;
        const newHeight = Math.max(60, Math.min(dragRef.current.startHeight + delta, containerRect.height - 60));
        setListHeight(newHeight);
    }, []);

    const onDragEnd = useCallback(() => {
        dragRef.current = null;
    }, []);

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startHeight: listHeight };
        const onMove = (ev: MouseEvent) => onDragMove(ev.clientY);
        const onUp = () => { onDragEnd(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    const handleTouchStart = (e: React.TouchEvent) => {
        const touch = e.touches[0];
        dragRef.current = { startY: touch.clientY, startHeight: listHeight };
        const onMove = (ev: TouchEvent) => { ev.preventDefault(); onDragMove(ev.touches[0].clientY); };
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

    return (
        <div className="changes-view" ref={containerRef}>
            <div className="changes-list" style={{ height: listHeight }}>
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
                                <FileDocIcon />
                                <span>{change.file}</span>
                                <span className="change-badge">{statusLabel(change.status)}</span>
                            </div>
                        ))
                    )}
                </div>
                <div className="cv-resize-border" onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} />
            </div>
            <div className="changes-diff">
                {selectedFile ? (
                    <>
                        <div className="file-content-header" onMouseDown={handleMouseDown} onTouchStart={handleTouchStart}>
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

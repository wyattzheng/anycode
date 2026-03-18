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
    const [listHeight, setListHeight] = useState(200);
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [fileContent, setFileContent] = useState<string | null>(null);
    const [fileLoading, setFileLoading] = useState(false);
    const [addedLines, setAddedLines] = useState<Set<number>>(new Set());
    const [removedLines, setRemovedLines] = useState<Set<number>>(new Set());
    const [scrollToLine, setScrollToLine] = useState<number | null>(null);
    const contentBodyRef = useRef<HTMLDivElement>(null);

    // Scroll to first changed line after content renders
    useEffect(() => {
        if (scrollToLine === null || !contentBodyRef.current) return;
        // Wait a tick for Shiki to render
        const timer = setTimeout(() => {
            const el = contentBodyRef.current?.querySelector(`[data-line="${scrollToLine}"]`) as HTMLElement | null;
            if (el && contentBodyRef.current) {
                // Scroll so the changed line sits ~3 lines from the top
                const container = contentBodyRef.current;
                const offset = el.offsetTop - container.offsetTop - 3 * 19.2; // ~3 lines padding
                container.scrollTop = Math.max(0, offset);
            }
            setScrollToLine(null);
        }, 100);
        return () => clearTimeout(timer);
    }, [scrollToLine, fileContent]);

    const onDragMove = useCallback((clientY: number) => {
        if (!dragRef.current || !containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const bottomY = containerRect.bottom;
        const newHeight = Math.max(80, Math.min(bottomY - clientY, containerRect.height - 80));
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
        setRemovedLines(new Set());
        setFileLoading(true);
        onFileContext?.(null); // clear selection on file switch

        const [content, diff] = await Promise.all([
            requestFile(filePath),
            requestDiff(filePath),
        ]);

        setFileContent(content);
        setAddedLines(new Set(diff.added));
        setRemovedLines(new Set(diff.removed));
        setFileLoading(false);

        // Scroll to first changed line
        const allChanged = [...diff.added, ...diff.removed].sort((a, b) => a - b);
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

    const isEmpty = changes.length === 0;

    return (
        <div className="changes-view" ref={containerRef}>
            <div className="changes-diff">
                {selectedFile ? (
                    <>
                        <div className="file-content-header">
                            <FileDocIcon />
                            <span className="file-content-path">{selectedFile}</span>
                        </div>
                        <div className="file-content-body" ref={contentBodyRef}>
                            {fileLoading ? (
                                <div className="file-content-loading">加载中…</div>
                            ) : fileContent !== null ? (
                                <CodeViewer
                                    code={fileContent}
                                    filePath={selectedFile}
                                    addedLines={addedLines}
                                    removedLines={removedLines}
                                    onSelectionChange={handleSelectionChange}
                                />
                            ) : (
                                <div className="file-content-error">无法读取文件</div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="diff-empty">
                        <DiffIcon size={28} />
                        <p>{isEmpty ? "没有未提交的变更" : "选择文件查看内容"}</p>
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
            <div className="changes-list" style={{ height: listHeight }}>
                <div className="change-items">
                    {isEmpty ? (
                        <div className="changes-empty">
                            <DiffIcon size={40} />
                            <p>工作区干净</p>
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
            </div>
        </div>
    );
}

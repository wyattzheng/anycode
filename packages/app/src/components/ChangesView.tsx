import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import type { GitChange, FileContext } from "../App";
import { FileIcon } from "./FileIcon";
import { FileContentPanel } from "./FileContentPanel";
import { useResizePanel } from "../hooks/useResizePanel";
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

    const listRef = useRef<HTMLDivElement>(null);

    const { borderRef: resizeBorderRef, handleMouseDown, handleTouchStart } = useResizePanel({
        horizontal,
        panelRef: listRef,
        containerRef,
        onResize: setListSize,
    });

    const handleFileClick = async (filePath: string) => {
        setSelectedFile(filePath);
        setFileContent(null);
        setAddedLines(new Set());
        setScrollToLine(null);
        setFileLoading(true);
        onFileContext?.(null);
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

        const allChanged = [...diff.added].sort((a, b) => a - b);
        if (allChanged.length > 0) {
            setScrollToLine(allChanged[0]);
        }
    };

    const isEmpty = changes.length === 0;

    const listStyle = horizontal
        ? (listSize != null ? { width: listSize, flex: 'none' } : { flex: '0 0 30%', maxWidth: 280 })
        : (listSize != null ? { height: listSize, flex: 'none' } : { flex: 1 });

    return (
        <div className={`changes-view${horizontal ? ' changes-view--horizontal' : ''}`} ref={containerRef}>
            <div className="changes-list" ref={listRef} style={listStyle as any}>
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
                                <span className="change-path">{change.file.split('/').pop() || change.file}</span>
                                <span className="change-badge">{statusLabel(change.status)}</span>
                            </div>
                        ))
                    )}
                </div>
            </div>
            <div className="cv-resize-border" ref={resizeBorderRef} onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} />
            <div className="changes-diff">
                <FileContentPanel
                    selectedFile={selectedFile}
                    fileContent={fileContent}
                    fileLoading={fileLoading}
                    addedLines={addedLines}
                    scrollToLine={scrollToLine}
                    onFileContext={onFileContext}
                    contentBodyRef={contentBodyRef}
                />
            </div>
        </div>
    );
}

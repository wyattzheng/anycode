import { useEffect, useLayoutEffect, useState, useMemo, useRef, useCallback, memo } from "react";
import { createHighlighter, type Highlighter } from "shiki";
import "./CodeViewer.css";

// Shared singleton highlighter — lazily created, reused across all instances
let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

function getHighlighter(): Promise<Highlighter> {
    if (!highlighterPromise) {
        highlighterPromise = createHighlighter({
            themes: ["github-dark"],
            langs: ["text"],
        });
    }
    return highlighterPromise;
}

/** Map file extension to shiki language id */
function extToLang(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
        ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
        json: "json", md: "markdown", css: "css", scss: "scss",
        html: "html", xml: "xml", svg: "xml",
        py: "python", rb: "ruby", rs: "rust", go: "go",
        java: "java", kt: "kotlin", swift: "swift",
        c: "c", cpp: "cpp", h: "c", hpp: "cpp",
        sh: "bash", bash: "bash", zsh: "bash",
        sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml",
        dockerfile: "dockerfile", makefile: "makefile",
        vue: "vue", svelte: "svelte",
        graphql: "graphql", gql: "graphql",
        lua: "lua", php: "php", r: "r",
    };
    const name = filePath.split("/").pop()?.toLowerCase() ?? "";
    if (name === "dockerfile") return "dockerfile";
    if (name === "makefile" || name === "gnumakefile") return "makefile";
    return map[ext] || "text";
}

/**
 * Inject line numbers and diff markers directly into Shiki's HTML output.
 */
function injectLineInfo(html: string, addedLines?: Set<number>, removedLines?: Set<number>): string {
    let lineNum = 0;
    return html.replace(/<span class="line"/g, () => {
        lineNum++;
        const classes = ["line"];
        if (addedLines?.has(lineNum)) classes.push("diff-added");
        if (removedLines?.has(lineNum)) classes.push("diff-removed");
        return `<span class="${classes.join(" ")}" data-line="${lineNum}"`;
    });
}

/** Find the line number from a DOM event target */
function getLineFromEvent(container: HTMLElement, e: { clientY: number }): number | null {
    const lines = container.querySelectorAll("[data-line]");
    for (let i = 0; i < lines.length; i++) {
        const rect = (lines[i] as HTMLElement).getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
            return parseInt((lines[i] as HTMLElement).getAttribute("data-line")!, 10);
        }
    }
    // If above or below all lines, snap to first/last
    if (lines.length > 0) {
        const first = (lines[0] as HTMLElement).getBoundingClientRect();
        if (e.clientY < first.top) return 1;
        const last = (lines[lines.length - 1] as HTMLElement);
        return parseInt(last.getAttribute("data-line")!, 10);
    }
    return null;
}

export interface CodeViewerProps {
    code: string;
    filePath: string;
    /** Set of line numbers (1-indexed) to highlight as added */
    addedLines?: Set<number>;
    /** Set of line numbers (1-indexed) to highlight as removed */
    removedLines?: Set<number>;
    /** Called when user selects lines. Empty array = cleared. */
    onSelectionChange?: (lines: number[]) => void;
    /** Scroll to this line once Shiki rendering completes (one-shot) */
    scrollToLine?: number | null;
}

export const CodeViewer = memo(function CodeViewer({ code, filePath, addedLines, removedLines, onSelectionChange, scrollToLine }: CodeViewerProps) {
    const [rawHtml, setRawHtml] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set());
    const containerRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);

    // Stable ref for onSelectionChange (used in native listeners)
    const onSelectionChangeRef = useRef(onSelectionChange);
    onSelectionChangeRef.current = onSelectionChange;

    // Mouse drag state (desktop)
    const mouseDragRef = useRef<{ anchor: number; dragged: boolean; startX: number; startY: number } | null>(null);

    // Touch state
    const touchActiveRef = useRef(false);
    const anchorRef = useRef<number | null>(null);
    const handleDraggingRef = useRef(false);
    const handleElRef = useRef<HTMLDivElement>(null);
    const dragRangeRef = useRef<{ start: number; end: number } | null>(null);
    const handleAtTopRef = useRef(false);

    // Shiki highlight
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const hl = await getHighlighter();
                const lang = extToLang(filePath);
                if (lang !== "text" && !loadedLangs.has(lang)) {
                    try { await hl.loadLanguage(lang as any); loadedLangs.add(lang); } catch { /* text fallback */ }
                }
                const effectiveLang = loadedLangs.has(lang) ? lang : "text";
                const result = hl.codeToHtml(code, { lang: effectiveLang, theme: "github-dark" });
                if (!cancelled) setRawHtml(result);
            } catch {
                if (!cancelled) setError(true);
            }
        })();
        return () => { cancelled = true; };
    }, [code, filePath]);

    // Clear selection when file changes
    useEffect(() => {
        setSelectedLines(new Set());
        anchorRef.current = null;
        onSelectionChange?.([]);
    }, [filePath, code]);

    // Scroll to target line once Shiki rendering is done (before paint).
    // The wrapper starts visibility:hidden when a scroll is pending so the
    // first painted frame already shows the content at the correct position.
    const scrolledForRef = useRef<string | null>(null);
    useLayoutEffect(() => {
        if (scrollToLine == null || !rawHtml || !containerRef.current) return;
        // One-shot: don't re-scroll for same file+line combo
        const key = `${filePath}:${scrollToLine}`;
        if (scrolledForRef.current === key) return;
        scrolledForRef.current = key;

        const lineEl = containerRef.current.querySelector(`[data-line="${scrollToLine}"]`) as HTMLElement;
        if (!lineEl) { if (wrapperRef.current) wrapperRef.current.style.visibility = ''; return; }
        const scrollParent = containerRef.current.closest('.file-content-body') as HTMLElement;
        if (!scrollParent) { if (wrapperRef.current) wrapperRef.current.style.visibility = ''; return; }
        // Position ~3 lines from the top
        const offset = lineEl.offsetTop - scrollParent.offsetTop - 3 * 19.2;
        scrollParent.scrollTo({ top: Math.max(0, offset), behavior: 'instant' as ScrollBehavior });
        // Reveal now that scroll is in position (still before paint)
        if (wrapperRef.current) wrapperRef.current.style.visibility = '';
    }, [rawHtml, scrollToLine, filePath]);

    // Derive final HTML
    const finalHtml = useMemo(() => {
        if (!rawHtml) return null;
        return injectLineInfo(rawHtml, addedLines, removedLines);
    }, [rawHtml, addedLines, removedLines]);

    // Selection range derived from state
    const selectionRange = useMemo(() => {
        if (selectedLines.size === 0) return null;
        const sorted = Array.from(selectedLines).sort((a, b) => a - b);
        return { start: sorted[0], end: sorted[sorted.length - 1] };
    }, [selectedLines]);

    // ── Helper: update selection to a range ──
    const setRange = useCallback((start: number, end: number) => {
        const set = new Set<number>();
        for (let i = start; i <= end; i++) set.add(i);
        setSelectedLines(set);
        onSelectionChangeRef.current?.(Array.from(set).sort((a, b) => a - b));
    }, []);

    const clearSelection = useCallback(() => {
        setSelectedLines(new Set());
        anchorRef.current = null;
        handleAtTopRef.current = false;
        onSelectionChangeRef.current?.([]);
    }, []);

    // ── Mouse: drag to select, click to clear (desktop) ──
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (touchActiveRef.current) return;
        if (!containerRef.current) return;
        const line = getLineFromEvent(containerRef.current, e);
        if (line === null) return;
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        mouseDragRef.current = { anchor: line, dragged: false, startX: e.clientX, startY: e.clientY };
    }, []);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!mouseDragRef.current || !containerRef.current) return;
        if (!mouseDragRef.current.dragged) {
            const dx = e.clientX - mouseDragRef.current.startX;
            const dy = e.clientY - mouseDragRef.current.startY;
            if (dx * dx + dy * dy < 25) return;
            mouseDragRef.current.dragged = true;
        }
        const line = getLineFromEvent(containerRef.current, e);
        if (line === null) return;
        const start = Math.min(mouseDragRef.current.anchor, line);
        const end = Math.max(mouseDragRef.current.anchor, line);
        const set = new Set<number>();
        for (let i = start; i <= end; i++) set.add(i);
        setSelectedLines(set);
    }, []);

    const handleMouseUp = useCallback(() => {
        if (!mouseDragRef.current) return;
        const wasDrag = mouseDragRef.current.dragged;
        mouseDragRef.current = null;
        if (wasDrag) {
            setSelectedLines(prev => {
                const sorted = Array.from(prev).sort((a, b) => a - b);
                onSelectionChangeRef.current?.(sorted);
                return prev;
            });
        } else {
            clearSelection();
        }
    }, [clearSelection]);

    // Global mouseup to catch drag release outside container
    useEffect(() => {
        const onUp = () => {
            if (!mouseDragRef.current) return;
            const wasDrag = mouseDragRef.current.dragged;
            mouseDragRef.current = null;
            if (wasDrag) {
                setSelectedLines(prev => {
                    const sorted = Array.from(prev).sort((a, b) => a - b);
                    onSelectionChangeRef.current?.(sorted);
                    return prev;
                });
            } else {
                clearSelection();
            }
        };
        window.addEventListener("mouseup", onUp);
        return () => window.removeEventListener("mouseup", onUp);
    }, [clearSelection]);

    // ── Touch: long-press 300ms to select line ──
    // No touch-action:none on the code viewer — native scrolling works.
    // Only the drag handle has touch-action:none.
    // Long-press (hold still 300ms) selects a line.
    // Second long-press extends range from anchor.
    // Quick tap clears selection.
    useEffect(() => {
        if (!containerRef.current) return;
        const el = containerRef.current;

        const LONG_PRESS_MS = 300;
        const MOVE_THRESHOLD = 10;

        let timer: ReturnType<typeof setTimeout> | null = null;
        let startX = 0;
        let startY = 0;
        let activePointerId = -1;
        let longPressCompleted = false;

        const onPointerDown = (e: PointerEvent) => {
            if (e.pointerType === 'mouse') return;
            if (!el.contains(e.target as Node)) return;
            if (handleDraggingRef.current) return;

            activePointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            longPressCompleted = false;
            touchActiveRef.current = true;

            timer = setTimeout(() => {
                timer = null;
                longPressCompleted = true;
                const line = getLineFromEvent(el, { clientY: startY });
                if (line === null) return;

                // Always start fresh: set anchor, select single line
                anchorRef.current = line;
                setRange(line, line);
                navigator.vibrate?.(50);
            }, LONG_PRESS_MS);
        };

        const onPointerMove = (e: PointerEvent) => {
            if (e.pointerId !== activePointerId || !timer) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
                clearTimeout(timer);
                timer = null;
            }
        };

        const onPointerUp = (e: PointerEvent) => {
            if (e.pointerId !== activePointerId) return;
            activePointerId = -1;
            if (timer) {
                // Quick tap — clear selection
                clearTimeout(timer);
                timer = null;
                clearSelection();
            }
            // If longPressCompleted, selection was already set
            setTimeout(() => { touchActiveRef.current = false; }, 400);
        };

        const onPointerCancel = (e: PointerEvent) => {
            if (e.pointerId !== activePointerId) return;
            activePointerId = -1;
            if (timer) { clearTimeout(timer); timer = null; }
            setTimeout(() => { touchActiveRef.current = false; }, 400);
        };

        const onContextMenu = (e: Event) => {
            if (el.contains(e.target as Node)) e.preventDefault();
        };

        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerup", onPointerUp);
        document.addEventListener("pointercancel", onPointerCancel);
        document.addEventListener("contextmenu", onContextMenu);

        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("pointermove", onPointerMove);
            document.removeEventListener("pointerup", onPointerUp);
            document.removeEventListener("pointercancel", onPointerCancel);
            document.removeEventListener("contextmenu", onContextMenu);
            if (timer) clearTimeout(timer);
        };
    }, [rawHtml, setRange, clearSelection]);

    // ── Handle drag: direct DOM manipulation during drag, React sync on release ──
    const onHandlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        handleDraggingRef.current = true;
        dragRangeRef.current = null;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }, []);

    const onHandlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!handleDraggingRef.current || !containerRef.current || anchorRef.current === null) return;
        const line = getLineFromEvent(containerRef.current, e);
        if (line === null) return;
        const start = Math.min(anchorRef.current, line);
        const end = Math.max(anchorRef.current, line);
        const atTop = line < anchorRef.current;
        dragRangeRef.current = { start, end };
        handleAtTopRef.current = atTop;

        // Direct DOM: highlight lines (no React re-render)
        const lines = containerRef.current.querySelectorAll("[data-line]");
        for (let i = 0; i < lines.length; i++) {
            const num = parseInt((lines[i] as HTMLElement).getAttribute("data-line")!, 10);
            if (num >= start && num <= end) {
                lines[i].classList.add("line-selected");
            } else {
                lines[i].classList.remove("line-selected");
            }
        }

        // Direct DOM: reposition handle at the dragged end
        if (handleElRef.current && wrapperRef.current) {
            const edgeLine = atTop ? start : end;
            const edgeEl = containerRef.current.querySelector(`[data-line="${edgeLine}"]`) as HTMLElement;
            if (edgeEl) {
                const wrapperRect = wrapperRef.current.getBoundingClientRect();
                const lineRect = edgeEl.getBoundingClientRect();
                if (atTop) {
                    handleElRef.current.style.top = `${lineRect.top - wrapperRect.top - handleElRef.current.offsetHeight}px`;
                    handleElRef.current.classList.add('cv-drag-handle--top');
                } else {
                    handleElRef.current.style.top = `${lineRect.bottom - wrapperRect.top}px`;
                    handleElRef.current.classList.remove('cv-drag-handle--top');
                }
            }
        }
    }, []);

    const onHandlePointerUp = useCallback(() => {
        if (!handleDraggingRef.current) return;
        handleDraggingRef.current = false;
        // Sync final range to React state
        if (dragRangeRef.current) {
            setRange(dragRangeRef.current.start, dragRangeRef.current.end);
            dragRangeRef.current = null;
        }
    }, [setRange]);

    // ── Apply highlights + position handle (synchronous, before paint, NO state updates) ──
    useLayoutEffect(() => {
        if (!containerRef.current) return;

        // Apply line highlights
        const lines = containerRef.current.querySelectorAll("[data-line]");
        lines.forEach(el => {
            const num = parseInt(el.getAttribute("data-line")!, 10);
            if (selectedLines.has(num)) {
                el.classList.add("line-selected");
            } else {
                el.classList.remove("line-selected");
            }
        });

        // Position handle via direct DOM (no setState → no re-render)
        if (handleElRef.current && wrapperRef.current && selectedLines.size > 0) {
            const sorted = Array.from(selectedLines).sort((a, b) => a - b);
            const wrapperRect = wrapperRef.current.getBoundingClientRect();

            if (handleAtTopRef.current) {
                const firstLineEl = containerRef.current.querySelector(`[data-line="${sorted[0]}"]`) as HTMLElement;
                if (firstLineEl) {
                    const lineRect = firstLineEl.getBoundingClientRect();
                    handleElRef.current.style.top = `${lineRect.top - wrapperRect.top - handleElRef.current.offsetHeight}px`;
                    handleElRef.current.classList.add('cv-drag-handle--top');
                }
            } else {
                const lastLineEl = containerRef.current.querySelector(`[data-line="${sorted[sorted.length - 1]}"]`) as HTMLElement;
                if (lastLineEl) {
                    const lineRect = lastLineEl.getBoundingClientRect();
                    handleElRef.current.style.top = `${lineRect.bottom - wrapperRect.top}px`;
                    handleElRef.current.classList.remove('cv-drag-handle--top');
                }
            }
        }
    }, [selectedLines, rawHtml]);

    if (error) {
        return <pre className="code-viewer-fallback">{code}</pre>;
    }

    if (!finalHtml) {
        return <div className="code-viewer-loading">...</div>;
    }

    // Hide wrapper until scroll is in position — prevents any visible jump
    const scrollPending = scrollToLine != null && scrolledForRef.current !== `${filePath}:${scrollToLine}`;

    return (
        <div ref={wrapperRef} className="code-viewer-wrapper"
             style={scrollPending ? { visibility: 'hidden' } : undefined}>
            <div
                ref={containerRef}
                className="code-viewer"
                dangerouslySetInnerHTML={{ __html: finalHtml }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
            />
            {selectionRange && (
                <div
                    ref={handleElRef}
                    className="cv-drag-handle"
                    onPointerDown={onHandlePointerDown}
                    onPointerMove={onHandlePointerMove}
                    onPointerUp={onHandlePointerUp}
                >
                    <div className="cv-drag-handle-pill" />
                </div>
            )}
        </div>
    );
});

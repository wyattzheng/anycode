import { useState, useRef, useCallback } from "react";
import type { GitChange } from "../App";
import { FileDocIcon, DiffIcon } from "./Icons";
import "./ChangesView.css";

interface ChangesViewProps {
    changes: GitChange[];
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

export function ChangesView({ changes }: ChangesViewProps) {
    const [listHeight, setListHeight] = useState(200);
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

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

    const isEmpty = changes.length === 0;

    return (
        <div className="changes-view" ref={containerRef}>
            <div className="changes-diff">
                <div className="diff-empty">
                    <DiffIcon size={28} />
                    <p>{isEmpty ? "没有未提交的变更" : "选择文件查看变更"}</p>
                </div>
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
                            <p>工作区干净 ✨</p>
                        </div>
                    ) : (
                        changes.map((change) => (
                            <div key={change.file} className={`change-item ${statusClass(change.status)}`}>
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

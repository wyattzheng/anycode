import { useState, useRef, useCallback } from "react";
import { FileDocIcon } from "./Icons";
import "./ChangesView.css";

export function ChangesView() {
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

    return (
        <div className="changes-view" ref={containerRef}>
            <div className="changes-diff">
                <div className="panel-header">Diff</div>
                <pre className="diff-content">
                    <code>{`// 选择下方文件查看 diff`}</code>
                </pre>
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
                    <div className="change-item added">
                        <FileDocIcon />
                        <span>src/App.tsx</span>
                        <span className="change-badge">A</span>
                    </div>
                    <div className="change-item modified">
                        <FileDocIcon />
                        <span>src/main.tsx</span>
                        <span className="change-badge">M</span>
                    </div>
                    <div className="change-item deleted">
                        <FileDocIcon />
                        <span>src/old.ts</span>
                        <span className="change-badge">D</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

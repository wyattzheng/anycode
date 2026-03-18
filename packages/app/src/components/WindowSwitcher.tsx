import { useState, useEffect, useRef, useCallback } from "react";
import "./WindowSwitcher.css";

export interface WindowInfo {
    id: string;
    directory: string;
    isDefault: boolean;
    createdAt: number;
}

interface WindowSwitcherProps {
    windows: WindowInfo[];
    activeWindowId: string;
    onSwitch: (id: string) => void;
    onCreate: () => void;
    onDelete: (id: string) => void;
}

function windowLabel(w: WindowInfo): string {
    if (w.directory) {
        const parts = w.directory.split("/");
        return parts[parts.length - 1] || w.directory;
    }
    return w.isDefault ? "默认" : "新窗口";
}

export function WindowSwitcher({
    windows,
    activeWindowId,
    onSwitch,
    onCreate,
    onDelete,
}: WindowSwitcherProps) {
    const [popoverId, setPopoverId] = useState<string | null>(null);
    const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null);
    const taskbarRef = useRef<HTMLElement>(null);
    const btnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

    // Tap outside taskbar to dismiss
    useEffect(() => {
        if (!popoverId) return;
        const handler = (e: MouseEvent | TouchEvent) => {
            if (taskbarRef.current && !taskbarRef.current.contains(e.target as Node)) {
                setPopoverId(null);
            }
        };
        document.addEventListener("mousedown", handler);
        document.addEventListener("touchstart", handler);
        return () => {
            document.removeEventListener("mousedown", handler);
            document.removeEventListener("touchstart", handler);
        };
    }, [popoverId]);

    const handleClick = useCallback((w: WindowInfo) => {
        if (w.id === activeWindowId) {
            if (!w.isDefault) {
                setPopoverId((prev) => {
                    if (prev === w.id) return null;
                    // Calculate position from button
                    const btn = btnRefs.current.get(w.id);
                    if (btn) {
                        const rect = btn.getBoundingClientRect();
                        setPopoverPos({ x: rect.left + rect.width / 2, y: rect.top });
                    }
                    return w.id;
                });
            }
        } else {
            setPopoverId(null);
            onSwitch(w.id);
        }
    }, [activeWindowId, onSwitch]);

    return (
        <nav className="taskbar" ref={taskbarRef}>
            <div className="taskbar-items">
                {windows.map((w) => (
                    <button
                        key={w.id}
                        ref={(el) => { if (el) btnRefs.current.set(w.id, el); }}
                        className={`taskbar-item ${w.id === activeWindowId ? "active" : ""}`}
                        onClick={() => handleClick(w)}
                    >
                        <span className="taskbar-label">{windowLabel(w)}</span>
                    </button>
                ))}
            </div>
            <button className="taskbar-add" onClick={onCreate} title="新建窗口">+</button>

            {popoverId && popoverPos && (
                <div
                    className="taskbar-popover"
                    style={{ left: popoverPos.x, top: popoverPos.y }}
                >
                    <button
                        className="taskbar-popover-btn"
                        onClick={() => {
                            const id = popoverId;
                            setPopoverId(null);
                            onDelete(id);
                        }}
                    >
                        关闭窗口
                    </button>
                </div>
            )}
        </nav>
    );
}

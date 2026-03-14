import { useState, useRef, useCallback, useEffect } from "react";
import { MicIcon, KeyboardIcon, SendIcon, CloseIcon, ChatIcon } from "./Icons";
import "./ConversationOverlay.css";

export function ConversationOverlay() {
    const [input, setInput] = useState("");
    const [recording, setRecording] = useState(false);
    const [showTextInput, setShowTextInput] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const recordStartTime = useRef<number>(0);
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        if (!recording) { setElapsed(0); return; }
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - recordStartTime.current) / 1000)), 100);
        return () => clearInterval(timer);
    }, [recording]);

    // --- 文本输入 ---
    const handleSend = () => {
        if (!input.trim()) return;
        // TODO: send message to server
        setInput("");
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // --- 对讲机模式：按住录音，松手发送 ---
    const startRecording = () => {
        setRecording(true);
        recordStartTime.current = Date.now();
        // TODO: start audio recording via Web Audio API
    };

    const stopRecording = () => {
        setRecording(false);
        const duration = Date.now() - recordStartTime.current;
        if (duration < 300) return; // 短按不发送
        // TODO: stop recording, send audio to server
    };

    const handleMicMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        startRecording();
        const onUp = () => { stopRecording(); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mouseup", onUp);
    };

    const handleMicTouchStart = (e: React.TouchEvent) => {
        e.preventDefault();
        startRecording();
        const onUp = () => { stopRecording(); window.removeEventListener("touchend", onUp); };
        window.addEventListener("touchend", onUp);
    };

    // --- 拖拽面板 ---
    const onDragStart = useCallback((clientX: number, clientY: number) => {
        dragRef.current = { startX: clientX, startY: clientY, origX: position.x, origY: position.y };
    }, [position]);

    const onDragMove = useCallback((clientX: number, clientY: number) => {
        if (!dragRef.current) return;
        const dx = clientX - dragRef.current.startX;
        const dy = clientY - dragRef.current.startY;
        setPosition({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
    }, []);

    const onDragEnd = useCallback(() => {
        dragRef.current = null;
    }, []);

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        onDragStart(e.clientX, e.clientY);
        const onMove = (ev: MouseEvent) => onDragMove(ev.clientX, ev.clientY);
        const onUp = () => { onDragEnd(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    const handleTouchStart = (e: React.TouchEvent) => {
        const touch = e.touches[0];
        onDragStart(touch.clientX, touch.clientY);
        const onMove = (ev: TouchEvent) => { ev.preventDefault(); onDragMove(ev.touches[0].clientX, ev.touches[0].clientY); };
        const onUp = () => { onDragEnd(); window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onUp); };
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("touchend", onUp);
    };

    return (
        <div
            className="conversation-panel"
            style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
        >
            <div
                className="conversation-header"
                onMouseDown={handleMouseDown}
                onTouchStart={handleTouchStart}
            >
                对话
            </div>

            <div className="conversation-messages">
                <div className="message assistant">
                    <p>你好！我是 AnyCode AI 助手。告诉我你想做什么，我来帮你写代码。</p>
                </div>
            </div>

            <div className="conversation-input">
                {showTextInput ? (
                    <>
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="输入消息..."
                            autoFocus
                        />
                        <button className="text-send-btn" onClick={handleSend}><SendIcon /></button>
                        <button className="text-close-btn" onClick={() => setShowTextInput(false)}><CloseIcon /></button>
                    </>
                ) : (
                    <>
                        <div className="mic-wrapper">
                            {recording && (
                                <div className="mic-tooltip">录音中 {elapsed}s</div>
                            )}
                            <button
                                className={`mic-btn ${recording ? "recording" : ""}`}
                                onMouseDown={handleMicMouseDown}
                                onTouchStart={handleMicTouchStart}
                            >
                                <MicIcon />
                            </button>
                        </div>
                        <button className="text-toggle-btn" onClick={() => setShowTextInput(true)}><KeyboardIcon /></button>
                    </>
                )}
            </div>
        </div>
    );
}

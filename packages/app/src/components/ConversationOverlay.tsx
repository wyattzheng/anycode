import { useState, useRef, useCallback, useEffect } from "react";
import { MicIcon, KeyboardIcon, SendIcon, CloseIcon, ChatIcon } from "./Icons";
import "./ConversationOverlay.css";

// ── Types ──────────────────────────────────────────────────────────────────

type ThinkingBlock = { kind: "thinking"; content: string; duration?: number };
type ToolCard = {
    kind: "tool";
    id: string;
    name: string;
    args?: string;
    title?: string;
    status: "running" | "done" | "error";
    duration?: number;
    error?: string;
};
type TextBlock = { kind: "text"; content: string };
type UsageBlock = {
    kind: "usage";
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cost: number;
};
type ErrorBlock = { kind: "error"; message: string };
type ResponsePart = ThinkingBlock | ToolCard | TextBlock | UsageBlock | ErrorBlock;

type ChatMessage =
    | { role: "user"; text: string }
    | { role: "assistant"; parts: ResponsePart[] };

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDur(ms?: number) {
    if (ms == null) return "";
    return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
}
function fmtK(n: number) {
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}
function argSummary(args?: Record<string, unknown>) {
    if (!args) return "";
    const keys = Object.keys(args);
    if (keys.length === 0) return "";
    const first = args[keys[0]];
    const val = typeof first === "string" ? first : JSON.stringify(first);
    return val.length > 40 ? val.slice(0, 37) + "…" : val;
}

// ── Component ──────────────────────────────────────────────────────────────

export function ConversationOverlay() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [recording, setRecording] = useState(false);
    const [showTextInput, setShowTextInput] = useState(false);
    const [busy, setBusy] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 });

    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const recordStartTime = useRef<number>(0);
    const [elapsed, setElapsed] = useState(0);
    const msgsRef = useRef<HTMLDivElement>(null);
    const toolMapRef = useRef<Map<string, number>>(new Map());

    // Auto-scroll
    useEffect(() => {
        msgsRef.current?.scrollTo(0, msgsRef.current.scrollHeight);
    }, [messages]);

    // Recording timer
    useEffect(() => {
        if (!recording) { setElapsed(0); return; }
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - recordStartTime.current) / 1000)), 100);
        return () => clearInterval(timer);
    }, [recording]);

    // ── State mutation helpers (work on latest snapshot) ──
    const appendPart = useCallback((part: ResponsePart) => {
        setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant") {
                return [...prev.slice(0, -1), { ...last, parts: [...last.parts, part] }];
            }
            return [...prev, { role: "assistant", parts: [part] }];
        });
    }, []);

    const updateLastPartOfKind = useCallback(<K extends ResponsePart["kind"]>(
        kind: K,
        updater: (p: Extract<ResponsePart, { kind: K }>) => Extract<ResponsePart, { kind: K }>
    ) => {
        setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== "assistant") return prev;
            const parts = [...last.parts];
            for (let i = parts.length - 1; i >= 0; i--) {
                if (parts[i].kind === kind) {
                    parts[i] = updater(parts[i] as any);
                    break;
                }
            }
            return [...prev.slice(0, -1), { ...last, parts }];
        });
    }, []);

    const updateToolById = useCallback((toolCallId: string, updater: (t: ToolCard) => ToolCard) => {
        setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== "assistant") return prev;
            const parts = [...last.parts];
            const idx = toolMapRef.current.get(toolCallId);
            if (idx != null && parts[idx]?.kind === "tool") {
                parts[idx] = updater(parts[idx] as ToolCard);
            }
            return [...prev.slice(0, -1), { ...last, parts }];
        });
    }, []);

    // ── Event handler ──
    const handleEvent = useCallback((data: any) => {
        switch (data.type) {
            case "thinking.start":
                appendPart({ kind: "thinking", content: "" });
                break;
            case "thinking.delta":
                updateLastPartOfKind("thinking", p => ({ ...p, content: p.content + (data.thinkingContent || "") }));
                break;
            case "thinking.end":
                updateLastPartOfKind("thinking", p => ({ ...p, duration: data.thinkingDuration }));
                break;
            case "text.delta":
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last && last.role === "assistant") {
                        const parts = [...last.parts];
                        const lastPart = parts[parts.length - 1];
                        if (lastPart?.kind === "text") {
                            parts[parts.length - 1] = { ...lastPart, content: lastPart.content + (data.content || "") };
                        } else {
                            parts.push({ kind: "text", content: data.content || "" });
                        }
                        return [...prev.slice(0, -1), { ...last, parts }];
                    }
                    return [...prev, { role: "assistant", parts: [{ kind: "text", content: data.content || "" }] }];
                });
                break;
            case "tool.start": {
                const toolPart: ToolCard = {
                    kind: "tool", id: data.toolCallId || "", name: data.toolName || "",
                    args: argSummary(data.toolArgs), status: "running",
                };
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last && last.role === "assistant") {
                        const newParts = [...last.parts, toolPart];
                        if (data.toolCallId) toolMapRef.current.set(data.toolCallId, newParts.length - 1);
                        return [...prev.slice(0, -1), { ...last, parts: newParts }];
                    }
                    if (data.toolCallId) toolMapRef.current.set(data.toolCallId, 0);
                    return [...prev, { role: "assistant", parts: [toolPart] }];
                });
                break;
            }
            case "tool.done":
                if (data.toolCallId) updateToolById(data.toolCallId, t => ({
                    ...t, status: "done", duration: data.toolDuration, title: data.toolTitle,
                }));
                break;
            case "tool.error":
                if (data.toolCallId) updateToolById(data.toolCallId, t => ({
                    ...t, status: "error", duration: data.toolDuration, error: data.error,
                }));
                break;
            case "message.done":
                if (data.usage) {
                    appendPart({
                        kind: "usage",
                        inputTokens: data.usage.inputTokens,
                        outputTokens: data.usage.outputTokens,
                        reasoningTokens: data.usage.reasoningTokens,
                        cost: data.usage.cost,
                    });
                }
                break;
            case "error":
                appendPart({ kind: "error", message: data.error || "unknown error" });
                break;
            case "done":
                setBusy(false);
                break;
        }
    }, [appendPart, updateLastPartOfKind, updateToolById]);

    // ── Send message ──
    const handleSend = useCallback(async () => {
        const text = input.trim();
        if (!text || busy) return;
        setInput("");
        setMessages(prev => [...prev, { role: "user", text }]);
        setBusy(true);
        toolMapRef.current.clear();

        // Start assistant response container
        setMessages(prev => [...prev, { role: "assistant", parts: [] }]);

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: text }),
            });
            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split("\n");
                buf = lines.pop()!;
                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    try { handleEvent(JSON.parse(line.slice(6))); } catch { /* skip */ }
                }
            }
        } catch (e: any) {
            appendPart({ kind: "error", message: e.message });
        }
        setBusy(false);
    }, [input, busy, handleEvent, appendPart]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    };

    // ── Recording ──
    const startRecording = () => { setRecording(true); recordStartTime.current = Date.now(); };
    const stopRecording = () => {
        setRecording(false);
        if (Date.now() - recordStartTime.current < 300) return;
        // TODO: send audio to server
    };
    const handleMicMouseDown = (e: React.MouseEvent) => {
        e.preventDefault(); startRecording();
        const onUp = () => { stopRecording(); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mouseup", onUp);
    };
    const handleMicTouchStart = (e: React.TouchEvent) => {
        e.preventDefault(); startRecording();
        const onUp = () => { stopRecording(); window.removeEventListener("touchend", onUp); };
        window.addEventListener("touchend", onUp);
    };

    // ── Drag ──
    const onDragStart = useCallback((cx: number, cy: number) => {
        dragRef.current = { startX: cx, startY: cy, origX: position.x, origY: position.y };
    }, [position]);
    const onDragMove = useCallback((cx: number, cy: number) => {
        if (!dragRef.current) return;
        setPosition({ x: dragRef.current.origX + cx - dragRef.current.startX, y: dragRef.current.origY + cy - dragRef.current.startY });
    }, []);
    const onDragEnd = useCallback(() => { dragRef.current = null; }, []);

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault(); onDragStart(e.clientX, e.clientY);
        const onMove = (ev: MouseEvent) => onDragMove(ev.clientX, ev.clientY);
        const onUp = () => { onDragEnd(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    };
    const handleTouchStart = (e: React.TouchEvent) => {
        const t = e.touches[0]; onDragStart(t.clientX, t.clientY);
        const onMove = (ev: TouchEvent) => { ev.preventDefault(); onDragMove(ev.touches[0].clientX, ev.touches[0].clientY); };
        const onUp = () => { onDragEnd(); window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onUp); };
        window.addEventListener("touchmove", onMove, { passive: false }); window.addEventListener("touchend", onUp);
    };

    // ── Render parts ──
    const renderPart = (part: ResponsePart, i: number) => {
        switch (part.kind) {
            case "thinking":
                return (
                    <details key={i} className="co-thinking">
                        <summary>💭 Thinking <span className="co-thinking-dur">{fmtDur(part.duration) || "…"}</span></summary>
                        <div className="co-thinking-content">{part.content}</div>
                    </details>
                );
            case "tool":
                return (
                    <div key={i} className={`co-tool ${part.status}`} title={part.error || part.title || part.args || ""}>
                        <span className="co-tool-icon">{part.status === "running" ? "⏳" : part.status === "done" ? "✓" : "✗"}</span>
                        <span className="co-tool-name">{part.name}</span>
                        <span className="co-tool-info">{part.status === "error" ? (part.error || "error") : (part.title || part.args || "")}</span>
                        {part.duration != null && <span className="co-tool-dur">{fmtDur(part.duration)}</span>}
                    </div>
                );
            case "text":
                return <div key={i} className="co-text">{part.content}</div>;
            case "usage":
                return (
                    <div key={i} className="co-usage">
                        <span>↓{fmtK(part.inputTokens)}</span>
                        <span>↑{fmtK(part.outputTokens)}</span>
                        {part.reasoningTokens > 0 && <span>🧠{fmtK(part.reasoningTokens)}</span>}
                        <span>${part.cost.toFixed(4)}</span>
                    </div>
                );
            case "error":
                return <div key={i} className="co-error">⚠ {part.message}</div>;
        }
    };

    return (
        <div className="conversation-panel" style={{ transform: `translate(${position.x}px, ${position.y}px)` }}>
            <div className="conversation-header" onMouseDown={handleMouseDown} onTouchStart={handleTouchStart}>
                <div className="drag-grip" />
                <div className="conversation-header-content"><ChatIcon /> 对话</div>
            </div>

            <div className="conversation-messages" ref={msgsRef}>
                {messages.length === 0 && (
                    <div className="co-text" style={{ color: "var(--color-text-dim)" }}>
                        你好！告诉我你想做什么 ✨
                    </div>
                )}
                {messages.map((msg, i) =>
                    msg.role === "user" ? (
                        <div key={i} className="co-user">{msg.text}</div>
                    ) : (
                        <div key={i} className="co-response">
                            {msg.parts.map(renderPart)}
                        </div>
                    )
                )}
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
                            disabled={busy}
                        />
                        <button className="text-send-btn" onClick={handleSend} disabled={busy}><SendIcon /></button>
                        <button className="text-close-btn" onClick={() => setShowTextInput(false)}><CloseIcon /></button>
                    </>
                ) : (
                    <>
                        <div className="mic-wrapper">
                            {recording && <div className="mic-tooltip">录音中 {elapsed}s</div>}
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

import { useState, useRef, useCallback, useEffect } from "react";
import type { FileContext } from "../App";
import { MicIcon, KeyboardIcon, SendIcon, CloseIcon, ChatIcon, StopIcon } from "./Icons";
import "./ConversationOverlay.css";

// ── Types ──────────────────────────────────────────────────────────────────

type ThinkingBlock = { kind: "thinking"; content: string; duration?: number };
type ToolArgs = Record<string, unknown>;
type ToolCard = {
    kind: "tool";
    id: string;
    name: string;
    args?: ToolArgs;
    title?: string;
    status: "running" | "done" | "error";
    duration?: number;
    error?: string;
};
type TextBlock = { kind: "text"; content: string };
type ErrorBlock = { kind: "error"; message: string };
type ResponsePart = ThinkingBlock | ToolCard | TextBlock | ErrorBlock;

type ChatMessage =
    | { role: "user"; text: string }
    | { role: "assistant"; parts: ResponsePart[] };

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDur(ms?: number) {
    if (ms == null) return "";
    return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
}

function normalizeInlineText(value: unknown) {
    if (value == null) return "";
    if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
    try {
        return JSON.stringify(value).replace(/\s+/g, " ").trim();
    } catch {
        return String(value).replace(/\s+/g, " ").trim();
    }
}

function compactPathLabel(value: string) {
    const normalized = value.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
    if (!normalized) return "";
    const trailingSlash = normalized.length > 1 && normalized.endsWith("/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) return normalized;
    if (parts.length === 1) return trailingSlash ? `${parts[0]}/` : parts[0];
    const last = parts[parts.length - 1];
    return trailingSlash ? `${last}/` : last;
}

function firstString(args: ToolArgs | undefined, keys: string[]) {
    if (!args) return "";
    for (const key of keys) {
        const value = args[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

function summarizeApplyPatchFromText(text: string) {
    if (!text) return "";
    const lines = text.split(/\r?\n/);
    const files: string[] = [];

    for (const line of lines) {
        const patchMatch = line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/);
        if (patchMatch) {
            files.push(patchMatch[1].trim());
            continue;
        }
        const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
        if (moveMatch && files.length > 0) {
            files[files.length - 1] = moveMatch[1].trim();
            continue;
        }
        const resultMatch = line.match(/^[AMD] (.+)$/);
        if (resultMatch) files.push(resultMatch[1].trim());
    }

    if (files.length === 0) return normalizeInlineText(text);
    const primary = compactPathLabel(files[0]);
    return files.length === 1 ? primary : `${primary} +${files.length - 1}`;
}

function summarizeToolInfo(tool: ToolCard) {
    if (tool.status === "error") return tool.error || "error";

    switch (tool.name) {
        case "apply_patch":
            return summarizeApplyPatchFromText(tool.title || firstString(tool.args, ["patchText"]));
        case "write":
        case "edit":
        case "multiedit":
        case "read": {
            const path = compactPathLabel(tool.title || firstString(tool.args, ["filePath", "path"]));
            const off = Number(tool.args?.offset) || 0;
            const lim = Number(tool.args?.limit) || 0;
            if (off || lim) {
                const end = lim ? off + lim : "…";
                return `${path} L${off + 1}–${end}`;
            }
            return path;
        }
        case "ls":
        case "glob":
            return compactPathLabel(tool.title || firstString(tool.args, ["filePath", "path"]));
        case "set_working_directory": {
            const titlePath = tool.title?.replace(/^Set directory:\s*/, "") || "";
            return compactPathLabel(titlePath || firstString(tool.args, ["directory"]));
        }
        case "codesearch":
            return (tool.title?.replace(/^Code search:\s*/, "") || firstString(tool.args, ["query"])).trim();
        case "websearch":
            return (tool.title?.replace(/^Web search:\s*/, "") || firstString(tool.args, ["query"])).trim();
        case "grep":
            return firstString(tool.args, ["pattern", "query", "include"]);
        case "bash":
            return firstString(tool.args, ["command", "description"]) || normalizeInlineText(tool.title);
        default:
            return normalizeInlineText(tool.title) || normalizeInlineText(tool.args);
    }
}

// ── Component ──────────────────────────────────────────────────────────────

interface ConversationOverlayProps {
    sessionId: string;
    fileContext?: FileContext | null;
}

const SIDEBAR_BREAKPOINT = 768;
const STORAGE_KEY_POS = "anycode-conv-pos";
const STORAGE_KEY_SIZE = "anycode-conv-size";

function loadStoredRect() {
    try {
        const pos = JSON.parse(localStorage.getItem(STORAGE_KEY_POS) || "null");
        const size = JSON.parse(localStorage.getItem(STORAGE_KEY_SIZE) || "null");
        return {
            pos: pos && typeof pos.x === "number" ? pos as { x: number; y: number } : { x: 0, y: 0 },
            size: size && typeof size.w === "number" ? size as { w: number; h: number } : { w: 220, h: 280 },
        };
    } catch {
        return { pos: { x: 0, y: 0 }, size: { w: 220, h: 280 } };
    }
}

function useIsSidebar() {
    const [isSidebar, setIsSidebar] = useState(() => window.innerWidth > SIDEBAR_BREAKPOINT);
    useEffect(() => {
        const mq = window.matchMedia(`(min-width: ${SIDEBAR_BREAKPOINT + 1}px)`);
        const handler = (e: MediaQueryListEvent) => setIsSidebar(e.matches);
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
    }, []);
    return isSidebar;
}

export function ConversationOverlay({ sessionId, fileContext }: ConversationOverlayProps) {
    const isSidebar = useIsSidebar();

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [recording, setRecording] = useState(false);
    const [showTextInput, setShowTextInput] = useState(false);
    const [busy, setBusy] = useState(false);

    const stored = useRef(loadStoredRect());
    const [position, setPosition] = useState(stored.current.pos);
    const [size, setSize] = useState(stored.current.size);

    // Persist floating position/size to localStorage
    useEffect(() => {
        if (isSidebar) return;
        localStorage.setItem(STORAGE_KEY_POS, JSON.stringify(position));
    }, [position, isSidebar]);
    useEffect(() => {
        if (isSidebar) return;
        localStorage.setItem(STORAGE_KEY_SIZE, JSON.stringify(size));
    }, [size, isSidebar]);

    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);
    const recordStartTime = useRef<number>(0);
    const [elapsed, setElapsed] = useState(0);
    const msgsRef = useRef<HTMLDivElement>(null);
    const toolMapRef = useRef<Map<string, number>>(new Map());
    const abortRef = useRef<AbortController | null>(null);

    // Load history messages when session resumes
    useEffect(() => {
        if (!sessionId) return;
        (async () => {
            try {
                const res = await fetch(`/api/messages?sessionId=${encodeURIComponent(sessionId)}`);
                if (!res.ok) return;
                const data = await res.json();
                if (!Array.isArray(data) || data.length === 0) return;

                const history: ChatMessage[] = [];
                for (const msg of data) {
                    if (msg.role === "user") {
                        history.push({ role: "user", text: msg.text || "" });
                    } else {
                        const parts: ResponsePart[] = [];
                        if (Array.isArray(msg.parts)) {
                            for (const p of msg.parts) {
                                if (p.type === "text") {
                                    parts.push({ kind: "text", content: p.content || "" });
                                } else if (p.type === "tool") {
                                    parts.push({
                                        kind: "tool",
                                        id: "",
                                        name: p.tool || "",
                                        status: "done",
                                        title: p.content || "",
                                    });
                                } else if (p.type === "thinking") {
                                    parts.push({ kind: "thinking", content: p.content || "" });
                                }
                            }
                        }
                        if (parts.length > 0) {
                            history.push({ role: "assistant", parts });
                        }
                    }
                }
                if (history.length > 0) {
                    setMessages(history);
                }
            } catch { /* ignore */ }
        })();
    }, [sessionId]);

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
                const id = data.toolCallId || "";
                if (id && toolMapRef.current.has(id)) {
                    // Already exists — update in place
                    updateToolById(id, t => ({
                        ...t,
                        ...(data.toolTitle != null ? { title: data.toolTitle } : {}),
                    }));
                } else {
                    // New tool — append
                    const toolPart: ToolCard = {
                        kind: "tool", id, name: data.toolName || "",
                        args: data.toolArgs, title: data.toolTitle, status: "running",
                    };
                    setMessages(prev => {
                        const last = prev[prev.length - 1];
                        if (last && last.role === "assistant") {
                            const newParts = [...last.parts, toolPart];
                            if (id) toolMapRef.current.set(id, newParts.length - 1);
                            return [...prev.slice(0, -1), { ...last, parts: newParts }];
                        }
                        if (id) toolMapRef.current.set(id, 0);
                        return [...prev, { role: "assistant", parts: [toolPart] }];
                    });
                }
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

        // Build display text with context info
        const contextLabel = fileContext
            ? `[${fileContext.file} L${fileContext.lines[0]}–${fileContext.lines[fileContext.lines.length - 1]}]\n${text}`
            : text;
        setMessages(prev => [...prev, { role: "user", text: contextLabel }]);
        setBusy(true);
        toolMapRef.current.clear();

        const ctl = new AbortController();
        abortRef.current = ctl;

        // Start assistant response container
        setMessages(prev => [...prev, { role: "assistant", parts: [] }]);

        // Build payload — include file context if available
        const payload: Record<string, unknown> = { message: text, sessionId };
        if (fileContext) {
            payload.fileContext = fileContext;
        }

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: ctl.signal,
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
            if (e.name !== "AbortError") {
                appendPart({ kind: "error", message: e.message });
            }
        }
        abortRef.current = null;
        setBusy(false);
    }, [input, busy, handleEvent, appendPart, fileContext]);

    const handleStop = useCallback(() => {
        abortRef.current?.abort();
    }, []);

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

    // ── Resize (shared logic for bottom-left & bottom-right) ──
    const resizeDirRef = useRef<"bl" | "br">("bl");
    const onResizeStart = useCallback((cx: number, cy: number, dir: "bl" | "br") => {
        resizeDirRef.current = dir;
        resizeRef.current = { startX: cx, startY: cy, origW: size.w, origH: size.h };
    }, [size]);
    const onResizeMove = useCallback((cx: number, cy: number) => {
        if (!resizeRef.current) return;
        const dx = cx - resizeRef.current.startX;
        const dh = cy - resizeRef.current.startY;
        const dw = resizeDirRef.current === "bl" ? -dx : dx;
        setSize({
            w: Math.max(180, Math.min(600, resizeRef.current.origW + dw)),
            h: Math.max(200, Math.min(800, resizeRef.current.origH + dh)),
        });
    }, []);
    const onResizeEnd = useCallback(() => { resizeRef.current = null; }, []);

    const makeResizeMouseDown = (dir: "bl" | "br") => (e: React.MouseEvent) => {
        e.preventDefault(); e.stopPropagation();
        onResizeStart(e.clientX, e.clientY, dir);
        const onMove = (ev: MouseEvent) => onResizeMove(ev.clientX, ev.clientY);
        const onUp = () => { onResizeEnd(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    };
    const makeResizeTouchStart = (dir: "bl" | "br") => (e: React.TouchEvent) => {
        e.stopPropagation();
        const t = e.touches[0]; onResizeStart(t.clientX, t.clientY, dir);
        const onMove = (ev: TouchEvent) => { ev.preventDefault(); onResizeMove(ev.touches[0].clientX, ev.touches[0].clientY); };
        const onUp = () => { onResizeEnd(); window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onUp); };
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
                const toolInfo = summarizeToolInfo(part);
                return (
                    <div key={i} className={`co-tool ${part.status}`} title={toolInfo}>
                        <span className="co-tool-icon">{part.status === "running" ? "⏳" : part.status === "done" ? "✓" : "✗"}</span>
                        <span className="co-tool-name">{part.name}</span>
                        <span className="co-tool-info">{toolInfo}</span>
                        {part.duration != null && <span className="co-tool-dur">{fmtDur(part.duration)}</span>}
                    </div>
                );
            case "text":
                return <div key={i} className="co-text">{part.content}</div>;

            case "error":
                return <div key={i} className="co-error">⚠ {part.message}</div>;
        }
    };

    const panelClass = isSidebar ? "conversation-panel conversation-sidebar" : "conversation-panel conversation-floating";
    const panelStyle = isSidebar
        ? undefined
        : { transform: `translate(${position.x}px, ${position.y}px)`, width: size.w, height: size.h };

    return (
        <div className={panelClass} style={panelStyle}>
            <div className="conversation-header" {...(!isSidebar ? { onMouseDown: handleMouseDown, onTouchStart: handleTouchStart } : {})}>
                {!isSidebar && <div className="drag-grip" />}
                <div className="conversation-header-content"><ChatIcon /> 对话</div>
            </div>

            <div className="conversation-messages" ref={msgsRef}>
                {messages.length === 0 && (
                    <div className="co-text" style={{ color: "var(--color-text-dim)" }}>
                        你好！告诉我你想做什么
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

            {fileContext && (
                <div className="co-file-context">
                    <span className="co-file-context-text">
                        {fileContext.file.split("/").pop()} L{fileContext.lines[0]}–{fileContext.lines[fileContext.lines.length - 1]}
                    </span>
                </div>
            )}
            <div className="conversation-input">
                {showTextInput ? (
                    <>
                        <input
                            type="text"
                            value={busy ? "" : input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={busy ? "正在处理中..." : "输入消息..."}
                            autoFocus
                            disabled={busy}
                        />
                        {busy ? (
                            <button className="text-send-btn text-stop-btn" onClick={handleStop}><StopIcon size={18} /></button>
                        ) : (
                            <button className="text-send-btn" onClick={handleSend}><SendIcon /></button>
                        )}
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
            {!isSidebar && (
                <>
                    <div className="co-resize-grip co-resize-bl" onMouseDown={makeResizeMouseDown("bl")} onTouchStart={makeResizeTouchStart("bl")} />
                    <div className="co-resize-grip co-resize-br" onMouseDown={makeResizeMouseDown("br")} onTouchStart={makeResizeTouchStart("br")} />
                </>
            )}
        </div>
    );
}

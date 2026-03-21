import { useState, useRef, useCallback, useEffect, type MutableRefObject } from "react";
import type { FileContext } from "../App";
import { MicIcon, KeyboardIcon, SendIcon, CloseIcon, ChatIcon, StopIcon, PinIcon, UndockIcon } from "./Icons";
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
        case "set_user_watch_project": {
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
    chatHandlerRef?: MutableRefObject<((data: any) => void) | undefined>;
    sendMessage: (data: any) => void;
}

const STORAGE_KEY_POS = "anycode-conv-pos";
const STORAGE_KEY_SIZE = "anycode-conv-size";
const STORAGE_KEY_FLOATING = "anycode-conv-floating";
const STORAGE_KEY_SIDEBAR_W = "anycode-conv-sidebar-w";

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

function defaultSidebarWidth() {
    const vw = window.innerWidth;
    if (vw >= 1024) return 300;
    if (vw >= 600) return 250;
    return 150;
}

export function ConversationOverlay({ sessionId, fileContext, chatHandlerRef, sendMessage }: ConversationOverlayProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [recording, setRecording] = useState(false);
    const [showTextInput, setShowTextInput] = useState(false);
    const [busy, setBusy] = useState(false);
    const [inputNarrow, setInputNarrow] = useState(false);
    const inputBarRef = useRef<HTMLDivElement>(null);
    const textInputRef = useRef<HTMLInputElement>(null);
    const [focusTrigger, setFocusTrigger] = useState(0);

    // Detect narrow input bar for stacked layout
    useEffect(() => {
        const el = inputBarRef.current;
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => {
            setInputNarrow(entry.contentRect.width < 200);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Focus text input when triggered by double-click
    useEffect(() => {
        if (focusTrigger > 0) {
            textInputRef.current?.focus();
        }
    }, [focusTrigger]);

    // Floating mode toggle — defaults to false (sidebar)
    const [floating, setFloating] = useState(() => {
        try { return localStorage.getItem(STORAGE_KEY_FLOATING) === "true"; } catch { return false; }
    });
    const toggleFloating = useCallback(() => {
        setFloating(prev => {
            const next = !prev;
            try { localStorage.setItem(STORAGE_KEY_FLOATING, String(next)); } catch { /* ignore */ }
            return next;
        });
    }, []);

    // Sidebar width (resizable via left border drag)
    const hasUserWidth = useRef(false);
    const [sidebarWidth, setSidebarWidth] = useState(() => {
        try {
            const v = localStorage.getItem(STORAGE_KEY_SIDEBAR_W);
            if (v) { hasUserWidth.current = true; return Math.max(120, Math.min(600, Number(v))); }
        } catch { /* ignore */ }
        return defaultSidebarWidth();
    });

    // Update width on window resize when no user-saved value
    useEffect(() => {
        if (hasUserWidth.current) return;
        const onResize = () => setSidebarWidth(defaultSidebarWidth());
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const sidebarDragRef = useRef<{ startX: number; origW: number } | null>(null);

    const onSidebarResizeStart = useCallback((cx: number) => {
        sidebarDragRef.current = { startX: cx, origW: sidebarWidth };
    }, [sidebarWidth]);
    const onSidebarResizeMove = useCallback((cx: number) => {
        if (!sidebarDragRef.current) return;
        const dw = sidebarDragRef.current.startX - cx; // dragging left = wider
        const w = Math.max(120, Math.min(600, sidebarDragRef.current.origW + dw));
        setSidebarWidth(w);
    }, []);
    const onSidebarResizeEnd = useCallback(() => {
        if (sidebarDragRef.current) {
            hasUserWidth.current = true;
            setSidebarWidth((w: number) => { try { localStorage.setItem(STORAGE_KEY_SIDEBAR_W, String(w)); } catch { } return w; });
        }
        sidebarDragRef.current = null;
    }, []);

    const handleBorderMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        document.body.style.userSelect = 'none';
        onSidebarResizeStart(e.clientX);
        const onMove = (ev: MouseEvent) => onSidebarResizeMove(ev.clientX);
        const onUp = () => { document.body.style.userSelect = ''; onSidebarResizeEnd(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    }, [onSidebarResizeStart, onSidebarResizeMove, onSidebarResizeEnd]);
    const handleBorderTouchStart = useCallback((e: React.TouchEvent) => {
        document.body.style.userSelect = 'none';
        onSidebarResizeStart(e.touches[0].clientX);
        const onMove = (ev: TouchEvent) => { ev.preventDefault(); onSidebarResizeMove(ev.touches[0].clientX); };
        const onUp = () => { document.body.style.userSelect = ''; onSidebarResizeEnd(); window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onUp); };
        window.addEventListener('touchmove', onMove, { passive: false }); window.addEventListener('touchend', onUp);
    }, [onSidebarResizeStart, onSidebarResizeMove, onSidebarResizeEnd]);

    // Floating position & size
    const stored = useRef(loadStoredRect());
    const [position, setPosition] = useState(stored.current.pos);
    const [size, setSize] = useState(stored.current.size);

    useEffect(() => {
        if (!floating) return;
        localStorage.setItem(STORAGE_KEY_POS, JSON.stringify(position));
    }, [position, floating]);
    useEffect(() => {
        if (!floating) return;
        localStorage.setItem(STORAGE_KEY_SIZE, JSON.stringify(size));
    }, [size, floating]);

    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);
    const recordStartTime = useRef<number>(0);
    const [elapsed, setElapsed] = useState(0);
    const msgsRef = useRef<HTMLDivElement>(null);
    const toolMapRef = useRef<Map<string, number>>(new Map());

    // Load history messages when session changes (including window switch)
    useEffect(() => {
        if (!sessionId) return;
        // Clear previous session's state immediately
        setMessages([]);
        setBusy(false);
        toolMapRef.current.clear();

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

    // Smart auto-scroll: locked (follow new messages) / unlocked (user scrolled up)
    const scrollLocked = useRef(true);

    useEffect(() => {
        const el = msgsRef.current;
        if (!el) return;
        const onScroll = () => {
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
            scrollLocked.current = atBottom;
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => el.removeEventListener('scroll', onScroll);
    }, []);

    // Auto-scroll only when locked
    useEffect(() => {
        if (scrollLocked.current) {
            msgsRef.current?.scrollTo(0, msgsRef.current.scrollHeight);
        }
    }, [messages]);

    // Also scroll to bottom when the container is resized (e.g. sidebar drag)
    useEffect(() => {
        const el = msgsRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => {
            if (scrollLocked.current) {
                el.scrollTo(0, el.scrollHeight);
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

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

    // Register WebSocket chat event handler — all clients receive the same events
    useEffect(() => {
        if (!chatHandlerRef) return;
        chatHandlerRef.current = (data: any) => {
            switch (data.type) {
                case "chat.userMessage":
                    toolMapRef.current.clear();
                    setMessages(prev => [...prev,
                    { role: "user", text: data.text },
                    { role: "assistant", parts: [] },
                    ]);
                    setBusy(true);
                    break;
                case "chat.event":
                    if (data.event) handleEvent(data.event);
                    break;
                case "chat.done":
                    setBusy(false);
                    break;
            }
        };
        return () => { chatHandlerRef.current = undefined; };
    }, [handleEvent, chatHandlerRef]);

    // ── Send message ──
    const handleSend = useCallback(() => {
        const text = input.trim();
        if (!text || busy) return;
        setInput("");
        setBusy(true);

        const payload: Record<string, unknown> = { type: "chat.send", message: text };
        if (fileContext) payload.fileContext = fileContext;
        sendMessage(payload);
    }, [input, busy, fileContext, sendMessage]);

    const handleStop = useCallback(() => {
        sendMessage({ type: "chat.stop" });
    }, [sendMessage]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleSend(); }
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

    // ── Drag (floating mode only) ──
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

    // ── Resize (floating mode only) ──
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
            w: Math.max(160, Math.min(600, resizeRef.current.origW + dw)),
            h: Math.max(130, Math.min(800, resizeRef.current.origH + dh)),
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

    const panelClass = floating
        ? "conversation-panel conversation-floating"
        : "conversation-panel conversation-sidebar";
    const panelStyle = floating
        ? { transform: `translate(${position.x}px, ${position.y}px)`, width: size.w, height: size.h }
        : { width: sidebarWidth };

    return (
        <div className={panelClass} style={panelStyle}>
            {!floating && <div className="co-sidebar-border" onMouseDown={handleBorderMouseDown} onTouchStart={handleBorderTouchStart} />}
            <div className="conversation-header"
                {...(floating ? { onMouseDown: handleMouseDown, onTouchStart: handleTouchStart } : {})}
            >
                {floating && <div className="drag-grip" />}
                <div className="conversation-header-content">
                    <ChatIcon /> 对话
                    <button
                        className="co-float-toggle"
                        onClick={toggleFloating}
                        title={floating ? "固定到侧边栏" : "浮动窗口"}
                    >
                        {floating ? <PinIcon /> : <UndockIcon />}
                    </button>
                </div>
            </div>

            <div className="conversation-messages" ref={msgsRef} onDoubleClick={() => {
                setShowTextInput(true);
                setFocusTrigger(n => n + 1);
            }}>
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
            <div className={`conversation-input${inputNarrow && showTextInput ? ' conversation-input--stacked' : ''}`} ref={inputBarRef}>
                {showTextInput ? (
                    inputNarrow ? (
                        <>
                            <input
                                ref={textInputRef}
                                type="text"
                                value={busy ? "" : input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={busy ? "正在处理中..." : "输入消息..."}
                                autoFocus
                                disabled={busy}
                            />
                            <div className="text-buttons-row">
                                <button className="text-close-btn" onClick={() => setShowTextInput(false)}><CloseIcon /></button>
                                {busy ? (
                                    <button className="text-send-btn text-stop-btn" onClick={handleStop}><StopIcon size={18} /></button>
                                ) : (
                                    <button className="text-send-btn" onClick={handleSend}><SendIcon /></button>
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            <input
                                ref={textInputRef}
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
                    )
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
            {floating && (
                <>
                    <div className="co-resize-grip co-resize-bl" onMouseDown={makeResizeMouseDown("bl")} onTouchStart={makeResizeTouchStart("bl")} />
                    <div className="co-resize-grip co-resize-br" onMouseDown={makeResizeMouseDown("br")} onTouchStart={makeResizeTouchStart("br")} />
                </>
            )}
        </div>
    );
}

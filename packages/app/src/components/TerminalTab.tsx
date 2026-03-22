import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalIcon } from "./Icons";
import "@xterm/xterm/css/xterm.css";
import { getWsUrl } from "../serverUrl";
import "./TerminalTab.css";

interface TerminalTabProps {
    sessionId: string;
}

export function TerminalTab({ sessionId }: TerminalTabProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const [alive, setAlive] = useState<boolean | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const term = new Terminal({
            fontSize: 11,
            fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
            fontWeight: "400",
            letterSpacing: 0,
            lineHeight: 1.25,
            theme: {
                background: "#1e1e1e",
                foreground: "#e0e0e0",
                cursor: "rgba(255, 255, 255, 0.25)",
                cursorAccent: "transparent",
                selectionBackground: "rgba(255, 255, 255, 0.15)",
                selectionForeground: "#ffffff",
                black: "#1e1e1e",
                red: "#f47067",
                green: "#8ddb8c",
                yellow: "#e0af68",
                blue: "#6cb6ff",
                magenta: "#dcbdfb",
                cyan: "#76e3ea",
                white: "#e0e0e0",
                brightBlack: "#6e7681",
                brightRed: "#ff938a",
                brightGreen: "#a8e4a0",
                brightYellow: "#f0d399",
                brightBlue: "#96d0ff",
                brightMagenta: "#eedcff",
                brightCyan: "#a5f0f5",
                brightWhite: "#ffffff",
            },
            cursorBlink: false,
            cursorInactiveStyle: "none",
            scrollback: 5000,
            allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current);
        fitAddon.fit();

        termRef.current = term;
        fitRef.current = fitAddon;

        // Forward keyboard input to the server
        term.onData((data) => {
            if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "terminal.input", data }));
            }
        });

        // ── WebSocket with auto-reconnect ──
        let ws: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;
        let retryDelay = 1000;

        function sendResize() {
            if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "terminal.resize",
                    cols: term.cols,
                    rows: term.rows,
                }));
            }
        }

        function connect() {
            if (disposed) return;

            ws = new WebSocket(
                getWsUrl(`/terminal?sessionId=${sessionId}`)
            );

            ws.onopen = () => {
                retryDelay = 1000;
                sendResize();
            };

            ws.onmessage = (e) => {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg.type === "terminal.output") {
                        term.write(msg.data);
                    } else if (msg.type === "terminal.ready") {
                        setAlive(true);
                        sendResize();
                    } else if (msg.type === "terminal.none") {
                        setAlive(false);
                    } else if (msg.type === "terminal.exited") {
                        setAlive(false);
                    }
                } catch { /* ignore */ }
            };

            ws.onclose = () => {
                ws = null;
                if (disposed) return;
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    retryDelay = Math.min(retryDelay * 1.5, 10000);
                    connect();
                }, retryDelay);
            };

            ws.onerror = () => {};
        }

        connect();

        const resizeObserver = new ResizeObserver(() => {
            fitAddon.fit();
            sendResize();
        });
        resizeObserver.observe(containerRef.current);

        // ── Touch scroll support (xterm.js v6 has no built-in touch scroll) ──
        let touchStartY: number | null = null;
        const cellHeight = () => term.options.lineHeight! * term.options.fontSize!;

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 1) {
                touchStartY = e.touches[0].clientY;
            }
        };
        const onTouchMove = (e: TouchEvent) => {
            if (touchStartY === null || e.touches.length !== 1) return;
            const dy = touchStartY - e.touches[0].clientY;
            const lines = Math.trunc(dy / cellHeight());
            if (lines !== 0) {
                term.scrollLines(lines);
                touchStartY = e.touches[0].clientY;
            }
            e.preventDefault();
        };
        const onTouchEnd = () => { touchStartY = null; };

        const xtermEl = containerRef.current;
        xtermEl.addEventListener("touchstart", onTouchStart, { passive: true });
        xtermEl.addEventListener("touchmove", onTouchMove, { passive: false });
        xtermEl.addEventListener("touchend", onTouchEnd);

        return () => {
            disposed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            resizeObserver.disconnect();
            xtermEl.removeEventListener("touchstart", onTouchStart);
            xtermEl.removeEventListener("touchmove", onTouchMove);
            xtermEl.removeEventListener("touchend", onTouchEnd);
            if (ws) ws.close();
            term.dispose();
            termRef.current = null;
            fitRef.current = null;
        };
    }, [sessionId]);

    return (
        <div className="terminal-tab">
            <div
                ref={containerRef}
                className="terminal-xterm"
                style={{ display: alive ? "block" : "none" }}
            />
            {alive === false && (
                <div className="terminal-empty">
                    <TerminalIcon size={36} />
                    <p>终端未启动</p>
                </div>
            )}
        </div>
    );
}

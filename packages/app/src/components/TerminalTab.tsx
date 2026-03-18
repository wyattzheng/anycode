import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
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
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            theme: {
                background: "#1e1e1e",
                foreground: "#d4d4d4",
                cursor: "#d4d4d4",
                selectionBackground: "rgba(255, 255, 255, 0.2)",
                black: "#1e1e1e",
                red: "#f14c4c",
                green: "#89d185",
                yellow: "#cca700",
                blue: "#0078d4",
                magenta: "#c586c0",
                cyan: "#4ec9b0",
                white: "#d4d4d4",
                brightBlack: "#858585",
                brightRed: "#f14c4c",
                brightGreen: "#89d185",
                brightYellow: "#cca700",
                brightBlue: "#0078d4",
                brightMagenta: "#c586c0",
                brightCyan: "#4ec9b0",
                brightWhite: "#ffffff",
            },
            cursorBlink: true,
            scrollback: 5000,
            allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current);
        fitAddon.fit();

        termRef.current = term;
        fitRef.current = fitAddon;

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

            const protocol = location.protocol === "https:" ? "wss:" : "ws:";
            ws = new WebSocket(
                `${protocol}//${location.host}/terminal?sessionId=${sessionId}`
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

        const inputDisposable = term.onData((data) => {
            if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "terminal.input", data }));
            }
        });

        const resizeObserver = new ResizeObserver(() => {
            fitAddon.fit();
            sendResize();
        });
        resizeObserver.observe(containerRef.current);

        return () => {
            disposed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            resizeObserver.disconnect();
            inputDisposable.dispose();
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
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-dim)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
                        <polyline points="4 17 10 11 4 5" />
                        <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                    <p>终端未启动</p>
                </div>
            )}
        </div>
    );
}

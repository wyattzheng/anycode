import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getWsUrl } from "../serverUrl";

const TERMINAL_OPTIONS: ConstructorParameters<typeof Terminal>[0] = {
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
    disableStdin: true,
};

export type AliveState = boolean | null;

/**
 * TerminalClient — manages xterm.js instance, WebSocket connection, and sync lifecycle.
 *
 * Handles:
 * - Terminal instance creation / destroy-on-sync
 * - WebSocket auto-reconnect
 * - Snapshot sync (destroy + recreate terminal)
 * - Live output streaming
 * - Resize propagation (client → server)
 * - Touch scroll support
 */
export class TerminalClient {
    private term: Terminal;
    private fitAddon: FitAddon;
    private container: HTMLElement;

    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private retryDelay = 1000;
    private disposed = false;
    private sessionId: string;

    private resizeObserver: ResizeObserver;
    private touchStartY: number | null = null;
    private lastSentCols = 0;
    private lastSentRows = 0;

    onAliveChange: ((alive: AliveState) => void) | null = null;

    constructor(container: HTMLElement, sessionId: string) {
        this.container = container;
        this.sessionId = sessionId;

        // Create initial terminal
        this.term = this.createTerminal();
        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.term.open(container);
        this.fitAddon.fit();

        // Resize observer
        this.resizeObserver = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            if (width === 0 || height === 0) return;
            this.fitAddon.fit();
            this.sendResize();
        });
        this.resizeObserver.observe(container);

        // Touch scroll
        container.addEventListener("touchstart", this.onTouchStart, { passive: true });
        container.addEventListener("touchmove", this.onTouchMove, { passive: false });
        container.addEventListener("touchend", this.onTouchEnd);

        // Connect WebSocket
        this.connect();
    }

    /** Tear down everything */
    dispose(): void {
        this.disposed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.resizeObserver.disconnect();
        this.container.removeEventListener("touchstart", this.onTouchStart);
        this.container.removeEventListener("touchmove", this.onTouchMove);
        this.container.removeEventListener("touchend", this.onTouchEnd);
        if (this.ws) this.ws.close();
        this.term.dispose();
    }

    // ── Terminal lifecycle ───────────────────────────────────────────────

    private createTerminal(): Terminal {
        return new Terminal(TERMINAL_OPTIONS);
    }

    /** Destroy current terminal, create fresh one, write snapshot */
    private applySync(data?: string): void {
        this.term.dispose();
        this.term = this.createTerminal();
        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.term.open(this.container);
        if (data) this.term.write(data);
        this.fitAddon.fit();
    }

    // ── WebSocket ────────────────────────────────────────────────────────

    private sendResize(): void {
        const { cols, rows } = this.term;
        if (cols === this.lastSentCols && rows === this.lastSentRows) return;
        this.lastSentCols = cols;
        this.lastSentRows = rows;
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "terminal.resize", cols, rows }));
        }
    }

    private connect(): void {
        if (this.disposed) return;

        this.ws = new WebSocket(
            getWsUrl(`/terminal?sessionId=${this.sessionId}`)
        );

        this.ws.onopen = () => {
            this.retryDelay = 1000;
            this.sendResize();
        };

        this.ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === "terminal.sync") {
                    this.applySync(msg.data);
                } else if (msg.type === "terminal.output") {
                    this.term.write(msg.data);
                } else if (msg.type === "terminal.ready") {
                    this.onAliveChange?.(true);
                    this.sendResize();
                } else if (msg.type === "terminal.none") {
                    this.onAliveChange?.(false);
                } else if (msg.type === "terminal.exited") {
                    this.onAliveChange?.(false);
                }
            } catch { /* ignore */ }
        };

        this.ws.onclose = () => {
            this.ws = null;
            if (this.disposed) return;
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.retryDelay = Math.min(this.retryDelay * 1.5, 10000);
                this.connect();
            }, this.retryDelay);
        };

        this.ws.onerror = () => {};
    }

    // ── Touch scroll ─────────────────────────────────────────────────────

    private cellHeight(): number {
        return this.term.options.lineHeight! * this.term.options.fontSize!;
    }

    private onTouchStart = (e: TouchEvent): void => {
        if (e.touches.length === 1) {
            this.touchStartY = e.touches[0].clientY;
        }
    };

    private onTouchMove = (e: TouchEvent): void => {
        if (this.touchStartY === null || e.touches.length !== 1) return;
        const dy = this.touchStartY - e.touches[0].clientY;
        const lines = Math.trunc(dy / this.cellHeight());
        if (lines !== 0) {
            this.term.scrollLines(lines);
            this.touchStartY = e.touches[0].clientY;
        }
        e.preventDefault();
    };

    private onTouchEnd = (): void => {
        this.touchStartY = null;
    };
}

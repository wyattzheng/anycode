// ── Channel abstraction ─────────────────────────────────────────────────────
// WebSocket-based real-time bidirectional communication.

export interface Channel {
    send(data: any): void;
    close(): void;
    onopen: (() => void) | null;
    onmessage: ((data: any) => void) | null;
    onclose: (() => void) | null;
    readonly readyState: number;
}

export const ReadyState = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
} as const;

// ── WebSocket implementation ────────────────────────────────────────────────

export class WebSocketChannel implements Channel {
    private ws: WebSocket;
    onopen: (() => void) | null = null;
    onmessage: ((data: any) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(url: string) {
        this.ws = new WebSocket(url);
        this.ws.onopen = () => this.onopen?.();
        this.ws.onmessage = (e) => {
            try { this.onmessage?.(JSON.parse(e.data)); } catch { /* ignore */ }
        };
        this.ws.onclose = () => this.onclose?.();
        this.ws.onerror = () => {};
    }

    get readyState() { return this.ws.readyState; }

    send(data: any) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    close() { this.ws.close(); }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createChannel(sessionId: string): Channel {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocketChannel(`${protocol}//${location.host}/?sessionId=${sessionId}`);
}

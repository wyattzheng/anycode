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
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private lastReceived = Date.now();
    onopen: (() => void) | null = null;
    onmessage: ((data: any) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(url: string) {
        this.ws = new WebSocket(url);
        this.ws.onopen = () => {
            this.startHeartbeat();
            this.onopen?.();
        };
        this.ws.onmessage = (e) => {
            this.lastReceived = Date.now();
            try {
                const data = JSON.parse(e.data);
                if (data.type === "pong") return; // swallow pong responses
                this.onmessage?.(data);
            } catch { /* ignore */ }
        };
        this.ws.onclose = () => {
            this.stopHeartbeat();
            this.onclose?.();
        };
        this.ws.onerror = () => {};
    }

    get readyState() { return this.ws.readyState; }

    send(data: any) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    close() {
        this.stopHeartbeat();
        this.ws.close();
    }

    private startHeartbeat() {
        this.lastReceived = Date.now();
        this.heartbeatTimer = setInterval(() => {
            // If no message in 10s, server is probably dead — force reconnect
            if (Date.now() - this.lastReceived > 10_000) {
                this.ws.close();
                return;
            }
            this.send({ type: "ping" });
        }, 5_000);
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}

import { getWsUrl } from "./serverUrl";

export function createChannel(sessionId: string): Channel {
    return new WebSocketChannel(getWsUrl(`/?sessionId=${sessionId}`));
}

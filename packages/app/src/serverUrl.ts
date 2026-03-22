// ── Server URL configuration ─────────────────────────────────────────────
// Manages the remote server URL for Capacitor (native app) and web modes.
// In web mode (served by the server itself), baseURL is empty → relative URLs.
// In Capacitor mode, user configures the server address (e.g. "https://test.anycoder.io").

const STORAGE_KEY = "anycode_server_url";

export function getServerUrl(): string {
    return localStorage.getItem(STORAGE_KEY) ?? "";
}

export function setServerUrl(url: string) {
    // Normalize: remove trailing slash
    const normalized = url.replace(/\/+$/, "");
    localStorage.setItem(STORAGE_KEY, normalized);
}

/** HTTP API base, e.g. "https://test.anycoder.io" or "" */
export function getApiBase(): string {
    return getServerUrl();
}

/** WebSocket base URL, e.g. "wss://test.anycoder.io" or "wss://currenthost" */
export function getWsUrl(path: string): string {
    const server = getServerUrl();
    if (server) {
        // Convert http(s) URL to ws(s)
        const wsUrl = server.replace(/^http/, "ws");
        return `${wsUrl}${path}`;
    }
    // Fallback: use current host (web mode)
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}${path}`;
}

export function isConfigured(): boolean {
    return getServerUrl() !== "";
}

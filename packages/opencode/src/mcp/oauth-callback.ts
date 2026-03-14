/**
 * MCP OAuth Callback stub — removed (OAuth not needed in agent mode).
 */
export namespace McpOAuthCallback {
  export async function ensureRunning(): Promise<void> {}
  export function waitForCallback(_state: any): Promise<any> { return new Promise(() => {}) }
  export function cancelPending(_mcpName: string): void {}
}

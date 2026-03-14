/**
 * MCP Auth stub — original mcp/auth.ts removed (OAuth not needed in agent mode).
 * No-op implementations for all McpAuth functions.
 */
export namespace McpAuth {
  export async function get(_mcpName: string): Promise<any> { return undefined }
  export async function remove(_mcpName: string): Promise<void> {}
  export async function updateOAuthState(_mcpName: string, _state: any): Promise<void> {}
  export async function getOAuthState(_mcpName: string): Promise<any> { return undefined }
  export async function clearOAuthState(_mcpName: string): Promise<void> {}
  export async function clearCodeVerifier(_mcpName: string): Promise<void> {}
  export async function isTokenExpired(_mcpName: string): Promise<boolean> { return true }
}

/**
 * MCP stub — original mcp/ module removed (MCP support not needed in agent mode).
 * No-op implementations for functions used by command/ and session/prompt.
 */
export namespace MCP {
  /** No MCP tools available */
  export async function tools(): Promise<Record<string, any>> { return {} }

  /** No MCP prompts available */
  export async function prompts(): Promise<Record<string, any>> { return {} }

  /** No-op prompt fetch */
  export async function getPrompt(_name: string, ..._args: any[]): Promise<any> { return undefined }

  /** No-op resource read */
  export async function readResource(_clientName: string, _uri: string): Promise<string> { return "" }
}

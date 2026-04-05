import z from "zod"
import { Tool } from "@any-code/agent"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const PROJECT_REQUIRED_ERROR = "No watched project is set. Call set_user_watch_project with an absolute project directory before using set_preview_url."

function parseLocalPreviewUrl(value: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Preview URL must be an absolute URL, got "${value}".`)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Preview URL must start with http:// or https://, got "${value}".`)
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Preview URL must use a localhost loopback host. Use something like "http://localhost:5173", got "${value}".`,
    )
  }

  if (!parsed.port) {
    throw new Error(`Preview URL must include an explicit port, got "${value}".`)
  }

  return parsed
}

const DESCRIPTION = `Set the preview URL for the user's preview panel.

This tool configures a reverse proxy so the user can preview a locally running web application directly in the IDE's preview tab. A dedicated preview port on the server proxies all requests to the given local URL.

## Parameters
- **forwarded_local_url**: The absolute local URL to reverse-proxy to. It must use a localhost loopback host with an explicit port, such as "http://localhost:5173".

## Usage notes
- Requires an active watched project. If no project is open in the UI yet, call set_user_watch_project first.
- Use this after starting a local dev server (e.g. via user_watch_terminal) to let the user see the result.
- Only pass localhost loopback URLs. Do not pass public domains, LAN IPs, or 0.0.0.0.
- The preview tab will automatically load the proxied page.
- Calling this again will update the target and refresh the preview.
`

export const SetPreviewUrlTool = Tool.define("set_preview_url", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      forwarded_local_url: z
        .string()
        .describe('Absolute localhost URL to reverse-proxy to (for example "http://localhost:5173").'),
    }),
    async execute(params, ctx) {
      const worktree = typeof ctx.worktree === "string" ? ctx.worktree.trim() : ""
      if (!worktree) throw new Error(PROJECT_REQUIRED_ERROR)

      const parsed = parseLocalPreviewUrl(params.forwarded_local_url)
      ctx.preview.setPreviewTarget(parsed.toString())

      return {
        title: `Preview → ${parsed.toString()}`,
        metadata: {
          forwarded_local_url: parsed.toString(),
        },
        output: `Preview proxy set to "${parsed.toString()}". The user's preview tab will load this automatically.`,
      }
    },
  }
})

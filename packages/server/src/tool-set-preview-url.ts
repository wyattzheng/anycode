import z from "zod"
import { Tool } from "@any-code/agent"
const DESCRIPTION = `Set the preview URL for the user's preview panel.

This tool configures a reverse proxy so the user can preview a locally running web application directly in the IDE's preview tab. A dedicated preview port on the server proxies all requests to the given local URL.

## Parameters
- **forwarded_local_url**: The absolute local URL to reverse-proxy to (e.g. "http://localhost:5173" for Vite, "http://localhost:3000" for React).

## Usage notes
- Use this after starting a local dev server (e.g. via terminal) to let the user see the result.
- The preview tab will automatically load the proxied page.
- Calling this again will update the target and refresh the preview.
`

export const SetPreviewUrlTool = Tool.define("set_preview_url", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      forwarded_local_url: z
        .string()
        .describe('The absolute local URL to reverse-proxy to (e.g. "http://localhost:5173").'),
    }),
    async execute(params, ctx) {
      ctx.preview.setPreviewTarget(params.forwarded_local_url)

      return {
        title: `Preview → ${params.forwarded_local_url}`,
        metadata: {
          forwarded_local_url: params.forwarded_local_url,
        },
        output: `Preview proxy set to "${params.forwarded_local_url}". The user's preview tab will load this automatically.`,
      }
    },
  }
})

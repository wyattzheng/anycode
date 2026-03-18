import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./set-preview-url.txt"

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

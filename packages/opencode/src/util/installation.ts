/**
 * Installation stub module — original installation/ was removed during agent-mode cleanup.
 * Provides VERSION/CHANNEL/USER_AGENT constants used throughout the codebase.
 */
import z from "zod"
import { BusEvent } from "@/agent/bus"
import { Flag } from "../util/flag"

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export namespace Installation {
  export const VERSION = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
  export const CHANNEL = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
  export const USER_AGENT = `opencode/${CHANNEL}/${VERSION}/${Flag.OPENCODE_CLIENT}`

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export const Info = z.object({
    version: z.string(),
    latest: z.string(),
  }).meta({ ref: "InstallationInfo" })
  export type Info = z.infer<typeof Info>
}

import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { Snapshot } from "../snapshot"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Log } from "../util/log"

import { Storage } from "@/storage"
import { Bus } from "../bus"
import { SessionPrompt } from "./session"
import { SessionSummary } from "./summary"

export namespace SessionRevert {
  const log = Log.create({ service: "session.revert" })

  export const RevertInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
    partID: PartID.zod.optional(),
  })
  export type RevertInput = z.infer<typeof RevertInput>

  export async function revert(input: RevertInput, context: import("../agent/context").AgentContext) {
    SessionPrompt.assertNotBusy(context, input.sessionID)
    const all = await Session.messages(context, { sessionID: input.sessionID })
    let lastUser: MessageV2.User | undefined
    const session = await Session.get(context, input.sessionID)

    let revert: Session.Info["revert"]
    const patches: Snapshot.Patch[] = []
    for (const msg of all) {
      if (msg.info.role === "user") lastUser = msg.info
      const remaining = []
      for (const part of msg.parts) {
        if (revert) {
          if (part.type === "patch") {
            patches.push(part)
          }
          continue
        }

        if (!revert) {
          if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
            // if no useful parts left in message, same as reverting whole message
            const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
            revert = {
              messageID: !partID && lastUser ? lastUser.id : msg.info.id,
              partID,
            }
          }
          remaining.push(part)
        }
      }
    }

    if (revert) {
      const session = await Session.get(context, input.sessionID)
      revert.snapshot = session.revert?.snapshot ?? (await Snapshot.track(context))
      await Snapshot.revert(context, patches)
      if (revert.snapshot) revert.diff = await Snapshot.diff(context, revert.snapshot)
      const rangeMessages = all.filter((msg) => msg.info.id >= revert!.messageID)
      const diffs = await SessionSummary.computeDiff(context, { messages: rangeMessages })
      await Storage.write(context, ["session_diff", input.sessionID], diffs)
      Bus.publish(context, Session.Event.Diff, {
        sessionID: input.sessionID,
        diff: diffs,
      })
      return Session.setRevert(context, {
        sessionID: input.sessionID,
        revert,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
    }
    return session
  }

  export async function unrevert(input: { sessionID: SessionID }, context: import("../agent/context").AgentContext) {
    log.info("unreverting", input)
    SessionPrompt.assertNotBusy(context, input.sessionID)
    const session = await Session.get(context, input.sessionID)
    if (!session.revert) return session
    if (session.revert.snapshot) await Snapshot.restore(context, session.revert.snapshot)
    return Session.clearRevert(context, input.sessionID)
  }

  export async function cleanup(context: import("../agent/context").AgentContext, session: Session.Info) {
    if (!session.revert) return
    const sessionID = session.id
    const msgs = await Session.messages(context, { sessionID })
    const messageID = session.revert.messageID
    const preserve = [] as MessageV2.WithParts[]
    const remove = [] as MessageV2.WithParts[]
    let target: MessageV2.WithParts | undefined
    for (const msg of msgs) {
      if (msg.info.id < messageID) {
        preserve.push(msg)
        continue
      }
      if (msg.info.id > messageID) {
        remove.push(msg)
        continue
      }
      if (session.revert.partID) {
        preserve.push(msg)
        target = msg
        continue
      }
      remove.push(msg)
    }
    for (const msg of remove) {
      context.db.remove("message", { op: "eq", field: "id", value: msg.info.id })
      await Bus.publish(undefined, MessageV2.Event.Removed, { sessionID: sessionID, messageID: msg.info.id })
    }
    if (session.revert.partID && target) {
      const partID = session.revert.partID
      const removeStart = target.parts.findIndex((part) => part.id === partID)
      if (removeStart >= 0) {
        const preserveParts = target.parts.slice(0, removeStart)
        const removeParts = target.parts.slice(removeStart)
        target.parts = preserveParts
        for (const part of removeParts) {
          context.db.remove("part", { op: "eq", field: "id", value: part.id })
          await Bus.publish(undefined, MessageV2.Event.PartRemoved, {
            sessionID: sessionID,
            messageID: target.info.id,
            partID: part.id,
          })
        }
      }
    }
    await Session.clearRevert(context, sessionID)
  }
}

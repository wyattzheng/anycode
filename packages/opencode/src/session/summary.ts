import { fn } from "@/util/fn"
import z from "zod"
import { Session } from "."

import { MessageV2 } from "./message-v2"
import { Identifier } from "@/util/id"
import { SessionID, MessageID } from "./schema"
import { Snapshot } from "@/snapshot"

import { Storage } from "@/storage"
import { Bus } from "@/bus"
import type { AgentContext } from "@/agent/context"

export namespace SessionSummary {
  function unquoteGitPath(input: string) {
    if (!input.startsWith('"')) return input
    if (!input.endsWith('"')) return input
    const body = input.slice(1, -1)
    const bytes: number[] = []

    for (let i = 0; i < body.length; i++) {
      const char = body[i]!
      if (char !== "\\") {
        bytes.push(char.charCodeAt(0))
        continue
      }

      const next = body[i + 1]
      if (!next) {
        bytes.push("\\".charCodeAt(0))
        continue
      }

      if (next >= "0" && next <= "7") {
        const chunk = body.slice(i + 1, i + 4)
        const match = chunk.match(/^[0-7]{1,3}/)
        if (!match) {
          bytes.push(next.charCodeAt(0))
          i++
          continue
        }
        bytes.push(parseInt(match[0], 8))
        i += match[0].length
        continue
      }

      const escaped =
        next === "n"
          ? "\n"
          : next === "r"
            ? "\r"
            : next === "t"
              ? "\t"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next === "v"
                    ? "\v"
                    : next === "\\" || next === '"'
                      ? next
                      : undefined

      bytes.push((escaped ?? next).charCodeAt(0))
      i++
    }

    return Buffer.from(bytes).toString()
  }

  export async function summarize(context: AgentContext, input: { sessionID: SessionID; messageID: MessageID }) {
    const all = await Session.messages(context, { sessionID: input.sessionID })
    await Promise.all([
      summarizeSession(context, { sessionID: input.sessionID, messages: all }),
      summarizeMessage(context, { messageID: input.messageID, messages: all }),
    ])
  }

  async function summarizeSession(context: AgentContext, input: { sessionID: SessionID; messages: MessageV2.WithParts[] }) {
    const diffs = await computeDiff(context, { messages: input.messages })
    await Session.setSummary(context, {
      sessionID: input.sessionID,
      summary: {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      },
    })
    await Storage.write(context, ["session_diff", input.sessionID], diffs)
    Bus.publish(context, Session.Event.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
  }

  async function summarizeMessage(context: AgentContext, input: { messageID: string; messages: MessageV2.WithParts[] }) {
    const messages = input.messages.filter(
      (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
    )
    const msgWithParts = messages.find((m) => m.info.id === input.messageID)!
    const userMsg = msgWithParts.info as MessageV2.User
    const diffs = await computeDiff(context, { messages })
    userMsg.summary = {
      ...userMsg.summary,
      diffs,
    }
    await Session.updateMessage(context, userMsg)
  }

  export async function diff(context: AgentContext, input: { sessionID: SessionID; messageID?: MessageID }) {
    const diffs = await Storage.read<Snapshot.FileDiff[]>(context, ["session_diff", input.sessionID]).catch(() => [])
    const next = diffs.map((item) => {
      const file = unquoteGitPath(item.file)
      if (file === item.file) return item
      return {
        ...item,
        file,
      }
    })
    const changed = next.some((item, i) => item.file !== diffs[i]?.file)
    if (changed) Storage.write(context, ["session_diff", input.sessionID], next).catch(() => {})
    return next
  }

  export async function computeDiff(context: AgentContext, input: { messages: MessageV2.WithParts[] }) {
    let from: string | undefined
    let to: string | undefined

    // scan assistant messages to find earliest from and latest to
    // snapshot
    for (const item of input.messages) {
      if (!from) {
        for (const part of item.parts) {
          if (part.type === "step-start" && part.snapshot) {
            from = part.snapshot
            break
          }
        }
      }

      for (const part of item.parts) {
        if (part.type === "step-finish" && part.snapshot) {
          to = part.snapshot
        }
      }
    }

    if (from && to) return Snapshot.diffFull(context, from, to)
    return []
  }
}

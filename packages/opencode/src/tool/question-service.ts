import type { AgentContext } from "@/agent/context"
import { Bus } from "@/agent/bus"
import { BusEvent } from "@/agent/bus"
import { SessionID, MessageID } from "@/agent/session/schema"
import { Schema } from "effect"

import { Log } from "@/util/log"
import z from "zod"
import { Identifier } from "@/util/id"
import { withStatics } from "@/util/schema"

const questionIdSchema = Schema.String.pipe(Schema.brand("QuestionID"))

export type QuestionID = typeof questionIdSchema.Type

export const QuestionID = questionIdSchema.pipe(
  withStatics((schema: typeof questionIdSchema) => ({
    make: (id: string) => schema.makeUnsafe(id),
    ascending: (id?: string) => schema.makeUnsafe(Identifier.ascending("question", id)),
    zod: Identifier.schema("question").pipe(z.custom<QuestionID>()),
  })),
)

export namespace Question {
  const log = Log.create({ service: "question" })

  export const Option = z
    .object({
      label: z.string().describe("Display text (1-5 words, concise)"),
      description: z.string().describe("Explanation of choice"),
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  export const Info = z
    .object({
      question: z.string().describe("Complete question"),
      header: z.string().describe("Very short label (max 30 chars)"),
      options: z.array(Option).describe("Available choices"),
      multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
      custom: z.boolean().optional().describe("Allow typing a custom answer (default: true)"),
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Request = z
    .object({
      id: QuestionID.zod,
      sessionID: SessionID.zod,
      questions: z.array(Info).describe("Questions to ask"),
      tool: z
        .object({
          messageID: MessageID.zod,
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Answer = z.array(z.string()).meta({
    ref: "QuestionAnswer",
  })
  export type Answer = z.infer<typeof Answer>

  export const Reply = z.object({
    answers: z
      .array(Answer)
      .describe("User answers in order of questions (each answer is an array of selected labels)"),
  })
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("question.asked", Request),
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: SessionID.zod,
        requestID: QuestionID.zod,
        answers: z.array(Answer),
      }),
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: SessionID.zod,
        requestID: QuestionID.zod,
      }),
    ),
  }

  interface PendingEntry {
    info: Request
    resolve: (answers: Answer[]) => void
    reject: (e: any) => void
  }

  /**
   * QuestionService — manages pending questions awaiting user answers.
   */
  export class QuestionService {
    readonly pending = new Map<QuestionID, PendingEntry>()
    private context!: AgentContext

    bind(context: AgentContext) {
      this.context = context
    }

    async ask(input: { sessionID: SessionID; questions: Info[]; tool?: { messageID: MessageID; callID: string } }) {
      const id = QuestionID.ascending()
      return new Promise<Answer[]>((resolve, reject) => {
        const info: Request = { ...input, id }
        this.pending.set(id, { info, resolve, reject })
        Bus.publish(this.context, Event.Asked, info)
      })
    }

    async reply(input: { requestID: QuestionID; answers: Answer[] }) {
      const existing = this.pending.get(input.requestID)
      if (!existing) return
      this.pending.delete(input.requestID)
      Bus.publish(this.context, Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: input.answers,
      })
      existing.resolve(input.answers)
    }

    async reject(requestID: QuestionID) {
      const existing = this.pending.get(requestID)
      if (!existing) return
      this.pending.delete(requestID)
      Bus.publish(this.context, Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      existing.reject(new RejectedError())
    }

    list() {
      return Array.from(this.pending.values(), (x) => x.info)
    }
  }

  /** User rejected a question — halts execution */
  export class RejectedError extends Error {
    constructor() {
      super(`The user rejected the question.`)
    }
  }
}

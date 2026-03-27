import type { AgentContext } from "../context"
import * as path from "../util/path"
import { Flag } from "../util/flag"
import { ModelInfoService, type ModelsDatabase, type ProviderInfo, type ModelInfo, refreshModels } from "@any-code/model-info"

export type { ModelsDatabase, ProviderInfo, ModelInfo }

export namespace ModelsDev {
  export type Model = ModelInfo
  export type Provider = ProviderInfo

  export function filepath(context: AgentContext) {
    return path.join(context.dataPath, "models.json")
  }

  export class ModelsDevService {
    readonly _promise: Promise<{ data: Record<string, unknown> }>

    constructor(context: AgentContext) {
      const svc = new ModelInfoService({
        url: Flag.OPENCODE_MODELS_URL,
        disableFetch: Flag.OPENCODE_DISABLE_MODELS_FETCH,
        readCache: () => context.fs.readJson(Flag.OPENCODE_MODELS_PATH ?? filepath(context)).catch((): undefined => undefined),
      })
      this._promise = svc.ready.then(data => ({ data: data as Record<string, unknown> }))
    }
  }

  export async function get(context: AgentContext) {
    const s = await context.modelsDev._promise
    return s.data as Record<string, Provider>
  }

  export async function refresh(context: AgentContext) {
    try {
      await refreshModels({
        url: Flag.OPENCODE_MODELS_URL,
        writeCache: async (data) => {
          await context.fs.write(filepath(context), JSON.stringify(data))
        },
      })
    } catch (e) {
      context.log.create({ service: "models.dev" }).warn("Failed to refresh models", { error: e })
    }
  }
}

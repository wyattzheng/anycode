/**
 * SSE fixtures: Subagent (task tool) flow
 *
 * Round 1 (main): Model calls "task" tool with subagent_type "explore"
 * Round 2 (subagent): Explore agent runs inside task tool — needs text response
 * Round 3 (main): Model receives task result, generates confirmation
 */

const TASK_DESCRIPTION = "Search for config files"
const TASK_PROMPT = "Find all configuration files in the project"
const SUBAGENT_TYPE = "explore"

const SUBAGENT_RESPONSE = "I found 3 configuration files: package.json, tsconfig.json, vitest.config.ts"
const CONFIRMATION_TEXT = "子 agent 完成了搜索任务，共找到 3 个配置文件。"

export function buildSubagentFixtures() {
    const args = JSON.stringify({
        description: TASK_DESCRIPTION,
        prompt: TASK_PROMPT,
        subagent_type: SUBAGENT_TYPE,
    })
    const escaped = JSON.stringify(args).slice(1, -1)

    // Round 1: Main agent calls task tool
    const taskCallBody = [
        `data: {"type":"response.created","response":{"id":"resp_sub001","object":"response","created_at":1700000000,"model":"gpt-4o","status":"in_progress","output":[]}}\n\n`,
        `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_sub01","call_id":"call_sub_01","name":"task","arguments":"","status":"in_progress"}}\n\n`,
        `data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_sub01","delta":"${escaped}"}\n\n`,
        `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_sub01","call_id":"call_sub_01","name":"task","arguments":"${escaped}","status":"completed"}}\n\n`,
        `data: {"type":"response.completed","response":{"id":"resp_sub001","object":"response","created_at":1700000000,"model":"gpt-4o","status":"completed","output":[{"type":"function_call","id":"fc_sub01","call_id":"call_sub_01","name":"task","arguments":"${escaped}","status":"completed"}],"usage":{"input_tokens":100,"output_tokens":40,"total_tokens":140,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
    ].join("")

    // Round 2: Subagent (explore) text response
    const subagentBody = [
        `data: {"type":"response.created","response":{"id":"resp_sub002","object":"response","created_at":1700000001,"model":"gpt-4o","status":"in_progress","output":[]}}\n\n`,
        `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_sub002","role":"assistant","content":[]}}\n\n`,
        `data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n`,
        `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_sub002","delta":"${SUBAGENT_RESPONSE}"}\n\n`,
        `data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"${SUBAGENT_RESPONSE}"}\n\n`,
        `data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"${SUBAGENT_RESPONSE}"}}\n\n`,
        `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_sub002","role":"assistant","content":[{"type":"output_text","text":"${SUBAGENT_RESPONSE}"}]}}\n\n`,
        `data: {"type":"response.completed","response":{"id":"resp_sub002","object":"response","created_at":1700000001,"model":"gpt-4o","status":"completed","output":[{"type":"message","id":"msg_sub002","role":"assistant","content":[{"type":"output_text","text":"${SUBAGENT_RESPONSE}"}]}],"usage":{"input_tokens":80,"output_tokens":50,"total_tokens":130,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
    ].join("")

    // Round 3: Main agent confirmation
    const confirmationBody = [
        `data: {"type":"response.created","response":{"id":"resp_sub003","object":"response","created_at":1700000002,"model":"gpt-4o","status":"in_progress","output":[]}}\n\n`,
        `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_sub003","role":"assistant","content":[]}}\n\n`,
        `data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n`,
        `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_sub003","delta":"${CONFIRMATION_TEXT}"}\n\n`,
        `data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"${CONFIRMATION_TEXT}"}\n\n`,
        `data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"${CONFIRMATION_TEXT}"}}\n\n`,
        `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_sub003","role":"assistant","content":[{"type":"output_text","text":"${CONFIRMATION_TEXT}"}]}}\n\n`,
        `data: {"type":"response.completed","response":{"id":"resp_sub003","object":"response","created_at":1700000002,"model":"gpt-4o","status":"completed","output":[{"type":"message","id":"msg_sub003","role":"assistant","content":[{"type":"output_text","text":"${CONFIRMATION_TEXT}"}]}],"usage":{"input_tokens":300,"output_tokens":30,"total_tokens":330,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
    ].join("")

    return { taskCallBody, subagentBody, confirmationBody }
}

export { SUBAGENT_RESPONSE, CONFIRMATION_TEXT, TASK_DESCRIPTION }

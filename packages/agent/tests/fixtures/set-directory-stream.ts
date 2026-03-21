/**
 * SSE fixtures: set_project_directory tool call flow
 * OpenAI Responses API format (/v1/responses)
 *
 * Round 1: Model calls "set_project_directory" tool with {directory: <path>}
 * Round 2: After tool result, model responds with confirmation text
 */

export function buildSetDirectoryFixtures(directory: string) {
    const args = JSON.stringify({ directory })
    const escaped = JSON.stringify(args).slice(1, -1)

    const CONFIRMATION_TEXT =
        `已将工作目录设置为 ${directory}。开发环境已就绪。`

    // ── Round 1: Model calls "set_project_directory" tool ─────────────
    const toolCallBody = [
        `data: {"type":"response.created","response":{"id":"resp_sd001","object":"response","created_at":1700000000,"model":"gpt-4o","status":"in_progress","output":[]}}\n\n`,
        `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_sd001","call_id":"call_setdir","name":"set_project_directory","arguments":"","status":"in_progress"}}\n\n`,
        `data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_sd001","delta":"${escaped}"}\n\n`,
        `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_sd001","call_id":"call_setdir","name":"set_project_directory","arguments":"${escaped}","status":"completed"}}\n\n`,
        `data: {"type":"response.completed","response":{"id":"resp_sd001","object":"response","created_at":1700000000,"model":"gpt-4o","status":"completed","output":[{"type":"function_call","id":"fc_sd001","call_id":"call_setdir","name":"set_project_directory","arguments":"${escaped}","status":"completed"}],"usage":{"input_tokens":80,"output_tokens":30,"total_tokens":110,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
    ].join("")

    // ── Round 2: Confirmation text ────────────────────────────────────
    const confirmationBody = [
        `data: {"type":"response.created","response":{"id":"resp_sd002","object":"response","created_at":1700000001,"model":"gpt-4o","status":"in_progress","output":[]}}\n\n`,
        `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_sd002","role":"assistant","content":[]}}\n\n`,
        `data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n`,
        `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_sd002","delta":"${CONFIRMATION_TEXT}"}\n\n`,
        `data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"${CONFIRMATION_TEXT}"}\n\n`,
        `data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"${CONFIRMATION_TEXT}"}}\n\n`,
        `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_sd002","role":"assistant","content":[{"type":"output_text","text":"${CONFIRMATION_TEXT}"}]}}\n\n`,
        `data: {"type":"response.completed","response":{"id":"resp_sd002","object":"response","created_at":1700000001,"model":"gpt-4o","status":"completed","output":[{"type":"message","id":"msg_sd002","role":"assistant","content":[{"type":"output_text","text":"${CONFIRMATION_TEXT}"}]}],"usage":{"input_tokens":150,"output_tokens":20,"total_tokens":170,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
    ].join("")

    return { toolCallBody, confirmationBody }
}

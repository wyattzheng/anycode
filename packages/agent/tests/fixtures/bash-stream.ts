/**
 * SSE fixtures: Bash tool execution flow
 * Model calls bash with a safe `echo` command.
 *
 * Round 1: Model calls "bash" tool with `echo hello`
 * Round 2: Confirmation text
 */

const BASH_COMMAND = "echo hello"
const BASH_DESCRIPTION = "Prints hello to stdout"

const CONFIRMATION_TEXT = "已执行 echo 命令，输出为 hello。"

export function buildBashFixtures() {
    const args = JSON.stringify({
        command: BASH_COMMAND,
        description: BASH_DESCRIPTION,
    })
    const escaped = JSON.stringify(args).slice(1, -1)

    const toolCallBody = [
        `data: {"type":"response.created","response":{"id":"resp_bash001","object":"response","created_at":1700000000,"model":"gpt-4o","status":"in_progress","output":[]}}\n\n`,
        `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_bash01","call_id":"call_bash_01","name":"bash","arguments":"","status":"in_progress"}}\n\n`,
        `data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_bash01","delta":"${escaped}"}\n\n`,
        `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_bash01","call_id":"call_bash_01","name":"bash","arguments":"${escaped}","status":"completed"}}\n\n`,
        `data: {"type":"response.completed","response":{"id":"resp_bash001","object":"response","created_at":1700000000,"model":"gpt-4o","status":"completed","output":[{"type":"function_call","id":"fc_bash01","call_id":"call_bash_01","name":"bash","arguments":"${escaped}","status":"completed"}],"usage":{"input_tokens":100,"output_tokens":30,"total_tokens":130,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
    ].join("")

    const confirmationBody = [
        `data: {"type":"response.created","response":{"id":"resp_bash002","object":"response","created_at":1700000001,"model":"gpt-4o","status":"in_progress","output":[]}}\n\n`,
        `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_bash002","role":"assistant","content":[]}}\n\n`,
        `data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n`,
        `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_bash002","delta":"${CONFIRMATION_TEXT}"}\n\n`,
        `data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"${CONFIRMATION_TEXT}"}\n\n`,
        `data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"${CONFIRMATION_TEXT}"}}\n\n`,
        `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_bash002","role":"assistant","content":[{"type":"output_text","text":"${CONFIRMATION_TEXT}"}]}}\n\n`,
        `data: {"type":"response.completed","response":{"id":"resp_bash002","object":"response","created_at":1700000001,"model":"gpt-4o","status":"completed","output":[{"type":"message","id":"msg_bash002","role":"assistant","content":[{"type":"output_text","text":"${CONFIRMATION_TEXT}"}]}],"usage":{"input_tokens":200,"output_tokens":25,"total_tokens":225,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
    ].join("")

    return { toolCallBody, confirmationBody }
}

export { CONFIRMATION_TEXT }

/**
 * SSE fixture: tool call that triggers a custom "big_output" tool
 * Used to test truncateToolOutput through a full chat flow.
 */

// Round 1: Model calls big_output tool
export const BIG_TOOL_CALL_CHUNKS = [
    `data: {"type":"response.created","response":{"id":"resp_big001","object":"response","created_at":1700000000,"model":"gpt-4o","status":"in_progress","output":[]}}\n\n`,
    `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_big001","call_id":"call_big_output_001","name":"big_output","arguments":"","status":"in_progress"}}\n\n`,
    `data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_big001","delta":"{}"}\n\n`,
    `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_big001","call_id":"call_big_output_001","name":"big_output","arguments":"{}","status":"completed"}}\n\n`,
    `data: {"type":"response.completed","response":{"id":"resp_big001","object":"response","created_at":1700000000,"model":"gpt-4o","status":"completed","output":[{"type":"function_call","id":"fc_big001","call_id":"call_big_output_001","name":"big_output","arguments":"{}","status":"completed"}],"usage":{"input_tokens":50,"output_tokens":5,"total_tokens":55,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
]

// Round 2: After tool result, model responds with text
export const BIG_TOOL_RESULT_TEXT_CHUNKS = [
    `data: {"type":"response.created","response":{"id":"resp_big002","object":"response","created_at":1700000001,"model":"gpt-4o","status":"in_progress","output":[]}}\n\n`,
    `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_big002","role":"assistant","content":[]}}\n\n`,
    `data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n`,
    `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_big002","delta":"Done processing big output."}\n\n`,
    `data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Done processing big output."}\n\n`,
    `data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Done processing big output."}}\n\n`,
    `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_big002","role":"assistant","content":[{"type":"output_text","text":"Done processing big output."}]}}\n\n`,
    `data: {"type":"response.completed","response":{"id":"resp_big002","object":"response","created_at":1700000001,"model":"gpt-4o","status":"completed","output":[{"type":"message","id":"msg_big002","role":"assistant","content":[{"type":"output_text","text":"Done processing big output."}]}],"usage":{"input_tokens":200,"output_tokens":6,"total_tokens":206,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
]

export const BIG_TOOL_CALL_BODY = BIG_TOOL_CALL_CHUNKS.join("")
export const BIG_TOOL_RESULT_TEXT_BODY = BIG_TOOL_RESULT_TEXT_CHUNKS.join("")

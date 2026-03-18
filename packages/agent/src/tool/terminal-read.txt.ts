export default `Read the terminal output from the bottom of the buffer.

Returns the last N lines from the shared user terminal. Use this after sending a command via terminal_write to see its output.

## Parameters
- **length**: How many lines to read from the bottom. Start with a small number (e.g. 20-50) and increase if you need more context.
- **waitBefore**: Milliseconds to wait before reading. Use this to let a command finish producing output. Defaults to 0. Maximum is 5000ms (values above 5000 are clamped to 5000).

## Important
- In most cases, prefer the **bash** tool for running commands — it captures output directly without needing terminal_read.
- Use terminal_read when reading output from a persistent terminal session (e.g. a dev server for preview) started via terminal_write.

## Usage notes
- The terminal must exist (created via terminal_write type="create") before reading.
- If output looks truncated or the command hasn't finished, just call terminal_read again — the terminal is persistent.
- Lines are returned as plain text, one per line.
`

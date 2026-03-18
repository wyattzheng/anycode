export default `Set the preview URL for the user's preview panel.

This tool configures a reverse proxy so the user can preview a locally running web application directly in the IDE's preview tab. A dedicated preview port on the server proxies all requests to the given local URL.

## Parameters
- **forwarded_local_url**: The absolute local URL to reverse-proxy to (e.g. "http://localhost:5173" for Vite, "http://localhost:3000" for React).

## Usage notes
- Use this after starting a local dev server (e.g. via terminal_write) to let the user see the result.
- The preview tab will automatically load the proxied page.
- Calling this again will update the target and refresh the preview.
`

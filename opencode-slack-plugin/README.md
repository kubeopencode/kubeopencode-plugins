# opencode-slack-plugin

OpenCode plugin that connects to Slack via Socket Mode. Run it as part of your `opencode serve` process — zero port exposure, no separate bot process needed.

## Architecture

```
Your machine (MacBook / Linux / K8s Pod)
+----------------------------------------------+
|  opencode serve                               |
|    +-- plugins/                               |
|          +-- opencode-slack-plugin             |
|                |                              |
|                |  WebSocket (outbound only)    |
|                v                              |
|          Slack Socket Mode API                |
|                                               |
|          Zero ports exposed                   |
+----------------------------------------------+
```

- The plugin runs **inside** the OpenCode process
- Connects to Slack via **Socket Mode** (outbound WebSocket, no public URL)
- Each Slack thread maps to an independent OpenCode session
- Tool call progress and permission requests are forwarded to Slack in real time

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**
2. Enable **Socket Mode** (sidebar > Socket Mode > toggle ON)
   - Generate an App-Level Token with scope `connections:write`
   - Copy the `xapp-...` token — this is your `SLACK_APP_TOKEN`
3. Add **Bot Token Scopes** (sidebar > OAuth & Permissions > Scopes):
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`
   - `groups:history`
   - `im:history`
4. Subscribe to **Bot Events** (sidebar > Event Subscriptions > toggle ON):
   - `app_mention`
   - `message.im`
5. Enable **App Home** > Messages Tab (check "Allow users to send Slash commands and messages from the messages tab")
6. **Install to Workspace** and copy the `xoxb-...` Bot Token — this is your `SLACK_BOT_TOKEN`

### 2. Install the Plugin

#### From npm

Add to your `opencode.json`:

```json
{
  "plugin": ["@kubeopencode/opencode-slack-plugin"]
}
```

#### Local install

Copy the built output or the source file into your OpenCode plugins directory:

```bash
# Option A: copy source directly
cp src/index.ts ~/.config/opencode/plugins/opencode-slack.ts

# Option B: build and copy dist
npm run build
cp dist/index.js ~/.config/opencode/plugins/opencode-slack.js
```

Then add dependencies to `~/.config/opencode/package.json`:

```json
{
  "dependencies": {
    "@slack/socket-mode": "^2.0.5",
    "@slack/web-api": "^7.13.0"
  }
}
```

### 3. Configure Environment Variables

```bash
export SLACK_BOT_TOKEN=xoxb-your-bot-token
export SLACK_APP_TOKEN=xapp-your-app-token
```

### 4. Run OpenCode

**TUI mode** (interactive terminal — plugin loads automatically):

```bash
opencode
```

**Serve mode** (headless server — plugin loads on first request):

`opencode serve` uses lazy instance loading — plugins only initialize when
the first HTTP request arrives for a project directory. In KubeOpenCode,
the Kubernetes StartupProbe (`GET /session/status`) triggers this automatically.
For local testing, send a warmup request manually:

```bash
# Start the server
opencode serve &

# Send a warmup request to trigger plugin loading
sleep 1 && curl -s "http://127.0.0.1:4096/session/status?directory=$(pwd)" > /dev/null

# The server is now running with Slack connected.
# Look for "[slack-plugin] Slack Socket Mode connected" in the output.
```

The plugin activates automatically when both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set. If either is missing, the plugin silently skips initialization.

## Usage

- **DM the bot** directly for private conversations
- **@mention the bot** in a channel to start a threaded conversation
- Each Slack thread creates a separate OpenCode session with its own context

### Permission Requests

When OpenCode needs permission (e.g., to write a file), the request is forwarded to the Slack thread:

```
Permission Request
write file
Pattern: src/index.ts

1. Yes (once)
2. Always
3. No (reject)

Reply: 1/y/yes, 2/always, or 3/n/no
```

Reply with the corresponding number or keyword.

### Tool Updates

Completed tool calls are posted to the thread in real time:

```
*file_write* - wrote src/index.ts
*bash* - ran tests
```

## Debugging

### Log Locations

The plugin produces two categories of logs:

| Source | Location | Contents |
|--------|----------|----------|
| **OpenCode structured log** | `~/.local/share/opencode/log/` | Session lifecycle, LLM calls, tool execution, permission events, errors. File per startup, 10 most recent retained. |
| **Plugin console output** | OpenCode process stdout/stderr | `[slack-plugin]` prefixed messages: connection status, session creation, typing indicators, prompt results. |

To find the current log directory:

```bash
opencode debug paths   # prints all paths including "log"
```

On macOS the default is `~/.local/share/opencode/log/`. On Linux it follows `$XDG_DATA_HOME/opencode/log/`.

### Investigating a Failed Slack Message

When a Slack message gets no reply, follow this sequence:

**1. Find the session ID** — look for `[slack-plugin] Created session` in stdout, or find the session by thread timestamp:

```bash
grep "Slack thread" ~/.local/share/opencode/log/2026-05-08T*.log
```

**2. Trace the session in the structured log** — search for the session ID to see the full lifecycle:

```bash
grep "ses_XXXXX" ~/.local/share/opencode/log/2026-05-08T*.log
```

Key events to look for:

| Log entry | Meaning |
|-----------|---------|
| `service=session ... created` | Session was created successfully |
| `service=session.prompt step=0 loop` | LLM prompt loop started |
| `service=llm ... stream` | LLM call initiated |
| `service=llm ... stream error` | LLM call failed (check `error=` field) |
| `service=session.processor ... error=` | Processor crashed while handling LLM response |
| `service=session.prompt ... exiting loop` | Prompt completed normally |
| `service=permission ... evaluated` | Permission was auto-resolved or user-replied |

**3. Check for LLM provider errors** — filter for ERROR level:

```bash
grep "ERROR.*ses_XXXXX" ~/.local/share/opencode/log/2026-05-08T*.log
```

### Common Failure Modes

**Bot shows "is thinking..." but never replies:**

The plugin's `session.prompt()` returned data with no text parts. This happens when the LLM provider fails. Check the structured log for `stream error` — common causes:

- **OAuth token expired** (Google Vertex): `POST https://oauth2.googleapis.com/token` fails. Fix: `gcloud auth application-default login`
- **Proxy misconfiguration**: The LLM provider's HTTP client inherits `http_proxy`/`https_proxy` env vars. If your proxy is down, LLM calls fail silently.
- **Rate limiting**: Look for HTTP 429 in the error JSON.

**Bot creates a session but the second message in the thread is ignored:**

The thread requires `@mention` for each message in channel threads (by design — prevents capturing human-to-human conversation). DMs do not require `@mention`.

**"Session idle" appears in stdout but no Slack message:**

This means `session.prompt()` completed but returned empty text parts. Search the structured log for `ERROR` entries on that session ID to find the root cause.

### Enabling Verbose Logging

```bash
# Print logs to stderr instead of file (useful for local debugging)
opencode serve --print-logs

# Set log level to DEBUG for maximum detail
opencode serve --log-level DEBUG
```

## KubeOpenCode Integration

When running inside a KubeOpenCode Agent, the plugin additionally:

- **Heartbeat**: Patches the `kubeopencode.io/last-connection-active` annotation to prevent standby auto-suspend while Slack conversations are active
- **Graceful shutdown**: Disconnects cleanly when the OpenCode server is disposed

Deploy via the Agent spec:

```yaml
apiVersion: kubeopencode.io/v1alpha1
kind: Agent
metadata:
  name: my-agent
spec:
  plugins:
    - name: "opencode-slack-plugin"
  credentials:
    - secretRef:
        name: slack-credentials   # Secret with SLACK_BOT_TOKEN and SLACK_APP_TOKEN
```

The heartbeat requires `AGENT_NAME` and `AGENT_NAMESPACE` env vars (auto-injected by the controller) and a ServiceAccount with RBAC permission to patch Agent resources. If any of these are missing, heartbeat is silently disabled.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | App-Level Token for Socket Mode (`xapp-...`) |
| `AGENT_NAME` | No | KubeOpenCode Agent name (for heartbeat, auto-injected) |
| `AGENT_NAMESPACE` | No | KubeOpenCode Agent namespace (for heartbeat, auto-injected) |

## How It Differs from `@opencode-ai/slack`

| | This plugin | `@opencode-ai/slack` |
|---|---|---|
| Architecture | Runs inside OpenCode process | Separate Node.js process |
| Communication | Internal function calls (no HTTP) | HTTP to OpenCode server |
| Deployment | Just `opencode serve` | Must run bot + server separately |
| Port exposure | Zero | OpenCode server port (at least localhost) |
| Install | Add to `opencode.json` plugins | `bun run packages/slack` |
| K8s heartbeat | Yes (prevents standby auto-suspend) | No |
| Graceful shutdown | Yes (listens for server.instance.disposed) | No |

## License

MIT

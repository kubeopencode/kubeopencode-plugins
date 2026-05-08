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

#### From npm (once published)

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-slack-plugin"]
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

```bash
# Start the server
opencode serve &

# Send a warmup request to trigger plugin loading.
# opencode serve uses lazy instance loading — plugins only initialize
# when the first request arrives for a project directory.
# This curl triggers that initialization so Slack Socket Mode connects.
sleep 1 && curl -s http://127.0.0.1:4096/session?directory=$(pwd) > /dev/null

# The server is now running with Slack connected.
# Look for "[slack-plugin] Slack Socket Mode connected" in the output.
```

The plugin activates automatically when both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set. If either is missing, the plugin silently skips initialization.

## Usage

- **DM the bot** directly for private conversations
- **@mention the bot** in a channel to start a threaded conversation
- Each Slack thread creates a separate OpenCode session with its own context
- Session share links are posted automatically when a new thread starts

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

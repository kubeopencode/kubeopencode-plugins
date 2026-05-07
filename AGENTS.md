# Development Guidelines for kubeopencode-plugins

This repository contains officially supported OpenCode plugins for the [KubeOpenCode](https://github.com/kubeopencode/kubeopencode) project.

## Project Overview

**KubeOpenCode** is a Kubernetes-native AI Agent Platform that wraps [OpenCode](https://opencode.ai) with enterprise infrastructure — governance, RBAC, persistence, scheduling, and multi-tenant agent management. Agents run as Kubernetes Deployments with OpenCode as the coding engine inside each Pod.

**This repo** (`kubeopencode-plugins`) houses first-party plugins that extend Agent capabilities. Each plugin is an independent npm package that follows OpenCode's plugin API and can be installed into any Agent via `spec.plugins`.

> **IMPORTANT**: The OpenCode project source is at `../opencode/` and the KubeOpenCode project source is at `../kubeopencode/`. Always search local codebases before using web search.

## Key References

- **OpenCode plugin API**: `../opencode/packages/plugin/src/index.ts` — defines `Plugin`, `PluginModule`, `Hooks`, `PluginInput`
- **OpenCode plugin loader**: `../opencode/packages/opencode/src/plugin/index.ts` — how plugins are loaded and hooks are wired
- **KubeOpenCode plugin install flow**: `../kubeopencode/cmd/kubeopencode/plugin_init.go` — the `plugin-init` init container that runs `npm install`
- **KubeOpenCode Agent plugin spec**: `../kubeopencode/api/v1alpha1/agent_types.go` (lines 139-183) — CRD fields for declaring plugins
- **Existing Slack plugin reference**: `../kubeopencode/plugins/slack/dist/` — the original Slack plugin shipped with KubeOpenCode

## Plugin Architecture

### How Plugins Work in KubeOpenCode

1. Plugins are declared in the Agent spec:
   ```yaml
   spec:
     plugins:
       - name: "opencode-slack-plugin"
         target: server
   ```

2. The controller creates a **plugin-init** init container that runs `npm install --production` into a shared `/plugins` volume.

3. The executor container loads plugins via OpenCode's config `plugin` array using `file:///plugins/node_modules/<package>` paths.

4. The executor container **does not need npm** — it reads pre-installed packages.

### Plugin Targets

- **`server`** (default): Runs inside `opencode serve`. Has access to `PluginInput.client` (full SDK: sessions, prompts, events). This is the target for all plugins in this repo.
- **`tui`**: Runs during interactive terminal sessions. Provides UI extensions.

### PluginInput

Every server plugin receives a `PluginInput` with:

| Field | Type | Description |
|-------|------|-------------|
| `client` | `OpencodeClient` | Full SDK client (session.create, session.prompt, event.subscribe, etc.). Calls bypass HTTP — direct function invocation inside the process. |
| `project` | `Project` | Current project info |
| `directory` | `string` | Working directory |
| `worktree` | `string` | Git worktree root |
| `serverUrl` | `URL` | Server URL |
| `$` | `BunShell` | Bun shell API |

### Available Hooks

Plugins return a `Hooks` object. Key hooks used by plugins in this repo:

| Hook | Description |
|------|-------------|
| `event` | Receives ALL bus events (session.idle, message.part.updated, permission.asked, server.instance.disposed, etc.) |
| `tool` | Register custom tools |
| `chat.context` | Inject context into LLM prompts |
| `chat.message` | Intercept new messages |
| `permission.ask` | Intercept permission requests |

## Plugin Conventions

### Module Format

Use the `PluginModule` format with an `id` field:

```typescript
import type { PluginModule } from "@opencode-ai/plugin"

const plugin: PluginModule = {
  id: "my-plugin",
  server: async (input) => {
    // initialization
    return {
      event: async ({ event }) => { /* ... */ },
    }
  },
}

export default plugin
```

### Environment Variables

- Plugins receive credentials via `process.env`, injected from Agent `spec.credentials` (Kubernetes Secrets)
- If required env vars are missing, log a warning and return empty hooks `{}`
- Never hard-fail — a misconfigured plugin should not crash the Agent

### Logging

Use `console.log` / `console.warn` / `console.error` with a consistent prefix:

```typescript
console.log("[my-plugin] Connected successfully")
console.warn("[my-plugin] Heartbeat disabled: missing env vars")
```

### Heartbeat (KubeOpenCode-specific)

KubeOpenCode Agents support **standby mode** — auto-suspend after idle, auto-resume on new task. Plugins that maintain persistent connections (WebSocket, long-polling) must send heartbeat annotations to prevent unexpected auto-suspend:

- Annotation: `kubeopencode.io/last-connection-active`
- Interval: 60 seconds (match `ConnectionHeartbeatInterval` in controller)
- Stop heartbeat after 5 minutes of inactivity to allow idle timer
- Read ServiceAccount token from `/var/run/secrets/kubernetes.io/serviceaccount/token`
- If AGENT_NAME/AGENT_NAMESPACE/K8s API are unavailable, silently disable heartbeat

See `opencode-slack-plugin/src/index.ts` for the reference implementation.

### Graceful Shutdown

Listen for the `server.instance.disposed` event to clean up connections:

```typescript
if (evt.type === "server.instance.disposed") {
  heartbeat.stop()
  connection.disconnect()
}
```

### Multi-Instance Safety

Plugins may run in multiple Agent pods simultaneously. Design for this:

- All state is per-process (in-memory Maps, closures) — no shared files or databases
- Session maps are keyed by unique identifiers (e.g., Slack channel + thread timestamp)
- Bounded collections with eviction to prevent memory leaks

## Repository Structure

```
kubeopencode-plugins/
  AGENTS.md                       # This file
  opencode-slack-plugin/          # Slack Socket Mode integration
    src/index.ts                  # Plugin source
    package.json                  # npm package config
    tsconfig.json
    dist/                         # Built output (tsup)
    README.md                     # Setup instructions
```

## Development

### Building a Plugin

```bash
cd opencode-slack-plugin
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsup -> dist/
```

### Testing Locally

Copy the built plugin to your OpenCode plugins directory:

```bash
cp dist/index.js ~/.config/opencode/plugins/slack-plugin.js
```

Or add to `opencode.json`:

```json
{
  "plugin": ["file:///path/to/opencode-slack-plugin"]
}
```

### Testing with KubeOpenCode

Create an Agent with the plugin:

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
        name: slack-credentials
  # ...
```

## Style Guide

- TypeScript, ESM (`"type": "module"`)
- Use `@opencode-ai/plugin` as a peer dependency
- Prefer `const` over `let`; use early returns over else blocks
- Avoid `try/catch` when possible; use `.catch(() => {})` for best-effort operations
- Keep each plugin in a single file unless complexity demands splitting
- English comments only

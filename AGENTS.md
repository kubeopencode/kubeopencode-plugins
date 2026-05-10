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

## Debugging Plugins

### Log Locations

OpenCode writes structured logs (session lifecycle, LLM calls, tool execution, errors) to:

```
~/.local/share/opencode/log/    # macOS/Linux default ($XDG_DATA_HOME/opencode/log/)
```

Files are named `YYYY-MM-DDTHHMMSS.log` (one per startup, 10 most recent retained). Run `opencode debug paths` to confirm the path on your system.

Plugin `console.log`/`console.warn`/`console.error` output goes to the OpenCode process stdout/stderr — it is **not** captured in the structured log file. Use the `[plugin-name]` prefix convention to make plugin output easy to filter.

### Tracing a Problem

1. **Find the session** — search the log for the session ID or creation event:
   ```bash
   grep "ses_XXXXX" ~/.local/share/opencode/log/*.log
   ```

2. **Check for errors** — LLM failures, processor crashes, permission timeouts:
   ```bash
   grep "ERROR.*ses_XXXXX" ~/.local/share/opencode/log/*.log
   ```

3. **Key log markers**:
   - `service=session ... created` — session created
   - `service=session.prompt step=N loop` — prompt loop iteration N
   - `service=llm ... stream` — LLM call started
   - `service=llm ... stream error` — LLM call failed (root cause in `error=` JSON)
   - `service=session.processor ... error=` — processor crash
   - `service=session.prompt ... exiting loop` — prompt completed normally

### CLI Flags for Debugging

```bash
opencode serve --print-logs       # logs to stderr instead of file
opencode serve --log-level DEBUG  # maximum verbosity
```

Both can also be set in `opencode.json`:
```json
{
  "logLevel": "DEBUG"
}
```

## Repository Structure

```
kubeopencode-plugins/
  README.md                         # Project overview and quick start
  AGENTS.md                         # This file (AI agent dev guidelines)
  Makefile                          # Build and release targets
  .github/workflows/publish.yaml   # CI: automated npm publish on tag
  opencode-slack-plugin/            # Slack Socket Mode integration
    src/index.ts                    # Plugin source
    package.json                    # npm package config (@kubeopencode scope)
    tsconfig.json
    dist/                           # Built output (tsup)
    README.md                       # Setup instructions
```

## Development

### Building a Plugin

Use the Makefile at the repo root:

```bash
make install      # npm install
make typecheck    # tsc --noEmit
make build        # tsup -> dist/
make clean        # remove dist/
```

To target a specific plugin (when multiple plugins exist):

```bash
make build PLUGIN_DIR=opencode-slack-plugin
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
    - name: "@kubeopencode/opencode-slack-plugin"
  credentials:
    - secretRef:
        name: slack-credentials
  # ...
```

## Release Process

Releases are automated via GitHub Actions using **npm OIDC Trusted Publishing**. No npm tokens or secrets are required — authentication uses short-lived OIDC credentials tied to the specific workflow.

### How to release a plugin

1. **Bump the version** in the plugin's `package.json`:

   ```bash
   cd opencode-slack-plugin
   npm version patch   # or minor / major
   ```

2. **Commit and push** the version bump:

   ```bash
   git add -A
   git commit -s -m "release: opencode-slack-plugin v0.1.1"
   git push origin main
   ```

3. **Tag and push** to trigger CI:

   ```bash
   make release   # reads version from package.json, creates and pushes tag
   ```

   The tag format is `<plugin-dir>/v<version>` (e.g. `opencode-slack-plugin/v0.1.0`). This supports independent versioning per plugin.

### What CI does

The `.github/workflows/publish.yaml` workflow:

1. Extracts the plugin directory and version from the git tag
2. Runs `npm ci` → `typecheck` → `build`
3. Verifies `package.json` version matches the tag version
4. Publishes to npm with OIDC authentication and provenance attestation

### First-time setup for a new plugin

OIDC Trusted Publishing requires the package to already exist on npm:

1. Publish v0.1.0 manually: `npm login && make publish PLUGIN_DIR=my-new-plugin`
2. On npmjs.com, go to the package settings and add a Trusted Publisher:
   - Owner: `kubeopencode`, Repository: `kubeopencode-plugins`
   - Workflow: `publish.yaml`, Environment: `release`
3. Ensure the `release` environment exists in the GitHub repo settings

### npm package naming

All plugins are published under the `@kubeopencode` npm scope (e.g. `@kubeopencode/opencode-slack-plugin`). The `package.json` `name` field must use this scoped format.

## CJS/ESM Interop (Critical)

OpenCode plugins run inside **Bun's JavaScript runtime**, not Node.js. Bun's CJS/ESM interop differs from Node.js in ways that cause silent failures for CJS packages that use `Object.defineProperty` (getter/setter) for their exports.

### The Problem

Packages like `@slack/web-api` and `@slack/socket-mode` are **CJS modules** that export classes via `Object.defineProperty`:

```js
// @slack/web-api/dist/index.js
Object.defineProperty(exports, "WebClient", { enumerable: true, get: function() { return ... } });
```

In **Node.js**, `import { WebClient } from "@slack/web-api"` works because Node creates a live binding to the getter. But **Bun** (which OpenCode uses internally to load plugins via `await import()`) creates a namespace object that **drops getter-defined properties**. This means:

| Import style | Node.js | Bun (OpenCode runtime) |
|---|---|---|
| `import { WebClient }` | ✅ | ❌ `undefined` |
| `import * as M; M.WebClient` | ✅ | ❌ `undefined` |
| `const { WebClient } = await import(...)` | ✅ | ❌ `undefined` |
| `createRequire()(...).WebClient` | ✅ | ❌ `require() async module unsupported` |

All approaches fail. The error manifests as:

```
undefined is not a constructor (evaluating 'new WebClient(botToken)')
```

### The Solution: Bundle CJS Dependencies

**Always bundle CJS dependencies into the plugin output.** This eliminates runtime CJS/ESM interop entirely — tsup's bundler resolves all exports at build time using `__commonJS` wrappers that correctly handle `Object.defineProperty`.

**Configuration:**

1. Move CJS dependencies from `dependencies` to `devDependencies` in `package.json`:

   ```json
   {
     "dependencies": {},
     "devDependencies": {
       "@slack/web-api": "^7.13.0",
       "@slack/socket-mode": "^2.0.5"
     }
   }
   ```

2. tsup automatically bundles `devDependencies` — no extra config needed. Dependencies listed in `dependencies` are treated as external (left as `import` statements in the output).

3. Use standard named imports in source:

   ```ts
   import { WebClient } from "@slack/web-api"
   import { SocketModeClient } from "@slack/socket-mode"
   ```

**Trade-off:** The bundle grows from ~17KB to ~708KB when including `@slack/web-api`. This is acceptable for a plugin that runs once per Agent pod.

### WebSocket (ws) + Bun Compatibility

The `ws` library (used by `@slack/socket-mode` for WebSocket connections) depends on Node.js built-in modules (`http`, `https`, `net`, `tls`, etc.). When bundled with tsup, `ws` uses a `__require` polyfill at runtime that **does not** map to Bun's native implementations. This causes:

```
[ERROR] socket-mode:SlackWebSocket WebSocket error occurred: Unexpected server response: 101
```

HTTP 101 is the WebSocket upgrade response — `ws` treats it as an error because it's using the polyfilled `http`/`https` modules instead of Bun's native WebSocket.

**Solution:** Mark `ws` and all Node.js built-in modules as `external` in tsup. This forces runtime resolution via Bun's compatibility layer, which provides native `ws` support:

```ts
// tsup.config.ts
import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: ["@slack/web-api", "@slack/socket-mode", "@slack/types", "@slack/logger"],
  external: ["ws", "http", "https", "net", "tls", "crypto", "stream", "events", "url", "zlib", "bufferutil", "utf-8-validate"],
})
```

Keep `@slack/*` in `dependencies` so that `plugin-init` installs them (and their `ws` dependency) via npm. The `noExternal` setting ensures `@slack/*` source is bundled, while `external` ensures `ws` and Node.js builtins are resolved at runtime by Bun.

**Detection:** If a bundled plugin uses WebSocket connections and fails with "Unexpected server response: 101", check whether `ws` was bundled by searching for `require_ws` or `__require("http")` in the output. If found, add `ws` and Node.js builtins to the `external` list.

### Detection Checklist

If a plugin dependency uses CJS (`"type"` is not `"module"` or absent in `package.json`, `main` points to a `.js` file without ESM exports), and uses `Object.defineProperty` for exports, it **must** be bundled. Check with:

```bash
# Does the package use Object.defineProperty for exports?
grep "Object.defineProperty(exports" node_modules/<pkg>/dist/index.js
```

If you see `Object.defineProperty(exports, "ClassName"`, the package has this issue and **must** be bundled.

## Style Guide

- TypeScript, ESM (`"type": "module"`)
- Use `@opencode-ai/plugin` as a peer dependency
- Prefer `const` over `let`; use early returns over else blocks
- Avoid `try/catch` when possible; use `.catch(() => {})` for best-effort operations
- Keep each plugin in a single file unless complexity demands splitting
- English comments only
- **CJS dependencies must be bundled** (see CJS/ESM Interop section above)

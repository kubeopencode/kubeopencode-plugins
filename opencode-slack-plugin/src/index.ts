// Copyright Contributors to the KubeOpenCode project
import type { PluginModule, PluginInput, Hooks } from "@opencode-ai/plugin"
import * as os from "os"
// CJS/ESM interop: @slack/web-api and @slack/socket-mode are CJS modules that
// use Object.defineProperty for their exports. Bun's bundler cannot resolve
// named imports (produces "X is not a constructor"), namespace imports lose
// getter-defined properties in the bundled namespace, and require() is blocked
// by Bun for async CJS modules. Dynamic import() forces Bun to handle the
// interop at runtime, preserving all exports including constructors.
const slackWebApi = await import("@slack/web-api") as typeof import("@slack/web-api")
const slackSocketMode = await import("@slack/socket-mode") as typeof import("@slack/socket-mode")
const { WebClient } = slackWebApi
const { SocketModeClient } = slackSocketMode

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionEntry = {
  sessionId: string
  channel: string
  thread: string
  lastActive: number
  firstPrompt: boolean // true until the first prompt is sent
  // Per-thread pending permission — avoids cross-thread interference
  // when multiple users chat with the bot simultaneously.
  // Stores both requestId (for new API) and permissionId/sessionId (for v1 fallback).
  pendingPermission: {
    requestId: string
    permissionId: string
    sessionId: string
    createdAt: number // Timestamp for stale detection
  } | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SLACK_TEXT = 3900 // Slack limit is 4000, leave headroom
const MAX_SESSIONS = 500
const LOG_PREFIX = "[slack-plugin]"
const PERMISSION_TIMEOUT_MS = 5 * 60_000 // 5 min — auto-clear stale permission

// Injected as the first message in each new Slack thread session.
// Tells the LLM it is responding in Slack and should use Slack mrkdwn formatting.
const SLACK_SYSTEM_CONTEXT = [
  "This conversation is happening in Slack.",
  "Format your responses using Slack mrkdwn syntax:",
  "- *bold*, _italic_, ~strikethrough~, `inline code`",
  "- ```code blocks``` (no language specifier after backticks)",
  "- Bulleted lists with •  or -",
  "- Links: <url|display text>",
  "- Do NOT use Markdown headings (#, ##), HTML tags, or [text](url) link syntax — they do not render in Slack.",
  "Keep responses concise and conversational.",
].join("\n")

// ---------------------------------------------------------------------------
// PromptQueue: serializes prompt calls per session
// ---------------------------------------------------------------------------
// OpenCode's session.prompt() silently drops messages sent while a previous
// prompt is running (the message is written to DB but runLoop never starts).
// This queue ensures each message is fully processed before the next begins.

class PromptQueue {
  private queues = new Map<string, Array<() => Promise<void>>>()
  private running = new Set<string>()

  enqueue(sessionId: string, work: () => Promise<void>): void {
    let queue = this.queues.get(sessionId)
    if (!queue) {
      queue = []
      this.queues.set(sessionId, queue)
    }
    queue.push(work)
    this.drain(sessionId)
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return
    this.running.add(sessionId)
    try {
      const queue = this.queues.get(sessionId)
      while (queue && queue.length > 0) {
        const work = queue.shift()!
        try {
          await work()
        } catch (err) {
          console.error(`${LOG_PREFIX} Queued prompt failed for ${sessionId}:`, err)
        }
      }
    } finally {
      this.running.delete(sessionId)
      // Clean up empty queue entry
      const queue = this.queues.get(sessionId)
      if (queue && queue.length === 0) this.queues.delete(sessionId)
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat: prevents KubeOpenCode Agent standby auto-suspend
// ---------------------------------------------------------------------------

function createHeartbeat() {
  const agentName = process.env.AGENT_NAME
  const agentNamespace = process.env.AGENT_NAMESPACE
  const k8sHost = process.env.KUBERNETES_SERVICE_HOST
  const k8sPort = process.env.KUBERNETES_SERVICE_PORT || "443"
  const saTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token"

  // Resolved lazily on first use — avoids top-level await and works in
  // both CJS (Bun) and ESM (Node) runtimes.
  let fsModule: typeof import("node:fs") | null = null
  async function getFs(): Promise<typeof import("node:fs") | null> {
    if (fsModule) return fsModule
    try {
      fsModule = await import("node:fs")
      return fsModule
    } catch {
      return null
    }
  }

  let available = false
  // Probe availability synchronously at construction time.
  // We check env vars only — the actual fs access is deferred to patch().
  available = !!(agentName && agentNamespace && k8sHost)

  let timer: ReturnType<typeof setInterval> | null = null
  let lastSignal = 0
  const INTERVAL_MS = 60_000
  const INACTIVITY_MS = 5 * 60_000

  async function patch() {
    if (!available) return
    try {
      const fs = await getFs()
      if (!fs) return
      if (!fs.existsSync(saTokenPath)) {
        available = false
        return
      }
      const token = fs.readFileSync(saTokenPath, "utf8")
      const url = `https://${k8sHost}:${k8sPort}/apis/kubeopencode.io/v1alpha1/namespaces/${agentNamespace}/agents/${agentName}`
      const body = JSON.stringify({
        metadata: {
          annotations: {
            "kubeopencode.io/last-connection-active": new Date().toISOString(),
          },
        },
      })
      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/merge-patch+json",
        },
        body,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        console.warn(`${LOG_PREFIX} Heartbeat patch failed: ${response.status} ${text.slice(0, 200)}`)
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Heartbeat error: ${err instanceof Error ? err.message : err}`)
    }
  }

  return {
    get available() {
      return available
    },
    signal() {
      lastSignal = Date.now()
      if (!timer && available) {
        patch()
        timer = setInterval(() => {
          if (Date.now() - lastSignal > INACTIVITY_MS) {
            if (timer) {
              clearInterval(timer)
              timer = null
            }
            console.log(`${LOG_PREFIX} Heartbeat paused: no Slack activity for 5 minutes`)
            return
          }
          patch()
        }, INTERVAL_MS)
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max = MAX_SLACK_TEXT): string {
  if (text.length <= max) return text
  return text.slice(0, max) + "\n...(truncated)"
}

function sessionKey(channel: string, thread: string): string {
  return `${channel}-${thread}`
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const slack = async (input: PluginInput): Promise<Hooks> => {
  const botToken = process.env.SLACK_BOT_TOKEN
  const appToken = process.env.SLACK_APP_TOKEN

  if (!botToken || !appToken) {
    // Not configured — silently skip.
    return {}
  }

  // ── Multi-instance isolation ──
  //
  // SLACK_CHANNEL restricts which channel(s) this instance listens to.
  // Accepts comma-separated channel names or IDs: "#project-a,C0123ABCD".
  //
  // Why this matters: Slack Socket Mode delivers each message to exactly
  // ONE of the connected clients (random). If two opencode instances
  // share the same App Token without channel isolation, messages are
  // randomly routed — user A's thread could land on the wrong codebase.
  //
  // When set:  only messages in listed channels are processed; DMs ignored
  // When unset: all DMs and @mentions are processed (single-instance mode)
  const channelFilter = process.env.SLACK_CHANNEL
  const allowedChannelNames = channelFilter
    ? channelFilter.split(",").map((c) => c.trim().replace(/^#/, ""))
    : null

  console.log(
    `${LOG_PREFIX} Initializing...`,
    allowedChannelNames ? { channels: allowedChannelNames } : { mode: "all channels + DMs" },
  )

  const web = new WebClient(botToken)
  const socket = new SocketModeClient({ appToken })
  const client = input.client
  const heartbeat = createHeartbeat()
  const promptQueue = new PromptQueue()

  // Per-thread session mapping: "channel-thread" -> SessionEntry
  // Each thread is fully independent — multiple users in different threads
  // can chat with the bot concurrently without interference.
  const sessions = new Map<string, SessionEntry>()

  // Guards against concurrent getOrCreateSession calls for the same thread.
  // Without this, two rapid messages in the same thread would both miss the
  // sessions.get() check and create duplicate OpenCode sessions.
  const pendingCreates = new Map<string, Promise<SessionEntry | null>>()

  // Tracks message event IDs already being processed by the `message` handler
  // to prevent duplicate handling when both `message` and `app_mention` fire
  // for the same @mention in a channel.
  const processedEvents = new Set<string>()

  // Track bot's own user ID to filter out self-messages
  let botUserId: string | null = null

  // ------------------------------------------------------------------
  // Boot: resolve bot identity
  // ------------------------------------------------------------------

  try {
    const auth = await web.auth.test()
    botUserId = (auth.user_id as string) ?? null
    console.log(`${LOG_PREFIX} Authenticated as bot user ${botUserId}`)
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to authenticate with Slack:`, err)
    return {}
  }

  // Resolve channel names to IDs for the channel filter
  const allowedChannelIds = new Set<string>()
  if (allowedChannelNames) {
    try {
      const result = await web.conversations.list({
        limit: 200,
        types: "public_channel,private_channel",
      })
      for (const name of allowedChannelNames) {
        if (/^[CG][A-Z0-9]+$/.test(name)) {
          allowedChannelIds.add(name)
          continue
        }
        const match = result.channels?.find((c) => c.name === name)
        if (match?.id) {
          allowedChannelIds.add(match.id)
        } else {
          console.warn(`${LOG_PREFIX} Channel "${name}" not found in workspace`)
        }
      }
      console.log(`${LOG_PREFIX} Channel filter active:`, [...allowedChannelIds])
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to resolve channel names:`, err)
    }
  }

  // ------------------------------------------------------------------
  // Post a message to a Slack thread
  // ------------------------------------------------------------------

  async function postToThread(channel: string, thread: string, text: string) {
    await web.chat.postMessage({
      channel,
      thread_ts: thread,
      text: truncate(text),
    })
  }

  // ------------------------------------------------------------------
  // Set typing indicator ("is thinking...") in Slack thread
  // ------------------------------------------------------------------
  // Uses assistant.threads.setStatus which shows "<Bot Name> is thinking..."
  // in the thread. The status auto-clears when the bot posts a message.
  // Falls back silently if the API is unavailable (e.g., missing scope).

  async function setTypingStatus(channel: string, thread: string, status = "is thinking...") {
    try {
      await web.apiCall("assistant.threads.setStatus", {
        channel_id: channel,
        thread_ts: thread,
        status,
      })
    } catch {
      // Best-effort — don't fail the message flow if status API is unavailable
    }
  }

  // ------------------------------------------------------------------
  // Get or create an OpenCode session for a Slack thread
  // ------------------------------------------------------------------

  async function getOrCreateSession(channel: string, thread: string): Promise<SessionEntry | null> {
    const key = sessionKey(channel, thread)
    const existing = sessions.get(key)
    if (existing) return existing

    // Coalesce concurrent creates for the same thread. Without this guard,
    // two rapid messages would both pass the sessions.get() check above and
    // create duplicate OpenCode sessions — only one would survive in the Map.
    const inflight = pendingCreates.get(key)
    if (inflight) return inflight

    const promise = createSession(channel, thread, key)
    pendingCreates.set(key, promise)
    try {
      return await promise
    } finally {
      pendingCreates.delete(key)
    }
  }

  async function createSession(channel: string, thread: string, key: string): Promise<SessionEntry | null> {
    const result = await client.session.create({
      body: { title: `Slack thread ${thread}` },
    })
    if (result.error) {
      console.error(`${LOG_PREFIX} Failed to create session:`, result.error)
      return null
    }

    const entry: SessionEntry = {
      sessionId: result.data.id,
      channel,
      thread,
      lastActive: Date.now(),
      firstPrompt: true,
      pendingPermission: null,
    }
    sessions.set(key, entry)
    console.log(`${LOG_PREFIX} Created session ${result.data.id} for thread ${key}`)

    // Evict least-recently-used entry if map grows too large
    if (sessions.size > MAX_SESSIONS) {
      evictOldestSession()
    }

    return entry
  }

  // ------------------------------------------------------------------
  // Evict the least-recently-used session, notifying the user
  // ------------------------------------------------------------------

  function evictOldestSession(): void {
    let oldestKey: string | null = null
    let oldestTime = Infinity
    let oldestEntry: SessionEntry | null = null
    for (const [k, s] of sessions) {
      if (s.lastActive < oldestTime) {
        oldestTime = s.lastActive
        oldestKey = k
        oldestEntry = s
      }
    }
    if (oldestKey && oldestEntry) {
      // Notify the evicted thread so the user knows to @mention again
      postToThread(
        oldestEntry.channel,
        oldestEntry.thread,
        "_This session has been retired due to inactivity. Mention the bot to start a new session._",
      ).catch(() => {})
      sessions.delete(oldestKey)
      console.log(`${LOG_PREFIX} Evicted session ${oldestEntry.sessionId} (key: ${oldestKey})`)
    }
  }

  // ------------------------------------------------------------------
  // Find the session entry that owns a given OpenCode sessionId.
  // Used by event hooks to route OpenCode events back to Slack threads.
  // ------------------------------------------------------------------

  function findSessionByOpenCodeId(openCodeSessionId: string): SessionEntry | undefined {
    for (const session of sessions.values()) {
      if (session.sessionId === openCodeSessionId) return session
    }
    return undefined
  }

  // ------------------------------------------------------------------
  // Check if a stale permission should be auto-cleared
  // ------------------------------------------------------------------

  function clearStalePermission(session: SessionEntry): boolean {
    if (!session.pendingPermission) return false
    if (Date.now() - session.pendingPermission.createdAt > PERMISSION_TIMEOUT_MS) {
      console.log(`${LOG_PREFIX} Auto-clearing stale permission for session ${session.sessionId}`)
      session.pendingPermission = null
      postToThread(
        session.channel,
        session.thread,
        "_Permission request expired (timed out after 5 minutes). Continuing normally._",
      ).catch(() => {})
      return true
    }
    return false
  }

  // ------------------------------------------------------------------
  // Handle incoming Slack message for a specific thread
  // ------------------------------------------------------------------

  async function handleMessage(channel: string, thread: string, text: string) {
    heartbeat.signal()

    const key = sessionKey(channel, thread)
    const existing = sessions.get(key)

    // ── Permission reply handling (per-thread) ──
    // If THIS thread has a pending permission, check if the message is a reply.
    // Messages in other threads are unaffected — they create/continue their
    // own sessions independently.
    if (existing?.pendingPermission) {
      // Auto-clear if the permission has been pending too long
      if (!clearStalePermission(existing)) {
        const trimmed = text.trim().toLowerCase()
        let reply: "once" | "always" | "reject" | null = null
        if (["1", "y", "yes", "once"].includes(trimmed)) reply = "once"
        else if (["2", "always"].includes(trimmed)) reply = "always"
        else if (["3", "n", "no", "reject"].includes(trimmed)) reply = "reject"

        if (reply) {
          try {
            // Use v2 API if available, fall back to v1 deprecated endpoint.
            // The v1 SDK client type doesn't expose `permission.reply()` but
            // the runtime client may have it if OpenCode is recent enough.
            const v2 = client as any
            if (typeof v2.permission?.reply === "function") {
              await v2.permission.reply({
                requestID: existing.pendingPermission.requestId,
                reply,
              })
            } else {
              // Fallback: v1 SDK method (deprecated but functional)
              await client.postSessionIdPermissionsPermissionId({
                path: {
                  id: existing.pendingPermission.sessionId,
                  permissionID: existing.pendingPermission.permissionId,
                },
                body: { response: reply },
              })
            }
            existing.pendingPermission = null
            await postToThread(channel, thread, `_Permission ${reply === "reject" ? "denied" : "granted"} (${reply})_`)
          } catch (err) {
            // Permission may have been resolved externally — clear it
            existing.pendingPermission = null
            await postToThread(channel, thread, `_Permission already resolved or failed: ${err}_`)
          }
          return
        }
        await postToThread(channel, thread, "_Invalid response. Reply: 1/y/yes, 2/always, or 3/n/no_")
        return
      }
      // If stale permission was cleared, fall through to normal message handling
    }

    const session = await getOrCreateSession(channel, thread)
    if (!session) {
      await postToThread(channel, thread, "Sorry, I had trouble creating a session. Please try again.")
      return
    }

    session.lastActive = Date.now()

    // Show typing indicator while processing
    setTypingStatus(channel, thread)

    // Prepend Slack formatting context on the first prompt of each thread.
    // Subsequent messages in the same thread skip this — the LLM already has
    // the context in its conversation history.
    let promptText = text
    if (session.firstPrompt) {
      promptText = `<system-reminder>\n${SLACK_SYSTEM_CONTEXT}\n</system-reminder>\n\n${text}`
      session.firstPrompt = false
    }

    // Enqueue the prompt to serialize concurrent messages in the same session.
    // OpenCode silently drops prompt() calls on a busy session (the message is
    // written to DB but runLoop never starts), so we must serialize here.
    promptQueue.enqueue(session.sessionId, async () => {
      const result = await client.session.prompt({
        path: { id: session.sessionId },
        body: { parts: [{ type: "text", text: promptText }] },
      })

      if (result.error) {
        console.error(`${LOG_PREFIX} Prompt failed:`, result.error)
        await postToThread(channel, thread, "Sorry, I had trouble processing your message. Please try again.")
        return
      }

      // Extract text from response parts. The response shape is
      // { info: AssistantMessage, parts: Part[] } where Part can be
      // { type: "text", text: string } or tool/step parts.
      const data = result.data as any
      const parts = data?.parts ?? []
      const textParts = parts
        .filter((p: any) => p.type === "text" && p.text)
        .map((p: any) => p.text)

      if (textParts.length === 0) {
        // No text in response — log the raw data for debugging but don't
        // show a confusing fallback message to the user. The session.idle
        // event or subsequent messages will follow.
        console.warn(`${LOG_PREFIX} Empty text response for session ${session.sessionId}:`, JSON.stringify(data).slice(0, 500))
        return
      }

      await postToThread(channel, thread, textParts.join("\n"))
    })
  }

  // ------------------------------------------------------------------
  // Channel filter
  // ------------------------------------------------------------------

  function isChannelAllowed(channelId: string, channelType: string): boolean {
    if (!allowedChannelIds.size) return true
    if (channelType === "im") return false
    return allowedChannelIds.has(channelId)
  }

  // ------------------------------------------------------------------
  // Determine if the bot should respond to a thread message
  // ------------------------------------------------------------------
  // In channels (non-DM), the bot responds to:
  //   1. Any message that @mentions the bot
  //   2. Direct replies to the bot's own messages in an owned thread
  // It does NOT capture all messages in an owned thread — this prevents
  // human-to-human conversation in the thread from being sent to OpenCode.

  async function shouldRespondInThread(
    channel: string,
    threadTs: string | undefined,
    text: string,
  ): Promise<boolean> {
    // Always respond to @mentions
    if (text.includes(`<@${botUserId}>`)) return true

    // If not in an owned thread, ignore
    if (!threadTs) return false
    const key = sessionKey(channel, threadTs)
    if (!sessions.has(key)) return false

    // In an owned thread without @mention: only respond if the message
    // is a direct reply to the bot's last message. We approximate this
    // by checking if the thread's most recent bot message is "close" to
    // this message in time. This is simpler and cheaper than calling
    // conversations.replies for every message.
    //
    // Heuristic: if there's an active session and the user is replying
    // in the thread, they're most likely talking to the bot. But if
    // someone else jumps in without mentioning the bot, they probably
    // want to talk to the other human. We use a simple rule:
    //   - If the thread has a pending permission → always respond (they
    //     might be answering yes/no)
    //   - Otherwise → require @mention for non-DM threads
    //
    // This is a conservative choice: users can always @mention to be
    // explicit. The trade-off is slightly more friction vs accidentally
    // intercepting human conversation.
    const session = sessions.get(key)
    if (session?.pendingPermission) return true

    return false
  }

  // ------------------------------------------------------------------
  // Socket Mode event handlers
  // ------------------------------------------------------------------

  // Deduplicate events: when the bot is @mentioned in a channel, Slack fires
  // both a `message` event and an `app_mention` event. We let `message` handle
  // everything and use processedEvents to skip the duplicate `app_mention`.

  socket.on("message", async ({ event, ack }) => {
    await ack()

    if (event.bot_id || event.subtype || !event.text) return
    if (botUserId && event.user === botUserId) return
    if (!isChannelAllowed(event.channel, event.channel_type || "")) return

    // In channels: check if the bot should respond
    if (event.channel_type !== "im") {
      const shouldRespond = await shouldRespondInThread(
        event.channel,
        event.thread_ts,
        event.text,
      )
      if (!shouldRespond) return
    }

    // Mark this event as handled so app_mention doesn't double-process it
    const eventId = event.client_msg_id || event.ts
    if (eventId) processedEvents.add(eventId)

    const text = botUserId
      ? event.text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim()
      : event.text.trim()
    if (!text) return

    try {
      await handleMessage(event.channel, event.thread_ts || event.ts, text)
    } catch (err) {
      console.error(`${LOG_PREFIX} Error handling message:`, err)
      try {
        await postToThread(event.channel, event.thread_ts || event.ts, `_Error: ${err}_`)
      } catch {
        // swallow
      }
    } finally {
      // Clean up after a delay — app_mention typically arrives within seconds
      if (eventId) setTimeout(() => processedEvents.delete(eventId), 10_000)
    }
  })

  socket.on("app_mention", async ({ event, ack }: any) => {
    await ack()

    if (!event.text) return
    if (!isChannelAllowed(event.channel, "channel")) return

    // Skip if the message handler already processed this event
    const eventId = event.client_msg_id || event.ts
    if (eventId && processedEvents.has(eventId)) return

    const text = botUserId
      ? event.text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim()
      : event.text.trim()
    if (!text) return

    try {
      await handleMessage(event.channel, event.thread_ts || event.ts, text)
    } catch (err) {
      console.error(`${LOG_PREFIX} Error handling app_mention:`, err)
    }
  })

  // ------------------------------------------------------------------
  // Start Socket Mode connection
  // ------------------------------------------------------------------

  await socket.start()
  console.log(`${LOG_PREFIX} Slack Socket Mode connected (host: ${os.hostname()}, dir: ${input.directory})`)

  // ------------------------------------------------------------------
  // Return hooks
  // ------------------------------------------------------------------

  return {
    event: async ({ event }) => {
      const evt = event as any

      // Log tool completion events (not posted to Slack — too noisy for users).
      // Visible in OpenCode server logs: look for "[slack-plugin] Tool:"
      if (evt.type === "message.part.updated") {
        const part = evt.properties?.part
        if (part?.type === "tool" && part.state?.status === "completed" && part.sessionID) {
          const session = findSessionByOpenCodeId(part.sessionID)
          if (session) {
            console.log(`${LOG_PREFIX} Tool: ${part.tool} — ${part.state.title || "completed"} (session: ${session.sessionId})`)
            // Refresh typing status so the user knows the bot is still working
            setTypingStatus(session.channel, session.thread, "is working...")
          }
        }
      }

      // Log session idle events (not posted to Slack).
      // Visible in OpenCode server logs: look for "[slack-plugin] Session idle:"
      if (evt.type === "session.idle") {
        const sessionId = evt.properties?.sessionID ?? evt.properties?.id
        if (sessionId) {
          const session = findSessionByOpenCodeId(sessionId)
          if (session) {
            console.log(`${LOG_PREFIX} Session idle: ${session.sessionId}`)
          }
        }
      }

      // Forward permission requests to the correct Slack thread.
      // Permission state is stored per-session so concurrent threads
      // don't interfere with each other.
      if (evt.type === "permission.asked") {
        const props = evt.properties
        if (!props?.id || !props?.sessionID) return

        const session = findSessionByOpenCodeId(props.sessionID)
        if (!session) return

        session.pendingPermission = {
          requestId: props.id,
          permissionId: props.id,
          sessionId: props.sessionID,
          createdAt: Date.now(),
        }

        let msg = "_Permission Request_\n"
        msg += `*${props.permission}*\n`
        if (props.patterns?.length) {
          msg += `Pattern: \`${props.patterns.join(", ")}\`\n`
        }
        msg += "\n*1.* Yes (once)\n*2.* Always\n*3.* No (reject)\n"
        msg += "\n_Reply: 1/y/yes, 2/always, or 3/n/no_"

        postToThread(session.channel, session.thread, msg).catch(() => {})
      }

      // Clear pendingPermission when OpenCode resolves it externally.
      // This handles: cascading approvals/rejections from "always"/"reject",
      // permissions answered from the web UI, or any other external resolution.
      // Without this, the thread would stay stuck in "answer the permission" mode.
      if (evt.type === "permission.replied") {
        const props = evt.properties
        if (!props?.requestID && !props?.permissionID) return

        const rid = props.requestID || props.permissionID
        for (const session of sessions.values()) {
          if (session.pendingPermission?.requestId === rid) {
            session.pendingPermission = null
            // Don't post — the resolution was external; the thread will
            // naturally unblock and accept new messages.
            break
          }
        }
      }

      // Graceful shutdown
      if (evt.type === "server.instance.disposed") {
        console.log(`${LOG_PREFIX} Server disposing, shutting down Slack connection`)
        heartbeat.stop()
        socket.disconnect().catch(() => {})
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

const plugin: PluginModule = {
  id: "slack",
  server: slack,
}

export default plugin

# User Workflow Scenarios

10 scenarios covering normal usage, concurrency, and tricky edge cases.
Each scenario traces what the plugin code does at each step and notes whether the current implementation handles it correctly.

References point to `src/index.ts` line numbers.

---

## Scenario 1: Two Users, Simultaneous First Messages in Same Channel

**Setup:** `SLACK_CHANNEL=#backend`, single instance. Neither Alice nor Bob has talked to the bot before.

| Step | Actor | Action |
|------|-------|--------|
| 1 | Alice | `@bot fix the login bug` in #backend (creates thread T1, ts=100.001) |
| 2 | Bob | `@bot add unit tests for auth` in #backend (creates thread T2, ts=100.002) — arrives <50ms after Alice's |
| 3 | Plugin | Both hit `handleMessage()` concurrently. Each calls `getOrCreateSession()` with different keys (`C-100.001` vs `C-100.002`). Two independent sessions created. |
| 4 | Plugin | Alice's prompt → response posted to T1. Bob's prompt → response posted to T2. |
| 5 | Alice | replies in T1 `what about the edge case?` — no @mention needed (line 431: `inOwnedThread` check) |
| 6 | Plugin | `sessions.get("C-100.001")` hits → routes to Alice's session. Bob unaffected. |

**Result: PASS.** Different threads = different Map keys. Fully independent.

---

## Scenario 2: Rapid-Fire Double Message in Same Thread (Race Condition)

**Setup:** Alice sends two messages in the same thread within milliseconds — before session creation completes.

| Step | Actor | Action |
|------|-------|--------|
| 1 | Alice | `@bot refactor the parser` in #backend → thread T1 |
| 2 | Alice | `also rename the variables` in T1 — arrives 20ms later |
| 3 | Plugin | Message 1: `getOrCreateSession("C", "T1")` → no existing session, no inflight → calls `createSession()`, stores promise in `pendingCreates` (line 256) |
| 4 | Plugin | Message 2: `getOrCreateSession("C", "T1")` → no existing session, **but** `pendingCreates.get(key)` returns the in-flight promise (line 252) → awaits the same promise |
| 5 | Plugin | Session created once. Both messages use the same session. |
| 6 | Plugin | Message 1's `session.prompt()` is called. Message 2's `session.prompt()` is also called — both await concurrently on the same OpenCode session. |

**Result: PASS** for session creation (no duplicate). **CONCERN:** Two concurrent `session.prompt()` calls to the same OpenCode session. OpenCode's prompt API may queue or reject the second call — behavior depends on OpenCode server internals.

**Potential issue (BUG-1):** If OpenCode rejects concurrent prompts on the same session, the second message silently fails or returns an error. The user sees "Sorry, I had trouble processing your message" for a valid follow-up. The plugin has no queuing mechanism — it fires both prompts simultaneously.

---

## Scenario 3: Permission Request During Active Conversation

**Setup:** Alice is chatting with the bot. OpenCode needs to run `rm -rf ./tmp` and asks for permission.

| Step | Actor | Action |
|------|-------|--------|
| 1 | Alice | `@bot clean up the temp files` in T1 |
| 2 | OpenCode | Executes tools, encounters `rm -rf ./tmp`, emits `permission.asked` event |
| 3 | Plugin | Event hook (line 520): finds session by OpenCode ID, sets `session.pendingPermission`, posts permission prompt to T1 |
| 4 | Alice | replies `yes` in T1 |
| 5 | Plugin | `handleMessage()` → `existing.pendingPermission` is set (line 335) → `trimmed = "yes"` → `reply = "once"` → calls `client.permission.reply()` (line 349) |
| 6 | Plugin | Clears `pendingPermission`, posts "_Permission granted (once)_" |
| 7 | OpenCode | Completes the `rm` operation, continues processing, eventually returns response |
| 8 | Plugin | `session.prompt()` from step 1 finally resolves → posts result to T1 |

**Result: PASS.**

---

## Scenario 4: User Types Non-Permission Message While Permission is Pending

**Setup:** Same as Scenario 3, but Alice ignores the permission prompt and sends a new question.

| Step | Actor | Action |
|------|-------|--------|
| 1 | Plugin | Permission prompt posted in T1: "Reply: 1/y/yes, 2/always, or 3/n/no" |
| 2 | Alice | replies `actually, can you also fix the logger?` in T1 |
| 3 | Plugin | `handleMessage()` → `existing.pendingPermission` is set → `trimmed = "actually, can you also fix the logger?"` → doesn't match any permission keyword → `reply = null` |
| 4 | Plugin | Posts "_Invalid response. Reply: 1/y/yes, 2/always, or 3/n/no_" (line 370) |

**Result: PARTIAL.** The permission gate correctly blocks non-permission messages. But the user's actual question is **silently swallowed** — it's never queued or forwarded. Alice must first resolve the permission (yes/no), then re-type her question.

**Potential issue (BUG-2):** No way for the user to cancel or bypass the pending permission state except by answering it. If the permission request becomes stale (e.g., OpenCode's internal timeout fires), `pendingPermission` is never cleared — the thread is permanently stuck in "answer the permission" mode. The plugin doesn't listen for `permission.replied` or `permission.timeout` events.

---

## Scenario 5: Cross-Thread Permission Isolation

**Setup:** Alice has a pending permission in T1. Bob sends a message in T2.

| Step | Actor | Action |
|------|-------|--------|
| 1 | Plugin | T1 has `pendingPermission` set |
| 2 | Bob | `@bot deploy to staging` in #backend → creates thread T2 |
| 3 | Plugin | `handleMessage("C", "T2", ...)` → `sessions.get("C-T2")` returns undefined → `existing?.pendingPermission` is falsy → falls through to `getOrCreateSession()` |
| 4 | Plugin | New session created for Bob. Prompt sent normally. |
| 5 | Alice | replies `y` in T1 → routes to T1's session → permission resolved |

**Result: PASS.** Permission state is per-SessionEntry, not global.

---

## Scenario 6: Message With Only @mention, No Text

**Setup:** Alice sends `@bot` with nothing else.

| Step | Actor | Action |
|------|-------|--------|
| 1 | Alice | types `@bot` and hits enter in #backend |
| 2 | Slack | Sends event with `text = "<@U123BOT>"` |
| 3 | Plugin | `message` handler: text after stripping mention = `""` → `if (!text) return` (line 440) → silently ignored |
| 4 | Plugin | `app_mention` handler: same result → silently ignored |

**Result: PASS.** No empty session created, no error message.

---

## Scenario 7: Bot @mentioned in Unowned Thread (Someone Else's Thread)

**Setup:** Charlie started thread T3 (unrelated conversation, no bot involvement). Later, Dave replies in T3 with `@bot what does this function do?`.

| Step | Actor | Action |
|------|-------|--------|
| 1 | Charlie | starts thread T3 in #backend (no bot mention) |
| 2 | Dave | replies in T3: `@bot what does this function do?` |
| 3 | Plugin | `message` handler: `event.channel_type !== "im"` → checks `inOwnedThread`: `sessions.has("C-T3")` is false → checks `event.text.includes("<@U123BOT>")` → true → proceeds |
| 4 | Plugin | `getOrCreateSession("C", "T3")` → creates new session |
| 5 | Plugin | Session bound to T3. Future messages in T3 (even without @mention) route to this session. |
| 6 | Charlie | replies in T3: `I disagree with that approach` (no @mention) |
| 7 | Plugin | `inOwnedThread` = true (session exists for T3) → processes Charlie's message as a prompt to the bot |

**Result: PROBLEM (BUG-3).** Once the bot is mentioned in any thread, **all** subsequent messages in that thread are intercepted — including messages from users who are talking to each other, not the bot. Charlie's human-to-human reply gets sent to OpenCode as a prompt, and the bot responds, polluting the conversation.

This is inherent to the "once mentioned, own the thread" design. Possible mitigations: require @mention for every message, or only capture messages that are direct replies to the bot's own messages.

---

## Scenario 8: DM Conversation + Channel Conversation Simultaneously

**Setup:** `SLACK_CHANNEL` is **not** set (single-instance mode). Alice DMs the bot while Bob is chatting in #backend.

| Step | Actor | Action |
|------|-------|--------|
| 1 | Alice | DMs the bot: `help me write a Dockerfile` |
| 2 | Plugin | `isChannelAllowed()`: `allowedChannelIds.size === 0` → returns true → proceeds |
| 3 | Plugin | `event.channel_type === "im"` → skips the @mention/owned-thread check → processes directly |
| 4 | Plugin | `getOrCreateSession("D_alice", "ts_alice")` → creates session for DM thread |
| 5 | Bob | `@bot add CORS headers` in #backend |
| 6 | Plugin | Different channel, different thread → independent session |
| 7 | Both | Concurrent `session.prompt()` calls to different sessions → fully independent |

**Result: PASS.** DM and channel messages are routed by different channel+thread keys.

---

## Scenario 9: Session Eviction Under Load (LRU + Returning User)

**Setup:** 500 threads have been active. Thread #1 (from 3 hours ago) is the oldest. User returns to thread #1.

| Step | Actor | Action |
|------|-------|--------|
| 1 | State | `sessions.size === 500`. Thread #1 key = "C-T1", `lastActive` = 3hrs ago (oldest) |
| 2 | Eve | `@bot new feature` in #backend → new thread T501 |
| 3 | Plugin | `createSession()` → `sessions.size` becomes 501 → eviction triggers (line 284) → scans all 501 entries → finds "C-T1" with lowest `lastActive` → deletes it |
| 4 | Plugin | Session for T501 created. sessions.size = 500. |
| 5 | Original user | Returns to thread T1, sends follow-up: `what about the test?` |
| 6 | Plugin | `inOwnedThread`: `sessions.has("C-T1")` → false (evicted). Text includes `<@bot>`? Depends on whether they @mentioned. |
| 7a | If @mention | New session created for T1 — but **previous context is lost**. The user starts fresh. |
| 7b | If no @mention | Message silently ignored — user gets no response at all. |

**Result: PARTIAL.** Eviction works correctly to bound memory, but the user experience is poor:
- **BUG-4a:** No notification that the old session was evicted. The user's follow-up either starts a blank session or gets ignored.
- **BUG-4b:** If the user continues in the thread without @mention (because it "used to work"), they get silence.

Possible mitigation: when evicting, post a message to the old thread: "_Session expired due to inactivity. @mention the bot to start a new session._"

---

## Scenario 10: Server Restart Mid-Conversation (Graceful Shutdown + Reconnect)

**Setup:** Alice is mid-conversation in T1. The OpenCode server restarts (KubeOpenCode rolling update, or `server.instance.disposed` event).

| Step | Actor | Action |
|------|-------|--------|
| 1 | State | Active session in T1, `sessions` Map has entry. Alice is waiting for a response. |
| 2 | OpenCode | Emits `server.instance.disposed` event |
| 3 | Plugin | Event hook (line 545): calls `heartbeat.stop()`, calls `socket.disconnect()` |
| 4 | Plugin | Socket Mode WebSocket closes. All in-memory state (`sessions` Map) is lost. |
| 5 | OpenCode | Server process exits and restarts. Plugin `server()` function runs again. |
| 6 | Plugin | New `SocketModeClient` connects. `sessions` Map is empty. `botUserId` re-resolved. |
| 7 | Alice | Sends follow-up in T1: `is it done?` (no @mention, since the thread was "owned") |
| 8 | Plugin | `inOwnedThread`: `sessions.has("C-T1")` → false (Map was reset). `text.includes("<@bot>")` → false. → **silently ignored**. |
| 9 | Alice | Confused. Sends `@bot is it done?` |
| 10 | Plugin | @mention detected → creates new session for T1. Fresh context, no history from before restart. |

**Result: KNOWN LIMITATION.** In-memory sessions don't survive restarts. This is by design (stateless plugin, no external storage). But:
- **BUG-5:** Alice gets no indication that the bot restarted. From her perspective, the bot just stops responding.
- The pending `session.prompt()` from step 1 may have been interrupted — Alice never receives the response she was waiting for.

---

## Summary of Issues Found

| ID | Severity | Description | Status | Fix |
|----|----------|-------------|--------|-----|
| BUG-1 | Medium | Two rapid messages in the same thread fire concurrent `session.prompt()` calls — OpenCode silently drops the second message | **FIXED** | `PromptQueue` class serializes per-session prompt calls |
| BUG-2 | High | Pending permission is never auto-cleared if OpenCode's permission times out or is resolved externally; thread gets stuck | **FIXED** | Listen for `permission.replied` event + 5-min timeout via `clearStalePermission()` |
| BUG-3 | Medium | Once bot is mentioned in a thread, ALL messages in that thread are captured — including human-to-human conversation | **FIXED** | `shouldRespondInThread()` now requires @mention for channel threads; only pending-permission threads respond without @mention |
| BUG-4a | Low | Session eviction gives no notification to the user in the old thread | **FIXED** | `evictOldestSession()` posts a retirement notice before deleting |
| BUG-4b | Medium | After eviction, follow-up without @mention is silently ignored | **MITIGATED** | Eviction notice tells the user to @mention again. Inherent to in-memory design. |
| BUG-5 | Low | Server restart loses all session mappings with no user notification | **ACCEPTED** | Known limitation of in-memory design. Users must @mention to start new session. Future: persist to file or ConfigMap. |

### Fix Details

1. **BUG-1 — PromptQueue** (`src/index.ts` class `PromptQueue`): Each session gets its own FIFO queue. When `handleMessage()` is called, the prompt work is enqueued via `promptQueue.enqueue(sessionId, ...)`. The queue drains sequentially — the next prompt only fires after the previous one completes. This prevents OpenCode's `ensureRunning()` state machine from silently discarding the second message.

2. **BUG-2 — Permission lifecycle** (`src/index.ts` event hook + `clearStalePermission()`): Three protections:
   - **`permission.replied` event listener**: When OpenCode resolves a permission externally (cascading approval, web UI, etc.), the event hook clears `pendingPermission` on the matching session.
   - **Stale timeout**: `clearStalePermission()` checks `pendingPermission.createdAt` — if older than 5 minutes, it auto-clears and posts a timeout notice to the thread.
   - **Error recovery**: If the permission reply API call fails (permission already resolved), `pendingPermission` is cleared and the error is reported gracefully instead of leaving the thread stuck.

3. **BUG-3 — Thread ownership** (`src/index.ts` function `shouldRespondInThread()`): Changed from "capture everything in owned threads" to a conservative model:
   - @mentions are always processed regardless of thread ownership.
   - In owned threads without @mention, only respond if there's a pending permission (the user might be answering yes/no).
   - All other messages in owned threads require @mention — prevents intercepting human-to-human side conversations.

4. **BUG-4 — Eviction notice** (`src/index.ts` function `evictOldestSession()`): Before deleting the LRU session from the Map, posts "_This session has been retired due to inactivity. Mention the bot to start a new session._" to the thread. The user knows to @mention if they return.

5. **BUG-5 — Accepted limitation**: In-memory `sessions` Map is intentionally stateless. Persisting to disk or ConfigMap would add complexity and failure modes (stale state, multi-pod conflicts). For MVP, the trade-off is acceptable — the user's OpenCode session data is preserved server-side; only the Slack-to-session mapping is lost.

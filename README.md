# Skill Router for Codex

[简体中文](README-cn.md)

Skill Router uses your existing Codex provider and login to rank installed skills for the first task in each session. Later prompts skip ranking. If the task changes, Codex can call `search_skills` to find relevant skills in the current project.

## Install and configure

Requires Node.js 22+ and a Codex CLI with plugin hooks and app-server support (tested with 0.166.0). The plugin ships one bundled script; no separate API key, npm install, or MCP setup is needed.

```sh
codex plugin marketplace add https://github.com/alexalok/jev-skill-router.git
codex plugin add jev-skill-router@jev-skill-router
```

Set the following in your Codex config.toml, then use `/hooks` to review and trust the plugin commands. Recheck trust after upgrading.

```toml
[skills]
include_instructions = false
```

On **every eligible prompt**, the hook checks the effective persisted config for the task directory. Unless it confirms this exact value, it blocks the prompt and reports why. Only an incompatible native setting produces the TOML fix; other errors identify what prevented verification. Unreadable router config, malformed input, and a missing Codex executable also block. If the desktop app cannot find Codex, set `codexBin` to its absolute path.

Codex may still process the prompt if the hook is disabled, untrusted, missing Node, crashes, or exceeds its hook timeout. The hook cannot see transient caller overrides such as `-c skills.include_instructions=true`, `--profile`, or app-side settings. Set `JEV_SKILL_ROUTER_DISABLED=1` to bypass the hook, including its guard. Restore native skill instructions if you stop using the plugin.

`UserPromptSubmit` is ignored when `transcript_path` is null or missing, or when the transcript's first `session_meta` line identifies a guardian review (`payload.thread_source: "guardian_review"`, with `payload.source.subagent.other: "guardian"` as a fallback). These internal threads return `{}` before config checks: no ranker, session cache, selection history, or dashboard startup. The native-instructions guard is deliberately skipped because these threads are outside skill routing.

Only the transcript header is inspected (at most 256 KiB), never an app database. Unreadable, malformed, oversized, or unknown metadata preserves normal routing and its guard. Normal chats, subagents, side conversations, forks, automations, and `create_thread` chats remain eligible. `PreToolUse`, search, and compaction restore are unchanged.

## What reaches the model

The helper scores **names and short descriptions** against the task. The plugin never reads skill bodies; it reads policy metadata to skip manual-only skills and filters disabled, duplicate and missing skills. Each batch runs in an ephemeral read-only thread with tools disabled, in a fresh empty directory. Your user-level provider (including a custom base URL) and global instructions still apply; project-only provider overrides do not. Task text and short descriptions go to that provider.

Image-only or whitespace-only prompts pass the guard without using the session’s initial ranking. For long text prompts, the helper scores the first 24,000 UTF-8 bytes (ending at a whole character); Codex receives the full prompt. Hook input supports up to 8 MiB of JSON.

The main thread receives whole lines in descending relevance order: `- name: description (file: /path/SKILL.md)`. Non-pinned skills must score at least `initialMinRelevance` (default 0.8); there is no count limit. If none qualify, the hook lists any pinned skills and suggests calling `search_skills`. Its budget follows Codex: `skills.max_context_tokens` (at most 10,000), otherwise 2% of the session model context window (read from the Codex model catalog), otherwise 8,000 characters. Each line costs approximately one token per four UTF-8 bytes. A note counts skills omitted for budget only. History counts all omitted skills, including those below threshold. Explicit user requests still take precedence.

To list a skill in every initial injection regardless of relevance, set `policy.skill_router_always_injected_in_initial_turn: true` in its `agents/openai.yaml`. Such skills skip the helper, sit at the top of the list and are never dropped for budget (their cost still counts against it). The flag also lists a manual-only skill (`allow_implicit_invocation: false`); `search_skills` keeps skipping manual-only skills.

Codex caps each hook's `additionalContext` at about 2,500 tokens by default (one token per four UTF-8 bytes). Above that it saves the full text to a temp file and shows the model only the head and tail, which cuts the middle of the ranked list. The bundled `hooks.json` therefore sets `additionalContextLimit` to `0` (no cap) on every handler, so the budget above is the only limit. If you register the hooks yourself, set the same value.

Spawned subagents get a catalog ranked against their own task before spawning. `PreToolUse` rewrites only `message` for the verified desktop hook name `collaborationspawn_agent` and the documented `spawn_agent` name (`Agent` is a matcher alias). It preserves all other arguments. Discovery uses an explicit child `cwd` (relative paths resolve against the hook cwd), otherwise the caller's cwd; budget sizing uses the requested child model, otherwise the caller's model. The same relevance threshold, pinned-skill policy, budget and helper fallback apply. The hook never reads or writes the parent's ranking cache. Selection history uses source `subagent` without storing task text.

Both fresh-context and full-history children receive the task-specific catalog; its note supersedes any parent catalog already in inherited history. `SubagentStart` is no longer registered. A marked attachment prevents duplicate injection on retries; changing its task, cwd or model replaces it with a fresh ranking. If rerouting fails, the obsolete attachment is removed while the task and other arguments are preserved. If a client also emits `UserPromptSubmit` for the enriched opening message, it adopts the catalog only under a distinct child identity, without ranking or injecting again. The pre-spawn hook cannot populate the child's cache before its id exists. Clients that emit neither that opening prompt event nor a child compaction event rely on the catalog remaining in the task message; later follow-up prompts can rank again.

Resume reuses the cache; ordinary forks rank anew. Root compaction restores the cached list without a model call, possibly on the next turn. Cached lists expire after 30 days. Helper failures inject the budgeted catalog in its original order and report a safe error code. Spawn config/discovery failures leave the task unchanged and report a warning, matching the former subagent fallback policy. Unknown spawn paths or non-string task payloads are left untouched. Role/profile overrides invisible to the hook are not resolved. See [Codex hook coverage and rewrite contract](https://learn.chatgpt.com/docs/hooks#tool-coverage).

For a different task, call `search_skills` with `task_description` (1–24,000 UTF-8 bytes) and `cwd` (absolute task directory). It applies the same guard, filters by relevance, then returns up to the configured limit. No matches and service errors produce distinct results.

## Router settings

Optional file: `~/.config/jev-skill-router/config.json`. See [config.example.json](config.example.json).

| Key | Default | Meaning |
| --- | --- | --- |
| model | gpt-6-luna | Model slug supported by your provider |
| reasoningEffort | medium | Effort supported by that model |
| searchMaxResults | 10 | Search results, 1–50 |
| initialMinRelevance | 0.8 | Inclusive initial-turn threshold for non-pinned skills, 0–1 |
| searchMinRelevance | 0.8 | Inclusive search threshold, 0–1 |
| timeoutMs | 45000 | Shared app-server deadline, 1,000–120,000 ms |
| codexBin | codex | Executable or absolute path |
| recordSelections | true | Write local routing history |
| dashboardAutoStart | true | Start dashboard automatically |
| dashboardPort | 4318 | Local port, 1–65535 |
| dataDir | ~/.local/share/jev-skill-router | History and session cache; custom value must be absolute |

`JEV_SKILL_ROUTER_CONFIG`, `JEV_SKILL_ROUTER_DATA_DIR`, and `JEV_CODEX_BIN` override their respective paths. Unknown keys are rejected. Old `apiKey`, `threshold`, and `maxSkills` keys are ignored and reported by `--list`; old `jev-*` models use the new default.

## Inspect and develop

Run `node "<plugin-root>/scripts/router.mjs" --list` to inspect eligible skills. The read-only [local dashboard](http://127.0.0.1:4318) shows routing source, included/omitted counts, relevance and latency. It reads old and new daily JSONL records. Neither prompts nor search text are recorded. Turning recording off preserves history and the session cache.

Use `--dashboard [--port PORT]` for manual startup, or `--install-app-startup` / `--remove-app-startup` for the macOS LaunchAgent. Reinstall the helper after upgrading its standalone script. Automatic servers exit after 30 minutes idle. Other platforms can use hook startup.

From a checkout: `npm ci`, `npm run build`, `npm test`. Tests use a fake Codex process. `npm run dashboard:demo` starts a separate dashboard with synthetic history.

### Opening chats with `create_thread`

A parent-side `PreToolUse` hook ranks the opening `prompt` and appends the selected
catalog before Codex creates the chat, including when its first turn skips
`UserPromptSubmit`. Other tool arguments are preserved. Repeated routing of the
same enriched prompt does not append another catalog; changed tasks or targets
are ranked again. If rerouting fails or the new target is unsupported, the obsolete
attachment is removed while preserving the task and other arguments. Parent
session caches are never used or replaced.

- Projectless chats: discover user/system/admin skills from a neutral temporary
  directory, excluding repository scopes.
- Local projects: resolve `projectId` using the desktop app's read-only
  `list_projects` tool and discover skills in the returned source checkout.
- New worktrees: use the selected project's source checkout before the destination
  exists. The injected catalog explicitly says: "Skills were taken from the main
  worktree and, in rare cases, may have drifted from this worktree."
  These are source skills, not verified destination contents or paths.
- Remote/cloud targets are not represented by local catalogs. Missing app pipe,
  unknown project, inaccessible path, or lookup failure emits a diagnostic and
  preserves the task, stripping any invalidated catalog from a previous request. Helper ranking failures retain the existing unranked fallback.

Project lookup uses `CODEX_APP_TOOLS_PIPE_PATH`, supplied by the desktop runtime,
with the bundled Codex App Tools framed JSON-RPC protocol. This internal transport
can change between app versions; no private app database or state files are read.
Child compaction can restore the catalog if `UserPromptSubmit` receives the enriched
opening prompt; when that event never fires, the parent cannot seed the unknown
child's cache. Use `search_skills` for current destination contents as needed.

On macOS, the desktop app verifies pipe-client process identity. The create-thread
hook uses `exec "${CODEX_MCP_NODE_PATH:-node}"` so the app-provided signed Node
runtime connects directly under the hook host. An arbitrary system Node process
may be rejected. The fallback remains usable for projectless routing; project
lookup cannot proceed if the pipe or required runtime identity is unavailable;
the task is preserved and any invalidated catalog is removed.

### Missing plugin catalogs

The MCP server forwards `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` from its host so the
helper app-server can discover the same plugin skills as Codex Desktop. It does
not invent a Desktop identity for other hosts. If configuration contains enabled
plugins but discovery returns no plugin skills after the startup window, routing
fails with `SKILLS_PLUGIN_CATALOG_MISSING` instead of ranking an incomplete list.
This conservative check also rejects installations whose enabled plugins contain
no skills; it cannot detect a catalog missing only some plugins. Check the host's
environment and plugin availability if this error appears.

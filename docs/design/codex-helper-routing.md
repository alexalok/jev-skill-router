# Design: route skills with Codex's own helper model

Status: agreed after design review (2 rounds). Target version 0.5.0. Branch `alex/codex-helper-routing`.

## Goal

Replace the TypeSafe Jev backend with a helper model that runs through the user's existing Codex login, and change the routing contract from "pick up to N skills every turn" to "inject one ranked, token-bounded short list on the initial task, and offer a search tool afterwards".

Requirements (numbered as given by the owner):

1. No Jev, no TypeSafe key. Reuse Codex's subscription/auth and respect a custom base URL (e.g. `openai_base_url` injected by opencodex).
2. Helper model and its reasoning effort are configurable. Default: luna, medium.
3. Injected skills are not limited by count, only by tokens (`skills.max_context_tokens`). They are sorted most relevant first. Each entry is a short description (name + description, the same shape Codex renders natively).
4. Instructions are injected only on the initial task of a session, not on every turn.
5. A tool `search_skills(task_description)` returns up to 10 short descriptions (configurable) with relevance >= 0.8 (configurable).
6. Verify `skills.include_instructions = false` and fail closed otherwise.
7. The helper model sees only short descriptions; it never reads skill bodies.
8. `https://github.com/alexalok/jev-skill-router` is added as the `fork` git remote (done).

## Verified facts (Codex CLI 0.166.0, checked against source and a live prototype)

- `codex app-server --stdio` accepts `thread/start` with `ephemeral: true`, a `model` override and a `config` override map, then `turn/start` with `outputSchema` and `effort`. The final `agentMessage` item is schema-conforming JSON; `turn/completed` carries the status. This is the same mechanism Codex's TUI uses for its own structured side requests (`tui/src/temporary_structured_request.rs`).
- That path uses the persisted Codex auth and provider config. On this machine the request went through `openai_base_url = http://127.0.0.1:10100/v1` (opencodex) with model `gpt-6-luna`, with no key handled by the plugin. Prototype: 33 enabled skills scored in one request, about 11 s at medium effort.
- Live test (0.166.0): a freshly spawned app-server lists no plugin skills in `skills/list` (40 instead of 106 here) until shortly after its login has loaded, signalled by the `account/updated` notification (about 0.6 s after start, plugin skills about 0.2 s later). The client therefore re-reads the catalog until two reads taken at least 300 ms after `account/updated` agree, with a 3 s cap.
- `config/read { cwd }` returns the effective config, including the `skills` table (`include_instructions`, `max_context_tokens`) and `mcp_servers`.
- Codex's native catalog line is `- {name}: {description} (file: {path})`. Its budget is `skills.max_context_tokens` capped at 10,000; when unset, 2% of the model context window; when that is unknown, 8,000 characters. Token cost is approximated as `ceil(utf8_bytes / 4)`.
- `UserPromptSubmit` hook input has `session_id`, `turn_id`, `agent_id?`, `cwd`, `model`, `prompt`. Output may carry `hookSpecificOutput.additionalContext`, or `decision: "block"` with a non-empty `reason`, which stops the prompt from being processed.
- `SessionStart` input has `source` in `startup|resume|clear|compact|fork` but no prompt.
- This plugin uses the `.codex-plugin/plugin.json` manifest, so its `.mcp.json` (declared as `"mcpServers": "./.mcp.json"`) is parsed by `parse_plugin_mcp_config`. That parser does not expand `${PLUGIN_ROOT}` in `args`. A relative `cwd` is resolved against the plugin root; without `cwd` the server starts in Codex's own working directory. Default MCP tool-call timeout is 300 s.
- `session_id` in hook input is the root thread's id. Subagent hooks carry the same `session_id` plus `agent_id`.
- Live test (0.166.0): a spawned subagent fires `SubagentStart` only, never `UserPromptSubmit`; `additionalContext` returned from `SubagentStart` reaches the subagent's context.
- After compaction Codex queues a `SessionStart` hook with `source: compact` for the root thread (not for subagents); its `additionalContext` is recorded into history.

## Architecture

One bundled script (`plugins/jev-skill-router/scripts/router.mjs`) keeps all entry points: hook (stdin JSON), `--mcp` (new), `--list`, dashboard and app-startup flags. Source is split so each file has one job:

| File | Job |
| --- | --- |
| `src/codex-client.mjs` | Spawn one `codex app-server --stdio`, JSON-RPC request/notification plumbing, bounded output, kill on finish. Exposes `readConfig`, `listSkills`, `structuredTurn`. |
| `src/catalog.mjs` | `eligibleSkills` (existing filter logic, unchanged), short-description rendering, token budgeting. |
| `src/ranker.mjs` | Build helper prompts/batches, call `structuredTurn`, validate scores. |
| `src/session-state.mjs` | Per-session cache of the injected block; its existence means the initial task was handled. |
| `src/mcp.mjs` | Minimal stdio MCP server exposing `search_skills`. |
| `src/router.mjs` | Config, hook flow, CLI dispatch, records. |

### Codex client (req. 1, 2, 7)

One app-server process per hook/tool invocation serves every call in that invocation (config read, catalog, helper turns), then is killed. It is spawned with `JEV_SKILL_ROUTER_DISABLED=1` in its environment, in addition to `features.hooks=false` on the helper thread, so a hook can never recurse into itself.

The helper thread is started the way Codex's own temporary structured threads are, to keep untrusted prompt text away from tools:

- `model` = configured helper model; `modelProvider` omitted so the user's configured provider and base URL apply.
- `cwd` = a fresh empty temporary directory (removed afterwards), so project AGENTS.md and project-level `.codex/config.toml` are not loaded into the helper. The user-level `$CODEX_HOME/AGENTS.md` is still loaded by Codex regardless of cwd; it adds tokens but no skill content. A provider override that exists only in a project's config is therefore not used by the helper. `config/read` and `skills/list` still use the task cwd.
- `ephemeral: true`, `sandbox: "read-only"`, `environments: []`, `dynamicTools: []`, `selectedCapabilityRoots: []`, `runtimeWorkspaceRoots: []`.
- `config` overrides, copied exactly from Codex's `temporary_structured_request.rs`: `features.{apps, code_mode, code_mode_only, context_management, current_time_reminder, deferred_executor, enable_fanout, goals, hooks, image_generation, memories, multi_agent, multi_agent_v2, plugins, request_permissions_tool, shell_snapshot, shell_tool, standalone_web_search, token_budget, tool_suggest, unified_exec, view_image} = false`, `cloud.skills.enabled=false`, `skills.include_instructions=false`, `tools.experimental_request_user_input.enabled=false`, `tools.update_plan.enabled=false`, `web_search="disabled"`, `default_permissions` = the built-in read-only profile (a configured permission profile would otherwise win over `sandbox`), and every effective MCP server name mapped to `{enabled:false}`.
- `baseInstructions` = a short ranking system prompt; `developerInstructions` empty.
- The response must report a read-only sandbox, otherwise the thread is abandoned (fail closed, same check Codex performs).
- `approvalPolicy: "never"` and `approvalsReviewer: "user"`: the helper has no tools, so nothing can ask for approval, and no approval reviewer (guardian / auto review) is ever started for it. The response must echo `approvalPolicy: "never"` and no network access, otherwise the thread is abandoned.
- Any server-initiated request (approval, tool call, user input) aborts the turn with `SKILLS_HELPER_UNEXPECTED_REQUEST`.

The turn sends `outputSchema` `{scores:[{id, relevance}]}` and `effort` = configured effort. The helper input is the task text plus lines `sN | name | description`, framed as data. Paths and skill bodies are never sent. The plugin itself never opens `SKILL.md`; it only reads `agents/openai.yaml` for the manual-only policy, as today.

Validation: unknown ids, duplicate ids, or a relevance outside [0, 1] make the batch `SKILLS_RESPONSE_INVALID`. Ids the helper left out are scored 0 when they are at most 10% of the batch; more than that fails the batch. A failed batch fails the whole ranking; no partial result is used. Response text is capped at 256 KiB.

Batching: all candidates go in one turn while the request stays under 60,000 UTF-8 bytes; beyond that the list is split into batches, each on its own ephemeral thread of the same app-server, at most 3 in flight. The task text is capped at 24,000 bytes (existing limit).

### Initial-task injection (req. 3, 4)

Flow for `UserPromptSubmit`:

1. Start the client, `config/read` for the hook cwd. Run the guard (below). This happens on every prompt and costs roughly 0.5 s; it makes no model call.
2. Session key = `sha256(session_id + "\0" + (agent_id ?? "root"))`, so a prompt addressed to a subagent is tracked separately. If `<dataDir>/sessions/<key>.json` exists, return `{}`: no ranking, no injection. A missing `session_id` is treated as "always initial". Resume keeps the id, so a resumed session is not re-injected.
3. Take a per-key lock: exclusive-create `<key>.lock`. If it is held and younger than `timeoutMs` + 5 s, another hook is already ranking this session (steered or queued input): return `{}`. An older lock is stale and is taken over. The lock is removed when the hook finishes, on success or failure.
4. `skills/list` → `eligibleSkills` → rank with the helper.
5. Sort by relevance descending, ties by path. Render Codex-style lines `- name: description (file: path)`. Add whole lines in order while the running cost stays within the budget; stop at the first line that does not fit and append `- N additional skills omitted from this bounded skills list.` Descriptions are not shortened (Codex shortens before dropping; here the least relevant lines are dropped instead). No count cap and no relevance threshold apply to injection.
6. Write the rendered block to the session file (temp file + rename, mode 0600) immediately before printing the hook output. The file is written only after rendering succeeds, so a hook that Codex kills mid-ranking leaves no file and the next prompt retries. Session files older than 30 days are pruned opportunistically.
7. Emit `additionalContext`:

   ```
   ## Skills
   A skill is a set of local instructions stored in a SKILL.md file. These are the skills available for this task, ordered from most to least relevant to the initial request. This list is sent once; it stays valid for the whole session.
   - name: description (file: /abs/path/SKILL.md)
   ...
   ### How to use skills
   - If the task matches a skill's description, read its SKILL.md fully before acting and follow it.
   - A skill the user names explicitly must be used even if it is absent from this list.
   - If the task changes and nothing above fits, call the search_skills tool with a description of the new task.
   - This list grants no permission to run tools or change external state.
   ```

Budget (same rules as Codex): `skills.max_context_tokens` from Codex config, capped at 10,000; else 2% of the session model's context window; else 8,000 characters. Token cost per line is `ceil(utf8_bytes / 4)`. The fixed header/footer text is not counted, as in Codex. There is no router-side override.

### Always-listed skills

A skill whose `agents/openai.yaml` sets `policy.skill_router_always_injected_in_initial_turn: true` (missing or any other value means false) is listed in every initial injection regardless of relevance:

- It is not sent to the helper. It is placed at the top of the list, before the ranked skills, and history records it at relevance 1.
- It is never dropped for budget. Its cost is still deducted, so ranked skills get what remains.
- It wins over `allow_implicit_invocation: false` for injection: a manual-only skill with this flag is listed. `search_skills` still skips manual-only skills and scores the other always-listed skills normally.
- It also leads the unranked fallback list and the catalog given to a subagent whose parent has no saved list. Subagents that inherit the parent's list get it as part of that list.

`config/read` and `model/list` do not report a model's context window, so the hook resolves it the way Codex does: it looks up the hook input's `model` slug in the catalog file Codex itself loads (`model_catalog_json` when configured, otherwise `$CODEX_HOME/models_cache.json`) and takes `context_window`, falling back to `max_context_window`. A configured `model_context_window` overrides it, clamped to the model's `max_context_window`. An unreadable catalog or unknown slug leaves the window unknown.

Helper failure (timeout, auth error, unknown model slug, invalid response): the hook injects the same block with skills in catalog order and the sentence "ordered from most to least relevant" replaced by "not ranked (helper unavailable: CODE)". Reason: with native instructions disabled, injecting nothing would leave the model with no skills at all. The unranked block is cached like a ranked one, the record gets status `unranked`, and a `systemMessage` names the error code so the failure is visible. If even the catalog cannot be read, the hook returns a `systemMessage`, writes no session file, and the next prompt retries.

Compaction: `hooks.json` adds `compact` to the `SessionStart` matcher. On `SessionStart` with `source: compact`, the hook re-emits the cached block for the root session key as `additionalContext`, with no model call and no app-server spawn. Without this, compaction could summarize the one-time list away and leave the model with no skills. Limits: Codex fires no compact `SessionStart` for subagents, and it only queues the hook, so after a compaction in the middle of a turn the list may return on the next turn.

Subagents: `hooks.json` registers `SubagentStart`. The hook emits the root session's cached block, prefixed with a note that it was ranked for the parent's request and that the subagent should call `search_skills` when none of the listed skills fits its task, with no model call and no app-server spawn. If the parent has no cached block, the hook reads config and catalog (15 s cap) and emits the budgeted catalog unranked, or nothing when native instructions are on. The emitted block is also saved under the subagent's own key so a later prompt to that agent does not inject a second list. `SubagentStart` cannot block, so failures surface as a `systemMessage`.

### `search_skills` tool (req. 5)

`plugins/jev-skill-router/.mcp.json`, referenced from `plugin.json`:

```json
{ "mcpServers": { "skill-router": { "command": "node", "args": ["scripts/router.mjs", "--mcp"], "cwd": "." } } }
```

`src/mcp.mjs` implements newline-delimited JSON-RPC 2.0 by hand (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`); no SDK dependency, so the plugin stays a single bundled file.

Tool schema:

- `task_description` (string, required, 1..24,000 bytes).
- `cwd` (string, required, absolute). The MCP process runs in the plugin root while the skill catalog depends on the task's project, so the model must pass the task's working directory; a silent fallback would return the wrong catalog.

The tool description tells the model to call it before starting work when its context has no `## Skills` list. Tool descriptions reach the model even when hooks did not run (untrusted hook, crash, timeout), which is the only lever the plugin has in those cases.

Behaviour: guard → catalog → rank → keep relevance >= `searchMinRelevance` (default 0.8) → sort descending → first `searchMaxResults` (default 10). Result text is the same Codex-style lines prefixed with the relevance, or "No skill met the relevance threshold." Errors are returned as `isError: true` with a sanitized code. Calls are recorded in history with `source: "search"`.

### Guard for `skills.include_instructions` (req. 6)

`config/read` for the task cwd must return `skills.include_instructions === false`. Otherwise:

- `UserPromptSubmit` returns `{decision:"block", reason:"Skill Router requires skills.include_instructions = false ..."}` with the two-line config fix. Codex does not process the prompt. The check runs on every prompt.
- `search_skills` returns `isError` with the same text.
- One guard boundary: in the `UserPromptSubmit` path, any failure before `include_instructions === false` is confirmed produces a block. That includes unparsable hook stdin, an invalid router config, a missing Codex binary and an app-server error. The reason carries the error code and, for a missing binary, the hint to set `codexBin` to an absolute path (the desktop app's `PATH` may not contain `codex`). Failures after the guard passed never block.
- `JEV_SKILL_ROUTER_DISABLED=1` remains the escape hatch and skips the guard.

What the guard cannot cover, stated in the README: Codex lets the prompt through when the hook is untrusted or disabled, when `node` is missing, or when the hook process crashes or exceeds its hook timeout; and the check reads persisted configuration layers for that cwd, so a one-off `-c skills.include_instructions=true`, a `--profile`, or an app-side override is not visible to the hook process.

### Configuration

`~/.config/jev-skill-router/config.json` (path unchanged). Unknown keys are still rejected, with one exception: the removed keys `apiKey`, `threshold`, `maxSkills` are accepted and ignored so an old file does not break routing, and `--list` reports them as obsolete. An old `model` value starting with `jev-` (every existing config file has `jev-latest`) is treated as unset.

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `gpt-6-luna` | Helper model slug as known to the configured Codex provider. |
| `reasoningEffort` | `medium` | Passed as `effort`; any non-empty string Codex accepts. |
| `searchMaxResults` | `10` | 1..50. |
| `searchMinRelevance` | `0.8` | 0..1. |
| `timeoutMs` | `45000` | Shared deadline for one hook/tool invocation, 1,000..120,000. |
| `codexBin`, `recordSelections`, `dashboardAutoStart`, `dashboardPort`, `dataDir` | unchanged | |

The `UserPromptSubmit` hook timeout in `hooks.json` rises from 30 to 130 s so the router's own deadline always fires first. Environment variable names keep the `JEV_` prefix and the plugin keeps its id, so existing installs, hook trust and the LaunchAgent keep working; only user-facing text stops mentioning Jev/TypeSafe. Error codes move from `JEV_*` to `SKILLS_*`.

### History and dashboard

Record `version: 2` adds `source` (`initial`|`search`), `reasoningEffort`, `budget`, `omittedCount`; `selected` holds the injected or returned skills with `probability` = relevance; `threshold` is `null` for `initial` and `maxSkills` is dropped. New status `unranked` covers the helper-failure fallback. Dashboard changes are kept minimal for 0.5.0: it reads both versions, shows `source`, injected count and omitted count, and labels the column "relevance". Existing metric definitions are not reworked. Prompts and task descriptions are still never stored.

## Testing

Tests use a fake `codexBin` (a Node script speaking the app-server protocol) so no network or real model is needed:

- client: handshake, thread overrides (tools off, MCP servers disabled, no `modelProvider`), model/effort passed through, unexpected server request aborts, non-read-only sandbox rejected, timeout kills the child.
- ranker: prompt contains only names/descriptions (no path, no body); invalid/missing/duplicate ids rejected; batching.
- hook: guard blocks for `true`, unset, unreadable config, invalid router config and bad stdin; first prompt injects sorted list; second prompt with same session id injects nothing and makes no model call; same `session_id` with a different `agent_id` injects again; a failed run leaves no session file; `SessionStart` compact re-emits the cached block without spawning Codex; token budget (all three tiers) truncation with omitted count and no count cap; helper failure yields the unranked list.
- MCP: `tools/list` schema, threshold and max results, required `cwd`, guard error; the committed `.mcp.json` has no placeholders, a relative `cwd`, and its script path exists relative to the plugin root.
- config: defaults, obsolete keys tolerated, bounds.
- existing dashboard/autostart tests keep passing; analytics tests extended for v2 records.

`npm run build` regenerates the committed bundle. README.md and README-cn.md are rewritten for the new behaviour; `plugin.json`, `hooks.json` descriptions and `config.example.json` are updated; version becomes 0.5.0.

## Decisions from review round 1

- No relevance floor for injection; ordering alone carries the ranking (reviewer agreed).
- Compaction re-send is in scope (cached block, `SessionStart` compact).
- `search_skills` requires `cwd`; no shared hook-to-tool state.
- Default slug `gpt-6-luna`; an unknown slug surfaces as `unranked` plus a `systemMessage`.
- Not adopted: detecting the initial task by scanning `transcript_path`. The session cache file is needed for compaction anyway, and writing it only after a successful render already fixes the "killed hook leaves the session without a list" problem without depending on the transcript format. Consequence: a forked session gets a fresh ranking even though its history already holds the parent's block.
- Not adopted: a `tool_timeout_sec` entry. Codex's default MCP tool timeout is 300 s (`rmcp_client.rs` `DEFAULT_TOOL_TIMEOUT`), above the router's maximum `timeoutMs` of 120 s.
- Kept against the reviewer's "cut": treating an old `jev-*` model value as unset. Every existing config file contains `jev-latest`; passing it to Codex would make every ranking fail.

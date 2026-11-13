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

On **every prompt**, the hook checks the effective persisted config for the task directory. Unless it confirms this exact value, it blocks the prompt and reports why. Only an incompatible native setting produces the TOML fix; other errors identify what prevented verification. Unreadable router config, malformed input, and a missing Codex executable also block. If the desktop app cannot find Codex, set `codexBin` to its absolute path.

Codex may still process the prompt if the hook is disabled, untrusted, missing Node, crashes, or exceeds its hook timeout. The hook cannot see transient caller overrides such as `-c skills.include_instructions=true`, `--profile`, or app-side settings. Set `JEV_SKILL_ROUTER_DISABLED=1` to bypass the hook, including its guard. Restore native skill instructions if you stop using the plugin.

## What reaches the model

The helper scores **names and short descriptions** against the task. The plugin never reads skill bodies; it reads policy metadata to skip manual-only skills and filters disabled, duplicate and missing skills. Each batch runs in an ephemeral read-only thread with tools disabled, in a fresh empty directory. Your user-level provider (including a custom base URL) and global instructions still apply; project-only provider overrides do not. Task text and short descriptions go to that provider.

Image-only or whitespace-only prompts pass the guard without using the session’s initial ranking. For long text prompts, the helper scores the first 24,000 UTF-8 bytes (ending at a whole character); Codex receives the full prompt. Hook input supports up to 8 MiB of JSON.

The main thread receives whole lines in descending relevance order: `- name: description (file: /path/SKILL.md)`. Injection has no relevance floor or count limit. Its budget follows Codex: `skills.max_context_tokens` (at most 10,000), otherwise 2% of the session model context window (read from the Codex model catalog), otherwise 8,000 characters. Each line costs approximately one token per four UTF-8 bytes. A note counts omitted skills. Explicit user requests still take precedence.

To list a skill in every initial injection regardless of relevance, set `policy.skill_router_always_injected_in_initial_turn: true` in its `agents/openai.yaml`. Such skills skip the helper, sit at the top of the list and are never dropped for budget (their cost still counts against it). The flag also lists a manual-only skill (`allow_implicit_invocation: false`); `search_skills` keeps skipping manual-only skills.

Spawned subagents inherit the parent session's list through the `SubagentStart` hook, with no model call (Codex sends them no `UserPromptSubmit`). If the parent has no list yet, they get the budgeted catalog unranked. Resume reuses the cache; forks rank anew. Root compaction restores the cached list without a model call, possibly on the next turn. Codex does not emit that event for subagents. Cached lists expire after 30 days. If ranking fails, the hook caches the budgeted catalog in its original order and reports a safe error code. If discovery fails, it reports the error and retries next prompt.

For a different task, call `search_skills` with `task_description` (1–24,000 UTF-8 bytes) and `cwd` (absolute task directory). It applies the same guard, filters by relevance, then returns up to the configured limit. No matches and service errors produce distinct results.

## Router settings

Optional file: `~/.config/jev-skill-router/config.json`. See [config.example.json](config.example.json).

| Key | Default | Meaning |
| --- | --- | --- |
| model | gpt-6-luna | Model slug supported by your provider |
| reasoningEffort | medium | Effort supported by that model |
| searchMaxResults | 10 | Search results, 1–50 |
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

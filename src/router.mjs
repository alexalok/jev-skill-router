import { resolveProject } from './app-projects.mjs';
import { mkdtemp, realpath, rm, readFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { appendSelection } from './records.mjs';
import { ensureDashboard, startDashboard } from './dashboard.mjs';
import { installAppStartup, removeAppStartup, startDashboardForApp } from './app-startup.mjs';
import { fail, isObject, errorCode } from './common.mjs';
import { eligibleSkills, catalogBudget, catalogLine, contextWindow, pinnedFirst, render } from './catalog.mjs';
import { openClient } from './codex-client.mjs';
import { rank } from './ranker.mjs';
import { sessionPath, prepareSessions, cached, acquire, saveBlock } from './session-state.mjs';
import { serve } from './mcp.mjs';

export async function loadConfig(env = process.env) {
  const file = env.JEV_SKILL_ROUTER_CONFIG || join(homedir(), '.config', 'jev-skill-router', 'config.json');
  let saved = {};
  try {
    saved = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || env.JEV_SKILL_ROUTER_CONFIG) throw fail('SKILLS_CONFIG_INVALID');
  }
  if (!isObject(saved)) throw fail('SKILLS_CONFIG_INVALID');
  const config = {
    reasoningEffort: saved.reasoningEffort ?? 'medium',
    model: typeof saved.model === 'string' && saved.model.startsWith('jev-') ? 'gpt-6-luna' : saved.model ?? 'gpt-6-luna',
    initialMinRelevance: saved.initialMinRelevance ?? 0.8,
    searchMinRelevance: saved.searchMinRelevance ?? 0.8,
    searchMaxResults: saved.searchMaxResults ?? 10,
    timeoutMs: saved.timeoutMs ?? 45000,
    codexBin: env.JEV_CODEX_BIN ?? saved.codexBin ?? 'codex',
    recordSelections: saved.recordSelections ?? true,
    dashboardAutoStart: saved.dashboardAutoStart ?? true,
    dashboardPort: saved.dashboardPort ?? 4318,
    dataDir: env.JEV_SKILL_ROUTER_DATA_DIR ?? saved.dataDir ?? join(homedir(), '.local', 'share', 'jev-skill-router'),
  };
  const obsolete = ['apiKey', 'threshold', 'maxSkills'].filter(key => Object.hasOwn(saved, key));
  if (Object.keys(saved).some(key => !Object.hasOwn(config, key) && !obsolete.includes(key)) ||
      ![config.model, config.reasoningEffort].every(v => typeof v === 'string' && v.trim() && v.length <= 100) ||
      ![config.initialMinRelevance, config.searchMinRelevance].every(v => Number.isFinite(v) && v >= 0 && v <= 1) ||
      !Number.isInteger(config.searchMaxResults) || config.searchMaxResults < 1 || config.searchMaxResults > 50 ||
      !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120000 ||
      typeof config.codexBin !== 'string' || !config.codexBin.trim() ||
      typeof config.recordSelections !== 'boolean' || typeof config.dataDir !== 'string' ||
      typeof config.dashboardAutoStart !== 'boolean' || !Number.isInteger(config.dashboardPort) ||
      config.dashboardPort < 1 || config.dashboardPort > 65535 ||
      !isAbsolute(config.dataDir) || config.dataDir.includes('\0')) throw fail('SKILLS_CONFIG_INVALID');
  return { ...config, obsolete };
}

async function boundedText(stream, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) throw fail('SKILLS_INPUT_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const fix = 'Skill Router requires skills.include_instructions = false. Set in Codex config.toml:\n[skills]\ninclude_instructions = false';
function block(error) {
  const code = errorCode(error);
  if (code === 'SKILLS_NATIVE_INSTRUCTIONS') return { decision: 'block', reason: fix + '\n' + code + '.' };
  let hint = '';
  if (code === 'SKILLS_CODEX_UNAVAILABLE') hint = ' Set codexBin to an absolute path if codex is missing from PATH.';
  if (code === 'SKILLS_CONFIG_INVALID') hint = ' Check router config: ' +
    (process.env.JEV_SKILL_ROUTER_CONFIG || '~/.config/jev-skill-router/config.json') + '.';
  return { decision: 'block', reason: `Skill Router could not confirm skills.include_instructions = false (${code}).${hint}` };
}
function initialTask(prompt) {
  // write() stops before a partial UTF-8 character; Codex still gets the original prompt.
  if (Buffer.byteLength(prompt) <= 24000) return prompt;
  const prefix = Buffer.allocUnsafe(24000);
  return prefix.toString('utf8', 0, prefix.write(prompt));
}
async function guard(client, cwd) {
  const config = await client.readConfig(cwd);
  if (config.skills?.include_instructions !== false) throw fail('SKILLS_NATIVE_INSTRUCTIONS');
  return config;
}
const context = (event, block) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: block } });
function recordFor(source, cwd, sessionId, config) {
  return { version: 2, id: randomUUID(), timestamp: new Date().toISOString(), cwd,
    sessionId: typeof sessionId === 'string' && sessionId.length <= 200 ? sessionId : null,
    source, model: config.model, reasoningEffort: config.reasoningEffort, threshold: source === 'search' ? config.searchMinRelevance : null,
    budget: null, omittedCount: 0, candidateCount: null, selected: [], status: 'error', errorCode: null, durationMs: 0 };
}
async function record(config, event, start) {
  if (!config.recordSelections) return;
  event.durationMs = Math.round(performance.now() - start);
  await appendSelection(config.dataDir, event);
}
const selectedRecord = ({ name, path, probability = null }) => ({ name, path, probability });

async function rankedCatalog(prompt, skills, client, config, effective, model, event) {
  event.candidateCount = skills.length;
  event.budget = catalogBudget(effective, await contextWindow(effective, model));
  let ordered;
  // Pinned skills skip the helper; history records them at relevance 1.
  try {
    const ranked = await rank(initialTask(prompt), skills.filter(s => !s.pinned), client, config, effective, config.initialMinRelevance);
    ordered = [...skills.filter(s => s.pinned).map(s => ({ ...s, probability: 1 })), ...ranked];
    event.threshold = config.initialMinRelevance;
  } catch (error) { event.errorCode = errorCode(error); ordered = pinnedFirst(skills); }
  const rendered = render(ordered, event.budget, event.errorCode && 'helper unavailable: ' + event.errorCode);
  event.selected = rendered.selected.map(selectedRecord);
  event.omittedCount = skills.length - event.selected.length;
  event.status = event.errorCode ? 'unranked' : !skills.length ? 'no_candidates' : event.selected.length ? 'selected' : 'none';
  return rendered;
}

const threadMarker = '<!-- skill-router:create-thread:v2 ';
const threadEnd = '<!-- /skill-router:create-thread:v2 -->';
function attachedThreadCatalog(prompt) {
  if (typeof prompt !== 'string') return null;
  prompt = prompt.trimEnd();
  if (!prompt.endsWith('\n' + threadEnd)) return null;
  const start = prompt.lastIndexOf('\n\n' + threadMarker);
  if (start < 0) return null;
  const end = prompt.indexOf(' -->\n', start);
  if (end < 0) return null;
  try {
    const metadata = JSON.parse(prompt.slice(start + 2 + threadMarker.length, end));
    const block = prompt.slice(end + 5, -threadEnd.length - 1);
    if (typeof metadata.key !== 'string' || !block.startsWith('## Skills\n')) return null;
    return { task: prompt.slice(0, start), metadata, block };
  } catch { return null; }
}

const threadKey = (task, args) => createHash('sha256').update(JSON.stringify([task, args.target, args.model ?? null])).digest('hex');
function stripInvalidatedThreadCatalog(input) {
  const args = input?.tool_input;
  if (input?.tool_name !== 'mcp__codex_app__create_thread' || !isObject(args)) return {};
  const attached = attachedThreadCatalog(args.prompt);
  if (!attached || attached.metadata.key === threadKey(attached.task, args)) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { ...args, prompt: attached.task } } };
}

// A create_thread opening turn can skip UserPromptSubmit. Route on the caller,
// without borrowing its project config or writing its session cache.
async function createThread(input, config) {
  const args = input.tool_input;
  if (input.tool_name !== 'mcp__codex_app__create_thread' || !isObject(args) ||
      !isObject(args.target) || !['projectless', 'project'].includes(args.target.type) ||
      typeof args.prompt !== 'string' || !args.prompt.trim()) return stripInvalidatedThreadCatalog(input);
  if (args.target.type === 'project' && (typeof args.target.projectId !== 'string' ||
      !['local', 'worktree'].includes(args.target.environment?.type ?? 'local'))) return stripInvalidatedThreadCatalog(input);
  const attached = attachedThreadCatalog(args.prompt);
  const task = attached?.task ?? args.prompt;
  const key = threadKey(task, args);
  if (attached?.metadata.key === key) return {};
  let temporary, cwd, client, event, output = {};
  const started = performance.now();
  try {
    // Destination directory does not exist yet. A neutral cwd discovers global
    // and plugin skills without pretending the parent's repository is the target.
    cwd = args.target.type === 'project' ? await resolveProject(args.target, input) :
      (temporary = await realpath(await mkdtemp(join(tmpdir(), 'skill-router-thread-'))));
    event = recordFor('create_thread', cwd, input.session_id, config);
    client = await openClient(config, cwd);
    const effective = await guard(client, cwd);
    const catalog = await client.listSkills(cwd);
    const skills = await eligibleSkills({ ...catalog,
      skills: args.target.type === 'project' ? catalog.skills :
        catalog.skills.filter(skill => ['user', 'system', 'admin'].includes(skill.scope)) });
    const rendered = await rankedCatalog(task, skills, client, config, effective, args.model, event);
    if (args.target.environment?.type === 'worktree') {
      rendered.block = rendered.block.replace('These are the skills available for this task',
        'These are source-checkout skill candidates, not verified destination contents, selected for this task');
      rendered.block += '\n\nSkills were taken from the main worktree and, in rare cases, may have drifted from this worktree.';
    }
    output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { ...args, prompt: task + '\n\n' + threadMarker + JSON.stringify({ key, session: input.session_id ?? null }) + ' -->\n' + rendered.block + '\n' + threadEnd } } };
    if (event.errorCode) output.systemMessage = `Skill Router helper unavailable (${event.errorCode}); using catalog order.`;
  } catch (error) {
    if (event) event.errorCode = errorCode(error);
    output = { ...stripInvalidatedThreadCatalog(input),
      systemMessage: `Skill Router unavailable for new thread (${errorCode(error)}); ${attached ? 'stale catalog removed' : 'opening prompt unchanged'}.` };
  } finally {
    client?.close();
    if (event) {
      try { await record(config, event, started); }
      catch { output.systemMessage = [output.systemMessage, 'Skill Router history unavailable (SKILLS_RECORD_UNAVAILABLE).'].filter(Boolean).join(' '); }
    }
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
  return output;
}


// Exact tool names only: Agent is a matcher alias, not a different argument schema.
const spawnTools = new Set(['collaborationspawn_agent', 'spawn_agent']);
const agentMarker = '<!-- skill-router:subagent:v1 ';
const agentEnd = '<!-- /skill-router:subagent:v1 -->';
const agentNote = 'This catalog was selected for your own task. Use it instead of any Skill Router catalog inherited from parent history.';
const taskKey = (task, cwd, model) => createHash('sha256').update(JSON.stringify([task, cwd, model ?? null])).digest('hex');
function attachedCatalog(message) {
  if (typeof message !== 'string') return null;
  message = message.trimEnd();
  if (!message.endsWith('\n' + agentEnd)) return null;
  const start = message.lastIndexOf('\n\n' + agentMarker);
  if (start < 0) return null;
  const headerEnd = message.indexOf(' -->\n', start);
  if (headerEnd < 0) return null;
  try {
    const metadata = JSON.parse(message.slice(start + 2 + agentMarker.length, headerEnd));
    const block = message.slice(headerEnd + 5, -agentEnd.length - 1);
    if (!isObject(metadata) || typeof metadata.key !== 'string' || !block.startsWith(agentNote + '\n## Skills\n')) return null;
    return { task: message.slice(0, start), block, metadata };
  } catch { return null; }
}

function spawnContext(input, args) {
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || input.cwd.includes('\0') ||
      (args.cwd !== undefined && (typeof args.cwd !== 'string' || !args.cwd.trim() || args.cwd.includes('\0'))))
    throw fail('SKILLS_INPUT_INVALID');
  return { cwd: resolve(input.cwd, args.cwd ?? '.'), model: args.model ?? input.model };
}
function stripInvalidatedAgentCatalog(input) {
  const args = input?.tool_input;
  if (!spawnTools.has(input?.tool_name) || !isObject(args)) return {};
  const attached = attachedCatalog(args.message);
  if (!attached) return {};
  try {
    const { cwd, model } = spawnContext(input, args);
    if (attached.metadata.key === taskKey(attached.task, cwd, model)) return {};
  } catch { /* An invalid destination cannot validate the old catalog. */ }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { ...args, message: attached.task } } };
}

// Rank before spawning; the child id is not known yet. Never use or update the
// calling agent's cache, including when this is a nested spawn.
async function spawnAgent(input, config) {
  const args = input.tool_input;
  if (!spawnTools.has(input.tool_name) || !isObject(args) ||
      typeof args.message !== 'string' || !args.message.trim()) return {};
  let client, event, output = {};
  const started = performance.now();
  try {
    const { cwd, model } = spawnContext(input, args);
    const attached = attachedCatalog(args.message);
    const task = attached?.task ?? args.message;
    const key = taskKey(task, cwd, model);
    if (attached?.metadata.key === key) return {};
    event = recordFor('subagent', cwd, input.session_id, config);
    client = await openClient(config, cwd);
    const effective = await guard(client, cwd);
    const skills = await eligibleSkills(await client.listSkills(cwd));
    const rendered = await rankedCatalog(task, skills, client, config, effective, model, event);
    const metadata = JSON.stringify({ key, session: input.session_id ?? null, agent: input.agent_id ?? null });
    const message = task + '\n\n' + agentMarker + metadata + ' -->\n' + agentNote + '\n' + rendered.block + '\n' + agentEnd;
    output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { ...args, message } } };
    if (event.errorCode) output.systemMessage = `Skill Router helper unavailable (${event.errorCode}); using catalog order.`;
  } catch (error) {
    if (event) event.errorCode = errorCode(error);
    const stripped = stripInvalidatedAgentCatalog(input);
    output = { ...stripped, systemMessage: `Skill Router unavailable for subagent (${errorCode(error)}); ${stripped.hookSpecificOutput ? 'stale catalog removed' : 'task message unchanged'}.` };
  } finally {
    client?.close();
    if (event) {
      try { await record(config, event, started); }
      catch { output.systemMessage = [output.systemMessage, 'Skill Router history unavailable (SKILLS_RECORD_UNAVAILABLE).'].filter(Boolean).join(' '); }
    }
  }
  return output;
}

// Only initial prompt routing is filtered. Unknown metadata preserves routing.
async function skipInitialRouting(input) {
  if (input?.hook_event_name !== 'UserPromptSubmit') return false;
  if (input.transcript_path == null) return true;
  if (typeof input.transcript_path !== 'string' || !isAbsolute(input.transcript_path)) return false;
  let file;
  try {
    // Nonblocking open plus regular-file check also avoids hanging on a FIFO.
    file = await open(input.transcript_path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) return false;
    const chunks = [];
    let size = 0;
    while (size < 256 * 1024) {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await file.read(buffer);
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
      size += bytesRead;
      if (newline >= 0 || !bytesRead) {
        const entry = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return entry?.type === 'session_meta' &&
          (entry.payload?.thread_source === 'guardian_review' ||
           entry.payload?.source?.subagent?.other === 'guardian');
      }
    }
  } catch { /* Missing, malformed or oversized metadata is not an exclusion. */ }
  finally { await file?.close().catch(() => {}); }
  return false;
}

export async function route(input, config) {
  if (!isObject(input) || typeof input.hook_event_name !== 'string') return block(fail('SKILLS_INPUT_INVALID'));
  if (input.hook_event_name === 'PreToolUse')
    return input.tool_name === 'mcp__codex_app__create_thread' ? createThread(input, config) : spawnAgent(input, config);
  if (input.hook_event_name === 'SessionStart' && input.source === 'compact') {
    try {
      const saved = await cached(sessionPath(config.dataDir, input.session_id, input.agent_id));
      return saved ? context('SessionStart', saved) : {};
    } catch { return { systemMessage: 'Skill Router cache unavailable (SKILLS_CACHE_UNAVAILABLE).' }; }
  }
  if (input.hook_event_name !== 'UserPromptSubmit') return {};
  if (await skipInitialRouting(input)) return {};
  if (typeof input.prompt !== 'string' || typeof input.cwd !== 'string' || !isAbsolute(input.cwd))
    return block(fail('SKILLS_INPUT_INVALID'));
  const cwd = resolve(input.cwd), started = performance.now(), event = recordFor('initial', cwd, input.session_id, config);
  let client, effective, release, output, path, pendingBlock;
  try {
    client = await openClient(config, cwd);
    effective = await guard(client, cwd);
    if (!input.prompt.trim()) return {};
    const attached = attachedCatalog(input.prompt);
    // Some clients also submit the rewritten opening message as a prompt. It is
    // already visible: adopt only under an identity distinct from the caller.
    if (attached) {
      const childIdentity = typeof attached.metadata.session === 'string' && attached.metadata.session &&
        typeof input.session_id === 'string' && input.session_id &&
        (input.session_id !== attached.metadata.session ||
          (typeof input.agent_id === 'string' && input.agent_id && input.agent_id !== attached.metadata.agent));
      if (childIdentity) {
        path = sessionPath(config.dataDir, input.session_id, input.agent_id);
        if (path) {
          await prepareSessions(config.dataDir);
          release = await acquire(path, config.timeoutMs);
          if (release && !await cached(path)) await saveBlock(path, attached.block);
        }
      }
      return {};
    }
    const threadAttached = attachedThreadCatalog(input.prompt);
    if (threadAttached) {
      if (typeof threadAttached.metadata.session === 'string' && threadAttached.metadata.session &&
          typeof input.session_id === 'string' && input.session_id && input.session_id !== threadAttached.metadata.session) {
        path = sessionPath(config.dataDir, input.session_id, input.agent_id);
        if (path) {
          await prepareSessions(config.dataDir);
          release = await acquire(path, config.timeoutMs);
          if (release && !await cached(path)) await saveBlock(path, threadAttached.block);
        }
      }
      return {};
    }

    path = sessionPath(config.dataDir, input.session_id, input.agent_id);
    if (path) {
      if (await cached(path)) return {};
      await prepareSessions(config.dataDir);
      release = await acquire(path, config.timeoutMs);
      if (!release || await cached(path)) return {};
    }
    const skills = await eligibleSkills(await client.listSkills(cwd));
    const rendered = await rankedCatalog(input.prompt, skills, client, config, effective, input.model, event);
    output = context('UserPromptSubmit', rendered.block);
    if (event.errorCode) output.systemMessage = `Skill Router helper unavailable (${event.errorCode}); using catalog order.`;
    pendingBlock = rendered.block;
  } catch (error) {
    event.errorCode = errorCode(error);
    output = effective ? { systemMessage: `Skill Router unavailable (${event.errorCode}); next prompt will retry.` } : block(error);
  } finally {
    client?.close();
    try {
      if (output) {
        try { await record(config, event, started); }
        catch { output.systemMessage = [output.systemMessage, 'Skill Router history unavailable (SKILLS_RECORD_UNAVAILABLE).'].filter(Boolean).join(' '); }
        if (pendingBlock) await saveBlock(path, pendingBlock);
      }
    } catch { output.systemMessage = 'Skill Router cache unavailable (SKILLS_CACHE_UNAVAILABLE); next prompt will retry.'; }
    finally { await release?.().catch(() => {}); }
  }
  return output;
}

export async function search({ task_description: task, cwd }, config) {
  if (process.env.JEV_SKILL_ROUTER_DISABLED === '1') throw fail('SKILLS_DISABLED');
  const start = performance.now(), event = recordFor('search', cwd, null, config);
  let client, effective;
  try {
    client = await openClient(config, cwd);
    effective = await guard(client, cwd);
    const skills = (await eligibleSkills(await client.listSkills(cwd))).filter(s => s.implicit);
    event.candidateCount = skills.length;
    const selected = (await rank(task, skills, client, config, effective, config.searchMinRelevance)).slice(0, config.searchMaxResults);
    event.selected = selected.map(selectedRecord); event.omittedCount = skills.length - selected.length;
    event.status = !skills.length ? 'no_candidates' : selected.length ? 'selected' : 'none';
    return selected.map(s => s.probability.toFixed(2) + ' ' + catalogLine(s)).join('\n') || 'No skill met the relevance threshold.';
  } catch (error) {
    event.errorCode = errorCode(error);
    if (!effective) error.guardMessage = block(error).reason;
    throw error;
  } finally { client?.close(); await record(config, event, start).catch(() => {}); }
}

async function main() {
  if (process.env.JEV_SKILL_ROUTER_DISABLED === '1' && process.argv.length === 2) return {};
  if (process.argv[2] === '--remove-app-startup') {
    if (process.argv.length !== 3) throw fail('SKILLS_ARGUMENT_INVALID');
    await removeAppStartup();
    process.stdout.write('Removed Skill Router dashboard app startup. Selection history is preserved.\n');
    return;
  }
  if (process.argv[2] === '--mcp') return serve(async args => {
    let config;
    try { config = await loadConfig(); } catch (error) { error.guardMessage = block(error).reason; throw error; }
    return search(args, config);
  });
  let input;
  if (process.argv.length === 2) {
    try { input = JSON.parse(await boundedText(process.stdin, 8 * 1024 * 1024)); } catch { throw fail('SKILLS_INPUT_INVALID'); }
  }
  // Excluded threads must not start the dashboard or enforce routing config.
  if (await skipInitialRouting(input)) return {};
  let config;
  try { config = await loadConfig(); } catch (error) {
    if (input?.hook_event_name === 'PreToolUse') {
      const output = input.tool_name === 'mcp__codex_app__create_thread'
        ? stripInvalidatedThreadCatalog(input) : stripInvalidatedAgentCatalog(input);
      return { ...output, systemMessage: errorCode(error) + (output.hookSpecificOutput ? '; stale catalog removed.' : '') };
    }
    if (input?.hook_event_name === 'SessionStart') return { systemMessage: errorCode(error) };
    throw error;
  }
  if (['--install-app-startup', '--app-startup-check'].includes(process.argv[2])) {
    if (process.argv.length !== 3) throw fail('SKILLS_ARGUMENT_INVALID');
    if (process.argv[2] === '--install-app-startup') {
      const plist = await installAppStartup(process.argv[1]);
      process.stdout.write(`Skill Router dashboard will start when Codex opens (macOS): ${plist}\n`);
    } else if (process.env.JEV_SKILL_ROUTER_DISABLED !== '1') {
      await startDashboardForApp(config, process.argv[1]);
    }
    return;
  }
  if (['--dashboard', '--dashboard-auto'].includes(process.argv[2])) {
    const automatic = process.argv[2] === '--dashboard-auto';
    const args = process.argv.slice(3);
    if (args.length && (automatic || args.length !== 2 || args[0] !== '--port' || !/^\d+$/u.test(args[1]))) throw fail('SKILLS_ARGUMENT_INVALID');
    const port = args.length ? Number(args[1]) : config.dashboardPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('SKILLS_ARGUMENT_INVALID');
    const server = await startDashboard({ dataDir: config.dataDir, recordingEnabled: config.recordSelections,
      routingEnabled: process.env.JEV_SKILL_ROUTER_DISABLED !== '1', port, idleTimeoutMs: automatic ? 30 * 60 * 1000 : 0 });
    process.stdout.write(`Skill Router dashboard: http://127.0.0.1:${server.address().port}\n`);
    return;
  }
  if (process.argv[2] === '--list') {
    const cwd = process.cwd(), client = await openClient(config, cwd);
    try {
      const catalog = await client.listSkills(cwd), skills = await eligibleSkills(catalog);
      return { model: config.model, reasoningEffort: config.reasoningEffort, obsolete: config.obsolete,
        catalogCount: catalog.skills.length, candidateCount: skills.length, catalogErrors: catalog.errors?.length ?? 0,
        skills: skills.map(({ name, path, pinned }) => ({ name, path, ...(pinned && { pinned }) })) };
    } finally { client.close(); }
  }
  if (process.argv.length > 2) throw fail('SKILLS_ARGUMENT_INVALID');
  const autoStart = isObject(input) && ['SessionStart', 'UserPromptSubmit'].includes(input.hook_event_name) &&
    typeof input.cwd === 'string' && isAbsolute(input.cwd) &&
    (input.hook_event_name === 'SessionStart' || (typeof input.prompt === 'string' && input.prompt.trim()));
  const [output, warning] = await Promise.all([
    route(input, config),
    autoStart ? ensureDashboard(config, process.argv[1]).catch(error =>
      `Skill Router dashboard unavailable (${errorCode(error)}). Check dashboardPort or start it manually; skill routing continues.`) : undefined,
  ]);
  if (warning) output.systemMessage = [output.systemMessage, warning].filter(Boolean).join(' ');
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    if (process.argv.length > 2) process.exitCode = 1;
    return process.argv.length === 2 ? block(error) : { systemMessage: errorCode(error) };
  }).then(output => { if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`); });
}

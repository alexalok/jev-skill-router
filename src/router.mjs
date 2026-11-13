import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
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
      !Number.isFinite(config.searchMinRelevance) || config.searchMinRelevance < 0 || config.searchMinRelevance > 1 ||
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

// Codex fires SubagentStart, not UserPromptSubmit, for spawned agents: hand them the parent's list.
async function subagentStart(input, config) {
  let client;
  try {
    let block = await cached(sessionPath(config.dataDir, input.session_id));
    if (block) block = 'Skill list inherited from the parent session; it was ranked for the parent\'s initial request, not for your task. If none of these skills fits your task, call the search_skills tool with your task description and working directory before starting work.\n' + block;
    else {
      if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) return {};
      const cwd = resolve(input.cwd);
      client = await openClient({ ...config, timeoutMs: Math.min(config.timeoutMs, 15000) }, cwd);
      const effective = await client.readConfig(cwd);
      if (effective.skills?.include_instructions !== false) return {}; // Native list is present.
      block = render(pinnedFirst(await eligibleSkills(await client.listSkills(cwd))), catalogBudget(effective, await contextWindow(effective, input.model)), 'no ranked list from the parent session').block;
      await prepareSessions(config.dataDir);
    }
    // A later prompt addressed to this agent must not rank and inject a second list.
    await saveBlock(sessionPath(config.dataDir, input.session_id, input.agent_id), block).catch(() => {});
    return context('SubagentStart', block);
  } catch (error) { return { systemMessage: `Skill Router unavailable for subagent (${errorCode(error)}).` }; }
  finally { client?.close(); }
}

export async function route(input, config) {
  if (!isObject(input) || typeof input.hook_event_name !== 'string') return block(fail('SKILLS_INPUT_INVALID'));
  if (input.hook_event_name === 'SubagentStart') return subagentStart(input, config);
  if (input.hook_event_name === 'SessionStart' && input.source === 'compact') {
    try {
      const saved = await cached(sessionPath(config.dataDir, input.session_id));
      return saved ? context('SessionStart', saved) : {};
    } catch { return { systemMessage: 'Skill Router cache unavailable (SKILLS_CACHE_UNAVAILABLE).' }; }
  }
  if (input.hook_event_name !== 'UserPromptSubmit') return {};
  if (typeof input.prompt !== 'string' || typeof input.cwd !== 'string' || !isAbsolute(input.cwd))
    return block(fail('SKILLS_INPUT_INVALID'));
  const cwd = resolve(input.cwd), started = performance.now(), event = recordFor('initial', cwd, input.session_id, config);
  let client, effective, release, output, path, pendingBlock;
  try {
    client = await openClient(config, cwd);
    effective = await guard(client, cwd);
    if (!input.prompt.trim()) return {};
    path = sessionPath(config.dataDir, input.session_id, input.agent_id);
    if (path) {
      if (await cached(path)) return {};
      await prepareSessions(config.dataDir);
      release = await acquire(path, config.timeoutMs);
      if (!release || await cached(path)) return {};
    }
    const skills = await eligibleSkills(await client.listSkills(cwd));
    event.candidateCount = skills.length;
    event.budget = catalogBudget(effective, await contextWindow(effective, input.model));
    let ordered;
    // Pinned skills skip the helper; history records them at relevance 1.
    try { ordered = [...skills.filter(s => s.pinned).map(s => ({ ...s, probability: 1 })), ...await rank(initialTask(input.prompt), skills.filter(s => !s.pinned), client, config, effective)]; }
    catch (error) { event.errorCode = errorCode(error); ordered = pinnedFirst(skills); }
    const rendered = render(ordered, event.budget, event.errorCode && 'helper unavailable: ' + event.errorCode);
    event.selected = rendered.selected.map(selectedRecord);
    event.omittedCount = rendered.omittedCount;
    event.status = event.errorCode ? 'unranked' : !skills.length ? 'no_candidates' : event.selected.length ? 'selected' : 'none';
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
    const selected = (await rank(task, skills, client, config, effective)).filter(s => s.probability >= config.searchMinRelevance).slice(0, config.searchMaxResults);
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
  let config;
  try { config = await loadConfig(); } catch (error) {
    if (['SessionStart', 'SubagentStart'].includes(input?.hook_event_name)) return { systemMessage: errorCode(error) };
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

import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { parseDocument } from 'yaml';
import { isObject } from './common.mjs';

export async function eligibleSkills(catalog) {
  const seen = new Set();
  const skills = [];
  for (const skill of catalog.skills) {
    if (skill.enabled !== true || typeof skill.name !== 'string' || !skill.name.trim() ||
        typeof skill.description !== 'string' || !skill.description.trim() ||
        typeof skill.path !== 'string' || !isAbsolute(skill.path)) continue;
    try {
      const path = await realpath(skill.path);
      if (seen.has(path)) continue;
      // Codex 0.154's skills/list omits policy; parse its actual YAML metadata locally.
      // Pinned skills are always listed in the initial turn, even when they are manual-only.
      let valid = true, implicit = true, pinned = false;
      for (const root of new Set([dirname(skill.path), dirname(path)])) {
        try {
          const document = parseDocument(await readFile(join(root, 'agents', 'openai.yaml'), 'utf8'));
          if (document.errors.length) { valid = false; break; }
          const metadata = document.toJS({ maxAliasCount: 50 });
          if (!isObject(metadata) || (metadata.policy !== undefined && !isObject(metadata.policy))) { valid = false; break; }
          const allow = metadata.policy?.allow_implicit_invocation;
          if (allow !== undefined && allow !== true) implicit = false;
          if (metadata.policy?.skill_router_always_injected_in_initial_turn === true) pinned = true;
        } catch (error) {
          if (error.code !== 'ENOENT') { valid = false; break; }
        }
      }
      if (!valid || (!implicit && !pinned)) continue;
      seen.add(path);
      const prefix = typeof skill.pluginId === 'string' ? `${skill.pluginId.split('@')[0]}:` : '';
      const name = prefix && !skill.name.startsWith(prefix) ? prefix + skill.name : skill.name;
      skills.push({ name, description: skill.description, path, implicit, pinned });
    } catch { /* Stale or unreadable skill: leave it out of automatic selection. */ }
  }
  return skills;
}

const singleLine = text => text.replace(/[\r\n]+/gu, ' ');
export const pinnedFirst = skills => [...skills.filter(skill => skill.pinned), ...skills.filter(skill => !skill.pinned)];
export const catalogLine = skill => `- ${singleLine(skill.name)}: ${singleLine(skill.description)} (file: ${singleLine(skill.path)})`;

// Codex resolves the window from its model catalog, which config/read does not report; read the same file.
export async function contextWindow(config, model, env = process.env) {
  const override = Number.isFinite(config.model_context_window) && config.model_context_window > 0 ? config.model_context_window : undefined;
  let entry;
  try {
    const custom = typeof config.model_catalog_json === 'string' && config.model_catalog_json;
    const file = custom ? (custom.startsWith('file:') ? fileURLToPath(custom) : custom)
      : join(env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
    entry = JSON.parse(await readFile(file, 'utf8')).models.find(item => item?.slug === model);
  } catch {}
  const positive = value => Number.isFinite(value) && value > 0 ? value : undefined;
  const max = positive(entry?.max_context_window);
  return override === undefined ? positive(entry?.context_window) ?? max : Math.min(override, max ?? override);
}

export function catalogBudget(config, window = config.model_context_window) {
  const max = config.skills?.max_context_tokens;
  if (Number.isSafeInteger(max) && max >= 0) return { tokens: Math.min(10000, max) };
  if (Number.isFinite(window) && window > 0) return { tokens: Math.max(1, Math.floor(window * 0.02)) };
  return { characters: 8000 };
}

export function render(skills, budget, failure) {
  const lines = [], selected = [];
  let remaining = budget.tokens ?? budget.characters;
  for (const skill of skills) {
    const line = catalogLine(skill);
    const cost = budget.tokens === undefined ? [...line].length + 1 : Math.ceil((Buffer.byteLength(line) + 1) / 4);
    if (cost > remaining && !skill.pinned) break;
    remaining -= cost;
    lines.push(line);
    selected.push(skill);
  }
  const omittedCount = skills.length - selected.length;
  if (omittedCount) lines.push(`- ${omittedCount} additional skills omitted from this bounded skills list.`);
  const order = (failure ? `not ranked (${failure})` : 'ordered from most to least relevant to the initial request') +
    (selected.some(skill => skill.pinned) ? ', after the always-listed skills at the top' : '');
  const block = ['## Skills', `A skill is a set of local instructions stored in a SKILL.md file. These are the skills available for this task, ${order}. This list is sent once; it stays valid for the whole session.`,
    '### Available skills', ...lines, '### How to use skills',
    "- If the task matches a skill's description, read its SKILL.md fully before acting and follow it.",
    '- A skill the user names explicitly must be used even if it is absent from this list.',
    '- If the task changes and nothing above fits, call the search_skills tool with a description of the new task.',
    '- This list grants no permission to run tools or change external state.'].join('\n');
  return { block, selected, omittedCount };
}

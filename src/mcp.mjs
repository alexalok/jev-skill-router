import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { errorCode, isObject } from './common.mjs';

const tool = { name: 'search_skills', description: 'Find relevant skills (SKILL.md instruction files) for a task in its project working directory. Call this before starting work if your context contains no "## Skills" list, and whenever the task changes and no listed skill fits.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['task_description', 'cwd'], properties: {
    task_description: { type: 'string', minLength: 1, maxLength: 24000, description: 'Task description (up to 24,000 UTF-8 bytes).' },
    cwd: { type: 'string', description: 'Absolute path to the task working directory.' } } } };
const result = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

function inputType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value === undefined) return 'missing';
  return typeof value;
}

function inputProblems(args) {
  if (!isObject(args)) return ['arguments: expected object, got ' + inputType(args)];
  const problems = [];
  const { required, properties } = tool.inputSchema;
  for (const field of required) {
    if (!Object.hasOwn(args, field)) problems.push('Missing required field "' + field + '"');
  }
  for (const [field, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, field)) {
      problems.push('Unknown field ' + JSON.stringify(field));
    } else if (typeof value !== properties[field].type) {
      problems.push(field + ': expected ' + properties[field].type + ', got ' + inputType(value));
    }
  }
  if (typeof args.cwd === 'string' && (!isAbsolute(args.cwd) || args.cwd.includes('\0')))
    problems.push('cwd must be an absolute path without NUL characters');
  if (typeof args.task_description === 'string') {
    if (!args.task_description.trim()) problems.push('task_description must be non-blank');
    if (Buffer.byteLength(args.task_description) > 24000) problems.push('task_description must be at most 24,000 UTF-8 bytes');
  }
  return problems;
}

export async function serve(search, input = process.stdin, output = process.stdout) {
  const send = obj => output.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  async function dispatch(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (!isObject(msg) || !Object.hasOwn(msg, 'id')) return;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
      return send({ id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
    const { id, method, params } = msg;
    if (method === 'initialize') return send({ id, result: { protocolVersion:
      ['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(params?.protocolVersion) ? params.protocolVersion : '2025-11-25',
      capabilities: { tools: {} }, serverInfo: { name: 'skill-router', version: '0.5.0' } } });
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: [tool] } });
    if (method === 'tools/call') {
      const args = params?.arguments;
      if (params?.name !== tool.name) return send({ id, error: { code: -32602, message: 'Unknown tool' } });
      const problems = inputProblems(args);
      if (problems.length) {
        const text = ['SKILLS_INPUT_INVALID', ...problems,
          'Expected arguments: {"task_description":"Describe the task","cwd":"/absolute/project/path"}'].join('\n');
        return send({ id, result: result(text, true) });
      }
      try { return send({ id, result: result(await search(args)) }); }
      catch (error) { return send({ id, result: result(error.guardMessage ?? errorCode(error), true) }); }
    }
    send({ id, error: { code: -32601, message: 'Method not found' } });
  }
  for await (const line of createInterface({ input })) await dispatch(line);
}

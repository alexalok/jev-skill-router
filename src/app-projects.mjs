import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fail } from './common.mjs';

// Same app-facing pipe protocol as bundled codex-app-tools/server.mjs.
// Keep this adapter read-only; no private app database/config fallback.
export async function appRequest(method, params, { pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH, timeoutMs = 3000 } = {}) {
  if (!pipe || !isAbsolute(pipe)) throw fail('SKILLS_PROJECT_LOOKUP_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let data = Buffer.alloc(0), settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(fail('SKILLS_PROJECT_LOOKUP_TIMEOUT')), timeoutMs);
    socket.on('error', () => finish(fail('SKILLS_PROJECT_LOOKUP_UNAVAILABLE')));
    socket.on('close', () => finish(fail('SKILLS_PROJECT_LOOKUP_UNAVAILABLE')));
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 8 * 1024 * 1024 + 4) return finish(fail('SKILLS_PROJECT_LOOKUP_INVALID'));
      if (data.length < 4) return;
      const size = data.readUInt32LE(0);
      if (!size || size > 8 * 1024 * 1024) return finish(fail('SKILLS_PROJECT_LOOKUP_INVALID'));
      if (data.length < size + 4) return;
      try {
        const response = JSON.parse(data.subarray(4, size + 4));
        if (response.jsonrpc !== '2.0' || response.id !== 1 || response.error || !Object.hasOwn(response, 'result')) throw Error();
        finish(null, response.result);
      } catch { finish(fail('SKILLS_PROJECT_LOOKUP_INVALID')); }
    });
  });
}

export async function listProjects(input, request = appRequest) {
  const threadId = input.session_id;
  if (typeof threadId !== 'string' || !threadId) throw fail('SKILLS_PROJECT_LOOKUP_UNAVAILABLE');
  const catalog = await request('tools/list', { threadStartKind: 'all' });
  const tool = catalog?.tools?.find(tool => tool.name === 'list_projects');
  if (typeof tool?.namespace !== 'string') throw fail('SKILLS_PROJECT_LOOKUP_UNAVAILABLE');
  const result = await request('tools/call', { arguments: {}, callerSource: 'codex',
    callId: `skill-router-${randomUUID()}`, hostId: process.env.CODEX_APP_TOOLS_CALLER_HOST_ID,
    namespace: tool.namespace, threadId, tool: tool.name, turnId: `skill-router-${randomUUID()}` });
  if (result?.success !== true) throw fail('SKILLS_PROJECT_LOOKUP_FAILED');
  try {
    const payload = JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
    if (!Array.isArray(payload.projects)) throw Error();
    return payload.projects;
  } catch { throw fail('SKILLS_PROJECT_LOOKUP_INVALID'); }
}

export async function resolveProject(target, input) {
  const matches = (await listProjects(input)).filter(project => project.projectId === target.projectId);
  if (matches.length !== 1) throw fail('SKILLS_PROJECT_NOT_FOUND');
  const project = matches[0];
  // Remote callers cannot use this machine's path, even if it happens to exist.
  const caller = process.env.CODEX_APP_TOOLS_CALLER_HOST_ID;
  if ((caller && caller !== 'local') || project.hostId !== 'local' || project.projectKind !== 'local')
    throw fail('SKILLS_PROJECT_REMOTE');
  if (target.environment?.type === 'worktree' && project.isGitRepository !== true)
    throw fail('SKILLS_PROJECT_NOT_GIT');
  if (typeof project.path !== 'string' || !isAbsolute(project.path) || project.path.includes('\0'))
    throw fail('SKILLS_PROJECT_PATH_INVALID');
  try {
    const cwd = await realpath(project.path);
    if (!(await stat(cwd)).isDirectory()) throw Error();
    return cwd;
  } catch { throw fail('SKILLS_PROJECT_PATH_INVALID'); }
}

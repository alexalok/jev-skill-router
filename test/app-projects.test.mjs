import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appRequest, listProjects } from '../src/app-projects.mjs';

test('app lookup bounds malformed responses, disconnects and timeout', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'router-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ['oversize', 'invalid', 'wrong-id', 'error', 'close', 'timeout']) {
    const pipe = join(dir, mode);
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.once('data', () => {
        if (mode === 'timeout') return;
        if (mode === 'close') return socket.end();
        const body = Buffer.from(mode === 'invalid' ? 'invalid' : JSON.stringify({ jsonrpc: '2.0',
          id: mode === 'wrong-id' ? 5 : 1, ...(mode === 'error' ? { error: { code: -1 } } : { result: {} }) }));
        const header = Buffer.alloc(4); header.writeUInt32LE(mode === 'oversize' ? 9 * 1024 * 1024 : body.length);
        socket.end(Buffer.concat([header, body]));
      });
    });
    await new Promise(resolve => server.listen(pipe, resolve));
    try { await assert.rejects(appRequest('tools/list', {}, { pipe, timeoutMs: 100 }), /SKILLS_PROJECT_LOOKUP_/); }
    finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  }
  await assert.rejects(appRequest('tools/list', {}, { pipe: '' }), /UNAVAILABLE/);
});

test('app lookup calls only read-only advertised project tool and validates payload', async () => {
  for (const result of [{ success: false }, { success: true, contentItems: [] },
    { success: true, contentItems: [{ type: 'inputText', text: '{}' }] }]) {
    const calls = [];
    await assert.rejects(listProjects({ session_id: 'parent' }, async (method, params) => {
      calls.push(method);
      if (method === 'tools/list') return { tools: [{ name: 'list_projects', namespace: 'codex_app' }] };
      assert.equal(params.tool, 'list_projects'); assert.equal(params.callerSource, 'codex');
      assert.equal(params.threadId, 'parent'); assert.deepEqual(params.arguments, {});
      return result;
    }), /SKILLS_PROJECT_LOOKUP_/);
    assert.deepEqual(calls, ['tools/list', 'tools/call']);
  }
  await assert.rejects(listProjects({}, () => assert.fail('no identity')), /UNAVAILABLE/);
  await assert.rejects(listProjects({ session_id: 'parent' }, async () => ({ tools: [] })), /UNAVAILABLE/);
});

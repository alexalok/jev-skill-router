#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const dir = process.cwd(), data = JSON.parse(readFileSync(join(dir, 'fake.json')));
const send = message => console.log(JSON.stringify(message));
let initialized = false, threads = 0, lists = 0;
assert.deepEqual(process.argv.slice(2), ['app-server','--stdio']);
assert.equal(process.env.JEV_SKILL_ROUTER_DISABLED, '1');
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params: p } = JSON.parse(line);
  appendFileSync(join(dir, 'calls'), method + '\n');
  const ok = result => send({ id, result });
  if (method === 'initialize') { assert(p.capabilities.experimentalApi); ok({}); continue; }
  if (method === 'initialized') {
    initialized = true;
    if (data.mode !== 'noAccount') setTimeout(() => send({ method: 'account/updated', params: {} }), 60);
    continue;
  }
  assert(initialized);
  if (method === 'config/read') {
    if (data.mode === 'badConfig') send({ id, error: {} });
    else ok({ config: { skills: data.skills, mcp_servers: p.cwd === dir ? { project: {} } : { user: {} } } });
  } else if (method === 'skills/list') {
    // Like real Codex, plugin skills (the second half here) appear only after a few reads.
    assert.deepEqual(p.cwds, [dir]); assert.equal(p.forceReload, true);
    const skills = data.mode === 'late' && ++lists < 3 ? data.catalog.slice(0, 6) : data.catalog;
    ok({ data: data.mode === 'catalog' ? [] : [{ cwd: dir, skills }] });
  } else if (method === 'thread/start') {
    assert.equal(p.ephemeral, true); assert.equal(p.modelProvider, undefined);
    assert.equal(p.model, 'custom'); assert.equal(p.sandbox, 'read-only'); assert.deepEqual(readdirSync(p.cwd), []);
    assert.equal(p.approvalPolicy, 'never'); assert.equal(p.approvalsReviewer, 'user');
    for (const k of ['environments','dynamicTools','selectedCapabilityRoots','runtimeWorkspaceRoots']) assert.deepEqual(p[k], []);
    assert.equal(p.config.default_permissions, ':read-only');
    assert.deepEqual(p.config.mcp_servers, { project: {enabled:false}, user:{enabled:false} });
    for (const key of ['apps','shell_tool','unified_exec','plugins','hooks','multi_agent']) assert.equal(p.config['features.'+key],false);
    if (data.mode === 'hang') writeFileSync(join(dir,'hang-state'),JSON.stringify({pid:process.pid,dir:p.cwd}));
    ok({ thread: { id: 't'+ ++threads }, approvalPolicy: data.mode === 'approval' ? 'on-request' : 'never',
      sandbox: { type: data.mode === 'sandbox' ? 'workspaceWrite' : 'readOnly' } });
  } else if (method === 'turn/start') {
    assert.equal(p.effort, 'high'); assert(p.outputSchema.properties.scores);
    const text = p.input[0].text;
    assert(!text.includes(dir)); assert(!text.includes('PRIVATE_BODY'));
    if (data.mode === 'long') assert.equal(JSON.parse(text.split('\n')[0].slice('Task (data): '.length)), 'x'+'😀'.repeat(5999));
    const scores = [...text.matchAll(/^s(\d+) \|/gmu)].map(m => ({ id:m[0].split(' ')[0], relevance: Math.min(1, Number(m[1])/10) }));
    if (data.mode === 'hang') continue;
    if (data.mode === 'delay') await new Promise(r=>setTimeout(r,300));
    if (data.mode === 'request') { send({ id, method:'item/commandExecution/requestApproval', params:{} }); continue; }
    if (data.mode === 'duplicate') scores.push(scores[0]);
    if (data.mode === 'unknown') scores[0].id='x';
    if (data.mode === 'range') scores[0].relevance=2;
    if (data.mode === 'missing') scores.splice(0,2);
    if (data.mode === 'one') scores.shift();
    ok({ turn: { id: 'u' } });
    send({ method:'item/completed',params:{threadId:p.threadId,item:{type:'agentMessage',text:JSON.stringify({scores})}} });
    send({ method:'turn/completed',params:{threadId:p.threadId,turn:{id:'u',status:'completed'}} });
  } else assert.fail(method);
}

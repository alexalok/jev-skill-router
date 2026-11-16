import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catalogBudget, catalogLine, contextWindow, eligibleSkills, pinnedFirst, render } from '../src/catalog.mjs';
import { rank, makeBatches } from '../src/ranker.mjs';
import { sessionPath, acquire, prepareSessions, retireStale } from '../src/session-state.mjs';
import { loadConfig, route, search } from '../src/router.mjs';

const fake = resolve('test/fake-codex.mjs'), bundle = resolve('plugins/jev-skill-router/scripts/router.mjs');
async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(),'skill-router-test-')));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const configFile = join(cwd,'config.json'), dataDir = join(cwd,'history');
  const env = { ...process.env, JEV_SKILL_ROUTER_CONFIG: configFile, JEV_SKILL_ROUTER_DATA_DIR: dataDir,
    JEV_SKILL_ROUTER_DISABLED: '0', JEV_CODEX_BIN: fake };
  const settings = { model:'custom', reasoningEffort:'high', dashboardAutoStart:false, searchMaxResults:2, timeoutMs:4000 };
  await writeFile(configFile,JSON.stringify(settings));
  const config = { ...await loadConfig(env), initialMinRelevance: 0.1 }, catalog = [];
  for (let i=0;i<12;i++) {
    const root = join(cwd,'skill'+i), path=join(root,'SKILL.md');
    await mkdir(root); await writeFile(path,'PRIVATE_BODY');
    catalog.push({name:'skill'+i,description:'Help with task '+i,path,enabled:true});
  }
  const state = (mode,skills={include_instructions:false}) => writeFile(join(cwd,'fake.json'),JSON.stringify({mode,skills,catalog}));
  await state('ok');
  const input = {hook_event_name:'UserPromptSubmit',session_id:'s',cwd,prompt:'New task'};
  const call = (stdin, argv=[], overrides={}) => {
    const result=spawnSync(process.execPath,[bundle,...argv],{env:{...env,...overrides},input:stdin,encoding:'utf8',timeout:8000});
    assert.equal(result.status,0,result.stderr || result.error?.message);
    return result.stdout.trim().split('\n').map(l=>JSON.parse(l));
  };
  const calls = async ()=>(await readFile(join(cwd,'calls'),'utf8')).trim().split('\n');
  return {cwd,configFile,config,env,input,call,calls,state,catalog,dataDir};
}

test('config defaults, migration, bounds and invalid stdin',async t=>{
  const f=await fixture(t);
  await writeFile(f.configFile,JSON.stringify({model:'jev-latest',apiKey:'old',threshold:0,maxSkills:0}));
  const config=await loadConfig(f.env);
  assert.deepEqual([config.model,config.reasoningEffort,config.initialMinRelevance,config.searchMaxResults,config.searchMinRelevance,config.timeoutMs],['gpt-6-luna','medium',0.8,10,0.8,45000]);
  assert.deepEqual(config.obsolete,['apiKey','threshold','maxSkills']); assert(!('apiKey' in config));
  assert.match(f.call('{')[0].reason,/SKILLS_INPUT_INVALID/);
  for (const bad of [{unexpected:true},{timeoutMs:999},{timeoutMs:120001},{searchMaxResults:51},{searchMinRelevance:-0.1},{initialMinRelevance:-0.1},{initialMinRelevance:1.01},{initialMinRelevance:'0.1'},{reasoningEffort:''},{dashboardPort:0},{dataDir:'relative'}]) {
    await writeFile(f.configFile,JSON.stringify(bad)); await assert.rejects(loadConfig({ ...f.env, JEV_SKILL_ROUTER_DATA_DIR:undefined }),/SKILLS_CONFIG_INVALID/);
  }
  await writeFile(f.configFile,"{broken");
  const reason=f.call(JSON.stringify(f.input))[0].reason;
  assert.match(reason,/could not confirm.*SKILLS_CONFIG_INVALID/); assert(reason.includes(f.configFile)); assert(!reason.includes('[skills]'));
  assert.deepEqual(f.call('{',[],{JEV_SKILL_ROUTER_DISABLED:'1'}),[{}]);
});

test('guard checks every prompt and fails closed before config confirmation',async t=>{
  const f=await fixture(t);
  for (const value of [true,undefined]) {
    await f.state('ok',{include_instructions:value});
    const res=await route(f.input,f.config);
    assert.equal(res.decision,'block'); assert.match(res.reason,/\[skills\]\ninclude_instructions = false/);
  }
  await f.state('badConfig'); assert.equal((await route(f.input,f.config)).decision,'block');
  assert.match((await route(f.input,{...f.config,codexBin:join(f.cwd,'noexe')})).reason,/codexBin to an absolute path/);
  assert(!(await f.calls()).includes('turn/start'));
});

test('one ranked injection per session and agent; compaction needs no Codex',async t=>{
  const f=await fixture(t); await f.state('delay');
  const pair=await Promise.all([route(f.input,f.config),route(f.input,f.config)]);
  const block=pair.find(x=>x.hookSpecificOutput)?.hookSpecificOutput.additionalContext;
  assert.equal(pair.filter(x=>!Object.keys(x).length).length,1);
  assert(block.indexOf('- skill10:')<block.indexOf('- skill9:')); assert.equal((block.match(/^- skill/gmu)||[]).length,11);
  assert.deepEqual(await route(f.input,f.config),{}); assert.equal((await f.calls()).filter(x=>x==='turn/start').length,1);
  assert((await route({...f.input,agent_id:'child'},f.config)).hookSpecificOutput);
  const compact=await route({...f.input,hook_event_name:'SessionStart',source:'compact'}, {...f.config,codexBin:'/missing'});
  assert.equal(compact.hookSpecificOutput.additionalContext,block);
  assert.equal((await stat(sessionPath(f.dataDir,'s'))).mode & 0o777,0o600);
  await f.state('ok',{}); assert.equal((await route(f.input,f.config)).decision,'block');
});

test('initial cutoff, pinned override, empty results and fallback agree with history',async t=>{
  const f=await fixture(t), run=async (id,cutoff=f.config.initialMinRelevance)=>{
    const out=await route({...f.input,session_id:id},{...f.config,initialMinRelevance:cutoff});
    const log=await readFile(join(f.dataDir,new Date().toISOString().slice(0,10)+'.jsonl'),'utf8');
    const event=JSON.parse(log.trim().split('\n').at(-1));
    assert.equal(event.sessionId,id); assert.equal(event.candidateCount,f.catalog.length);
    assert.equal(event.omittedCount,event.candidateCount-event.selected.length);
    return [out.hookSpecificOutput.additionalContext,event];
  };
  let [block,event]=await run('boundary',0.9);
  assert.deepEqual(event.selected.map(s=>s.name),['skill10','skill11','skill9']);
  assert.equal(event.threshold,0.9); assert(!block.includes('additional skills omitted'));
  await search({task_description:'task',cwd:f.cwd},{...f.config,searchMinRelevance:0.3});
  const instructions=(await readFile(join(f.cwd,'instructions'),'utf8')).trim().split('\n');
  assert(instructions.length>=2 && instructions.every(line=>!/dropped|0.9|0.3/.test(line)));
  await f.state('zero');
  [block,event]=await run('none');
  assert.equal(event.status,'none'); assert.equal(event.threshold,0.1); assert.deepEqual(event.selected,[]);
  assert.match(block,/No skills were found relevant.*search_skills/);
  assert.doesNotMatch(block,/Available skills|most to least relevant/);
  [,event]=await run('zero-cutoff',0); assert.equal(event.selected.length,12);
  await mkdir(join(f.cwd,'skill0','agents'));
  await writeFile(join(f.cwd,'skill0','agents','openai.yaml'),'policy: {skill_router_always_injected_in_initial_turn: true}');
  await f.state('zero',{include_instructions:false,max_context_tokens:0});
  [block,event]=await run('pinned',1);
  assert.equal(event.status,'selected'); assert.deepEqual(event.selected,[{name:'skill0',path:f.catalog[0].path,probability:1}]);
  assert.match(block,/No other skills were found relevant.*search_skills/); assert.match(block,/### Available skills\n- skill0:/);
  await f.state('ok',{include_instructions:false,max_context_tokens:0});
  [block,event]=await run('budget',0.9);
  assert.equal(event.omittedCount,11); assert.match(block,/2 additional skills omitted/);
  assert.doesNotMatch(block,/No other skills were found/);
  await f.state('request');
  [block,event]=await run('failure',1);
  assert.match(block,/not ranked/); assert.equal(event.status,'unranked'); assert.equal(event.threshold,null);
  assert.equal(event.selected.length,12); assert(event.selected.every(s=>s.probability===null));
  f.catalog.length=0; await f.state('ok');
  [block,event]=await run('empty');
  assert.equal(event.status,'no_candidates'); assert.match(block,/No skills were found relevant/);
});

test('catalog failure retries; stale lock recoverable; helper errors cached unranked',async t=>{
  const f=await fixture(t); await f.state('catalog');
  assert.match((await route(f.input,f.config)).systemMessage,/SKILLS_CATALOG_INVALID/);
  const path=sessionPath(f.dataDir,'s');
  await assert.rejects(stat(path),{code:'ENOENT'});
  await acquire(path,4000); await utimes(path.replace('.json','.lock'),new Date(0),new Date(0));
  await f.state('request'); const message=await route(f.input,f.config);
  assert.match(message.systemMessage,/SKILLS_HELPER_UNEXPECTED_REQUEST/);
  assert.match(message.hookSpecificOutput.additionalContext,/not ranked/);
  assert.deepEqual(await route(f.input,f.config),{});
  for (const [mode,code] of [['sandbox','SKILLS_HELPER_SANDBOX'],['approval','SKILLS_HELPER_SANDBOX'],['hang','SKILLS_TIMEOUT'],['duplicate','SKILLS_RESPONSE_INVALID'],['unknown','SKILLS_RESPONSE_INVALID'],['range','SKILLS_RESPONSE_INVALID'],['missing','SKILLS_RESPONSE_INVALID'],['one',null]]) {
    await f.state(mode); const res=await route({...f.input,session_id:mode},{...f.config,timeoutMs:1000});
    if (mode === 'hang') {
      const {pid,dir}=JSON.parse(await readFile(join(f.cwd,'hang-state'),'utf8'));
      await assert.rejects(stat(dir),{code:'ENOENT'});
      for (let n=0;n<50;n++) {
        try { process.kill(pid,0); } catch (error) { assert.equal(error.code,'ESRCH'); break; }
        await new Promise(r=>setTimeout(r,20));
      }
      assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    }
    if (code) assert.match(res.systemMessage,new RegExp(code)); else assert.equal(res.systemMessage,undefined);
  }
});

test('budget tiers, filtering and UTF-8 batching',async t=>{
  const f=await fixture(t), skills=f.catalog;
  assert.deepEqual(catalogBudget({skills:{max_context_tokens:20000}}),{tokens:10000});
  assert.deepEqual(catalogBudget({model_context_window:5000}),{tokens:100});
  assert.deepEqual(catalogBudget({model_context_window:1000000}),{tokens:20000});
  assert.deepEqual(catalogBudget({}),{characters:8000});
  const home=await mkdtemp(join(tmpdir(),'jsr-models-')), file=join(home,'models_cache.json');
  t.after(()=>rm(home,{recursive:true,force:true}));
  await writeFile(file,JSON.stringify({models:[{slug:'a',context_window:300000,max_context_window:400000},{slug:'b',max_context_window:200000}]}));
  const env={CODEX_HOME:home};
  assert.equal(await contextWindow({},'a',env),300000);
  assert.equal(await contextWindow({},'b',env),200000);
  assert.equal(await contextWindow({},'missing',env),undefined);
  assert.equal(await contextWindow({model_context_window:900000},'a',env),400000);
  assert.equal(await contextWindow({model_context_window:50000},'missing',env),50000);
  assert.equal(await contextWindow({model_catalog_json:file},'a',{CODEX_HOME:'/nonexistent'}),300000);
  assert.deepEqual(catalogBudget({},await contextWindow({},'a',env)),{tokens:6000});
  for (const budget of [{tokens:Math.ceil((Buffer.byteLength(catalogLine(skills[0]))+1)/4)},{characters:catalogLine(skills[0]).length+1}]) {
    const out=render(skills,budget); assert(out.selected.length>0 && out.selected.length<skills.length);
    assert(out.block.includes(out.omittedCount+' additional skills omitted'));
  }
  await mkdir(join(f.cwd,'skill0','agents')); await writeFile(join(f.cwd,'skill0','agents','openai.yaml'),'policy: {allow_implicit_invocation: false}');
  assert.equal((await eligibleSkills({skills:[...skills,skills[1],{...skills[0],enabled:false}]})).length,11);
  // Pinned policy: a manual-only skill comes back, goes first and ignores the budget.
  await writeFile(join(f.cwd,'skill0','agents','openai.yaml'),'policy: {allow_implicit_invocation: false, skill_router_always_injected_in_initial_turn: true}');
  await mkdir(join(f.cwd,'skill5','agents')); await writeFile(join(f.cwd,'skill5','agents','openai.yaml'),'policy: {skill_router_always_injected_in_initial_turn: "yes"}');
  const withPinned=await eligibleSkills({skills});
  assert.deepEqual(withPinned.filter(s=>s.pinned).map(s=>[s.name,s.implicit]),[[skills[0].name,false]]);
  assert.equal(withPinned.length,12);
  const pinnedOut=render(pinnedFirst([...withPinned].reverse()),{tokens:1});
  assert.deepEqual(pinnedOut.selected.map(s=>s.name),[skills[0].name]);
  assert(pinnedOut.block.includes('after the always-listed skills'));
  await writeFile(join(f.cwd,'skill0','agents','openai.yaml'),'policy: {allow_implicit_invocation: false}');
  await rm(join(f.cwd,'skill5','agents'),{recursive:true});
  const big=skills.map(s=>({...s,description:'中'.repeat(4000)})); const batches=makeBatches('task',big);
  assert(batches.length>1); assert(batches.every(b=>Buffer.byteLength(b.text)<=60000));
  assert.throws(()=>makeBatches('中'.repeat(8001),skills),/SKILLS_PROMPT_TOO_LARGE/);
  let active=0,max=0;
  const ranked=await rank('task',big,{async structuredTurn(text) {
    active++;max=Math.max(max,active); await new Promise(r=>setImmediate(r));active--;
    return JSON.stringify({scores:[...text.matchAll(/^(s\d+) \|/gmu)].map(m=>({id:m[1],relevance:0.5}))});
  }},{},{},0);
  assert.equal(ranked.length,12); assert.equal(max,3);
});

test('MCP schema, paths, search threshold/limit, guard errors and history',async t=>{
  const f=await fixture(t), req=(id,method,params)=>JSON.stringify({jsonrpc:'2.0',id,method,params});
  const args={task_description:'Search task',cwd:f.cwd}, call=a=>req(3,'tools/call',{name:'search_skills',arguments:a});
  const [init,list,result,bad]=f.call([req(1,'initialize',{protocolVersion:'2025-03-26'}),req(2,'tools/list'),call(args),call({task_description:'task'})].join('\n'),['--mcp']);
  assert.equal(init.result.protocolVersion,'2025-03-26');
  assert.deepEqual(list.result.tools[0].inputSchema.required,['task_description','cwd']);
  assert.equal(result.result.content[0].text.split('\n').length,2);
  assert.match(result.result.content[0].text,/^1.00 - skill10:/); assert(bad.result.isError);
  await writeFile(f.configFile,JSON.stringify({...f.config,obsolete:undefined,searchMaxResults:50,searchMinRelevance:1}));
  assert.equal(f.call(call(args),['--mcp'])[0].result.content[0].text.split('\n').length,2);
  await f.state('ok',{}); const guard=f.call(call(args),['--mcp'])[0]; assert(guard.result.isError);assert.match(guard.result.content[0].text,/include_instructions = false/);
  const history=await readFile(join(f.dataDir,new Date().toISOString().slice(0,10)+'.jsonl'),'utf8');
  assert(!history.includes('Search task'));assert.equal(JSON.parse(history.trim().split('\n')[0]).source,'search');
  const root=resolve('plugins/jev-skill-router'), mcp=JSON.parse(await readFile(join(root,'.mcp.json'))).mcpServers['skill-router'];
  assert.equal(mcp.cwd,'.');assert.deepEqual(mcp.args,['scripts/router.mjs','--mcp']);assert((await stat(join(root,mcp.cwd,mcp.args[0]))).isFile());
});

test('image-only input checks guard without consuming initial text injection; large UTF-8 prompt ranks',async t=>{
  const f=await fixture(t);
  await f.state('ok',{include_instructions:true});
  assert.match((await route({...f.input,prompt:''},f.config)).reason,/SKILLS_NATIVE_INSTRUCTIONS/);
  await f.state('long');
  for (const prompt of ['', '  ']) assert.deepEqual(await route({...f.input,prompt},f.config),{});
  await assert.rejects(stat(sessionPath(f.dataDir,'s')),{code:'ENOENT'}); assert(!(await f.calls()).includes('turn/start'));
  const prompt='x'+'😀'.repeat(300000);
  const [out]=f.call(JSON.stringify({...f.input,prompt}));
  assert.equal(out.systemMessage,undefined); assert.match(out.hookSpecificOutput.additionalContext,/most to least relevant/);
});

test('corrupt cache recovers on prompt and compaction; stale takeover and debris recover',async t=>{
  const f=await fixture(t),path=sessionPath(f.dataDir,'s');
  await prepareSessions(f.dataDir);
  await writeFile(path,'{"block":false}');
  assert.deepEqual(await route({...f.input,hook_event_name:'SessionStart',source:'compact'},f.config),{});
  await assert.rejects(stat(path),{code:'ENOENT'});
  await writeFile(path,'{broken');
  const lock=path.replace('.json','.lock'),claim=lock+'.takeover';
  const stale=new Date(Date.now()-60000);
  for (const file of [lock,claim]) { await writeFile(file,'stale');await utimes(file,stale,stale); }
  assert((await route(f.input,f.config)).hookSpecificOutput);
  for (const file of [lock,claim,lock+'.other']) { await writeFile(file,'old');await utimes(file,new Date(0),new Date(0)); }
  await prepareSessions(f.dataDir);
  for (const file of [lock,claim]) await assert.rejects(stat(file),{code:'ENOENT'});
  assert((await stat(lock+'.other')).isFile());
});

test('MCP notification silence, ping, method/tool errors and guard diagnostics',async t=>{
  const f=await fixture(t),args={task_description:'task',cwd:f.cwd};
  const query=(id,method,params)=>JSON.stringify({jsonrpc:'2.0',id,method,params});
  await f.state('badConfig');
  const requests=[query(undefined,'notifications/initialized'), '{}',query(1,'ping'),query(2,'missing'),
    query(3,'tools/call',{name:'unknown',arguments:args}),query(4,'tools/call',{name:'search_skills',arguments:args}),
    query(5,'tools/call',{name:'search_skills',arguments:{...args,task_description:'X'.repeat(24001)}})];
  const replies=f.call(requests.join('\n'),['--mcp']);
  assert.deepEqual(replies.map(x=>x.id),[1,2,3,4,5]);assert.deepEqual(replies[0].result,{});
  assert.equal(replies[1].error.code,-32601);assert.equal(replies[2].error.code,-32602);
  const reason=replies[3].result.content[0].text;assert.match(reason,/could not confirm.*SKILLS_CODEX_FAILED/);assert(!reason.includes('[skills]'));
  assert(replies[4].result.isError);
  await writeFile(f.configFile,'{');
  const configError=f.call(requests[5],['--mcp'])[0].result.content[0].text;
  assert.match(configError,/could not confirm.*SKILLS_CONFIG_INVALID/);assert(configError.includes(f.configFile));
});

test('stale cleanup restores a fresh replacement instead of deleting it',async t=>{
  const f=await fixture(t);
  for (const name of ['key.lock','key.lock.takeover']) {
    const path=join(f.cwd,name),fresh=path+'.new';
    await writeFile(path,'expired');await utimes(path,new Date(0),new Date(0));
    await writeFile(fresh,'fresh owner');
    const retired=await retireStale(path,Date.now()-5000,async(from,tomb)=>{
      await rename(fresh,path); // Another contender wins between stat and rename.
      await rename(from,tomb);
    });
    assert.equal(retired,false);assert.equal(await readFile(path,'utf8'),'fresh owner');
  }
});

test('stale cleanup never overwrites a new entry when restoring',async t=>{
  const f=await fixture(t),path=join(f.cwd,'key.lock');
  await writeFile(path,'expired');await utimes(path,new Date(0),new Date(0));
  let moved;
  const retired=await retireStale(path,Date.now()-5000,async(from,tomb)=>{
    await writeFile(from,'fresh owner');await rename(from,tomb);moved=tomb;
    await writeFile(from,'new owner',{flag:'wx'});
  });
  assert.equal(retired,false);assert.equal(await readFile(path,'utf8'),'new owner');
  await assert.rejects(stat(moved),{code:'ENOENT'});
});

test('missing lock cannot be acquired until takeover claim expires',async t=>{
  const f=await fixture(t),path=join(f.cwd,'key.json'),lock=join(f.cwd,'key.lock'),claim=lock+'.takeover';
  await writeFile(claim,'active');
  assert.equal(await acquire(path,4000),null);
  await assert.rejects(stat(lock),{code:'ENOENT'});
  assert.equal(await readFile(claim,'utf8'),'active');
  await utimes(claim,new Date(0),new Date(0));
  const release=await acquire(path,4000);
  assert.equal(typeof release,'function');await release();
});

test('catalog read waits for plugin skills that appear after login loads',async t=>{
  const f=await fixture(t); await f.state('late');
  const block=(await route(f.input,f.config)).hookSpecificOutput.additionalContext;
  assert.equal((block.match(/^- skill/gmu)||[]).length,11); assert.match(block,/### Available skills\n- skill/);
});

const history = async f => (await readFile(join(f.dataDir, new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
async function threadFixture(t) {
  const f = await fixture(t);
  // The fake server reads fixture state while the router uses a neutral cwd.
  const wrapper = join(f.cwd, 'codex-wrapper.mjs');
  await writeFile(wrapper, `#!/usr/bin/env node\nprocess.env.JEV_FAKE_ROOT = ${JSON.stringify(f.cwd)};\nawait import(${JSON.stringify(new URL('./fake-codex.mjs', import.meta.url).href)});\n`);
  await chmod(wrapper, 0o700);
  f.config.codexBin = wrapper;
  f.env.JEV_CODEX_BIN = wrapper;
  f.catalog.forEach((skill, i) => { skill.scope = ['user', 'system', 'admin'][i % 3]; });
  f.thread = { hook_event_name: 'PreToolUse', tool_name: 'mcp__codex_app__create_thread',
    session_id: 'parent', cwd: f.cwd, tool_input: { prompt: 'Diagnose failing React component tests',
      target: { type: 'projectless', directoryName: 'react-tests' }, model: 'destination-model',
      thinking: 'medium', title: 'React tests', futureOption: { preserve: true } } };
  f.threadState = (mode = 'ok', skills = { include_instructions: false }) =>
    writeFile(join(f.cwd, 'fake.json'), JSON.stringify({ mode, skills, catalog: f.catalog,
      expectedTask: f.thread.tool_input.prompt }));
  await f.threadState();
  return f;
}

test('create_thread ranks child task, filters scopes, preserves args and never touches parent cache', async t => {
  const f = await threadFixture(t);
  f.catalog[0].scope = 'repo'; delete f.catalog[1].scope; f.catalog[2].scope = 'unknown';
  await f.threadState();
  await prepareSessions(f.dataDir);
  const parent = sessionPath(f.dataDir, 'parent');
  await writeFile(parent, JSON.stringify({ block: 'parent catalog' }));
  const before = await readFile(parent, 'utf8');
  const original = structuredClone(f.thread);
  const result = await route(f.thread, f.config), out = result.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse'); assert.equal(out.permissionDecision, 'allow');
  assert.deepEqual({ ...out.updatedInput, prompt: original.tool_input.prompt }, original.tool_input);
  assert.deepEqual(f.thread, original);
  assert(out.updatedInput.prompt.startsWith(original.tool_input.prompt + '\n\n'));
  assert.match(out.updatedInput.prompt, /most to least relevant/);
  for (let i = 0; i < 3; i++) assert(!out.updatedInput.prompt.includes('- skill' + i + ':'));
  assert.equal(await readFile(parent, 'utf8'), before);
  const history = (await readFile(join(f.dataDir, new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')).trim();
  const event = JSON.parse(history);
  assert.equal(event.source, 'create_thread'); assert.equal(event.candidateCount, 9);
  assert.equal(event.sessionId, 'parent'); assert.notEqual(event.cwd, f.cwd);
  await assert.rejects(stat(event.cwd), { code: 'ENOENT' });
  assert(!history.includes(original.tool_input.prompt));
  const callsBefore = await f.calls();
  assert.deepEqual(await route({ ...f.thread, tool_input: out.updatedInput }, f.config), {});
  assert.deepEqual(await f.calls(), callsBefore);
});

test('create_thread skips other tools, unknown destinations and invalid prompts before discovery', async t => {
  const f = await threadFixture(t);
  for (const target of [{ type: 'codexCloud' }, { type: 'chatgptWorkCloud' }, { type: 'future' }, null]) {
    assert.deepEqual(await route({ ...f.thread, tool_input: { ...f.thread.tool_input, target } }, f.config), {});
  }
  for (const prompt of ['', '  ', null, 12])
    assert.deepEqual(await route({ ...f.thread, tool_input: { ...f.thread.tool_input, prompt } }, f.config), {});
  for (const tool_name of ['create_thread', 'mcp__codex_app__send_message_to_thread', 'other'])
    assert.deepEqual(await route({ ...f.thread, tool_name }, f.config), {});
  assert.deepEqual(await route({ ...f.thread, tool_input: [] }, f.config), {});
  await assert.rejects(stat(join(f.cwd, 'calls')), { code: 'ENOENT' });
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' });
});

test('create_thread failures pass through; helper fallback and recording failures retain prompt update', async t => {
  const f = await threadFixture(t);
  for (const [mode, skills, code] of [['badConfig', {}, 'SKILLS_CODEX_FAILED'],
    ['ok', { include_instructions: true }, 'SKILLS_NATIVE_INSTRUCTIONS'],
    ['catalog', { include_instructions: false }, 'SKILLS_CATALOG_INVALID']]) {
    await f.threadState(mode, skills);
    const result = await route(f.thread, f.config);
    assert.equal(result.decision, undefined); assert.equal(result.hookSpecificOutput, undefined);
    assert.match(result.systemMessage, new RegExp(code));
  }
  await f.threadState('request');
  const fallback = await route(f.thread, f.config);
  assert.match(fallback.hookSpecificOutput.updatedInput.prompt, /not ranked/);
  const history = (await readFile(join(f.dataDir, new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(history.map(e => e.status), ['error', 'error', 'error', 'unranked']);
  await f.threadState();
  const badHistory = await route(f.thread, { ...f.config, dataDir: f.configFile });
  assert(badHistory.hookSpecificOutput.updatedInput.prompt);
  assert.match(badHistory.systemMessage, /SKILLS_RECORD_UNAVAILABLE/);
  await assert.rejects(stat(sessionPath(f.dataDir, 'parent')), { code: 'ENOENT' });
});


test('project targets resolve app IDs, rank source checkout and disclose worktree approximation', async t => {
  const net = await import('node:net');
  const f = await threadFixture(t);
  const pipe = join(f.cwd, 'app.sock');
  let projects = [{ projectId: 'selected', projectKind: 'local', hostId: 'local', path: f.cwd, isGitRepository: true }];
  const server = net.createServer(socket => {
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4 || data.length < data.readUInt32LE(0) + 4) return;
      const req = JSON.parse(data.subarray(4));
      assert(['tools/list', 'tools/call'].includes(req.method));
      if (req.method === 'tools/call') {
        assert.equal(req.params.tool, 'list_projects'); assert.deepEqual(req.params.arguments, {});
        assert.equal(req.params.threadId, 'parent');
      }
      const result = req.method === 'tools/list' ? { tools: [{ name: 'list_projects', namespace: 'codex_app' }] } :
        { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ projects }) }] };
      const body = Buffer.from(JSON.stringify({ id: req.id, jsonrpc: '2.0', result }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(header.subarray(0, 2)); socket.end(Buffer.concat([header.subarray(2), body]));
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  const before = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  process.env.CODEX_APP_TOOLS_PIPE_PATH = pipe;
  t.after(() => { if (before === undefined) delete process.env.CODEX_APP_TOOLS_PIPE_PATH; else process.env.CODEX_APP_TOOLS_PIPE_PATH = before; server.close(); });
  f.catalog.forEach(skill => { skill.scope = 'repo'; }); await f.threadState();
  const target = { type: 'project', projectId: 'selected', environment: { type: 'local' } };
  f.thread.tool_input.target = target;
  const local = (await route(f.thread, f.config)).hookSpecificOutput.updatedInput;
  assert.match(local.prompt, /skill11/); assert.doesNotMatch(local.prompt, /may have drifted/);
  assert.equal((await history(f))[0].cwd, f.cwd);
  target.environment = { type: 'worktree', startingState: { type: 'branch', branchName: 'uncreated-ref' } };
  const worktree = (await route({ ...f.thread, tool_input: { ...local, target } }, f.config)).hookSpecificOutput.updatedInput;
  assert.match(worktree.prompt, /Skills were taken from the main worktree and, in rare cases, may have drifted from this worktree\./);
  assert.equal((worktree.prompt.match(/## Skills/g) || []).length, 1);
  assert.deepEqual(worktree.target, target); assert((await stat(f.cwd)).isDirectory());
  const child = { ...f.input, session_id: 'child-thread', prompt: worktree.prompt };
  assert.deepEqual(await route(child, f.config), {});
  assert.deepEqual(await route(child, f.config), {});
  assert.match((await route({ ...child, hook_event_name: 'SessionStart', source: 'compact' }, f.config)).hookSpecificOutput.additionalContext, /may have drifted/);
  await assert.rejects(stat(sessionPath(f.dataDir, 'parent')), { code: 'ENOENT' });
  for (const [patch, code] of [[{ hostId: 'ssh-host' }, 'SKILLS_PROJECT_REMOTE'],
    [{ path: 'relative' }, 'SKILLS_PROJECT_PATH_INVALID'], [{ path: f.configFile }, 'SKILLS_PROJECT_PATH_INVALID'],
    [{ isGitRepository: false }, 'SKILLS_PROJECT_NOT_GIT'], [{ projectId: 'missing' }, 'SKILLS_PROJECT_NOT_FOUND']]) {
    projects = [{ projectId: 'selected', projectKind: 'local', hostId: 'local', path: f.cwd, isGitRepository: true, ...patch }];
    const result = await route(f.thread, f.config);
    assert.equal(result.hookSpecificOutput, undefined); assert.match(result.systemMessage, new RegExp(code));
  }
});

test('create-thread bundle registration and child cache isolation', async t => {
  const f = await threadFixture(t);
  const hooks = JSON.parse(await readFile('plugins/jev-skill-router/hooks/hooks.json', 'utf8')).hooks;
  assert(hooks.PreToolUse.some(h => h.matcher === '^mcp__codex_app__create_thread$'));
  assert.equal(hooks.PreToolUse[0].hooks[0].command, 'exec "${CODEX_MCP_NODE_PATH:-node}" "${PLUGIN_ROOT}/scripts/router.mjs"');
  const output = f.call(JSON.stringify(f.thread))[0];
  assert.match(output.hookSpecificOutput.updatedInput.prompt, /## Skills/);
  assert.deepEqual(f.call(JSON.stringify(f.thread), [], { JEV_SKILL_ROUTER_DISABLED: '1' }), [{}]);
  await route({ ...f.input, session_id: 'parent' }, f.config);
  const path = sessionPath(f.dataDir, 'parent'), before = await readFile(path, 'utf8');
  await route({ ...f.input, session_id: 'parent', prompt: output.hookSpecificOutput.updatedInput.prompt }, f.config);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('trailing whitespace does not duplicate a create-thread catalog or break child adoption', async t => {
  const f = await threadFixture(t);
  const args = (await route(f.thread, f.config)).hookSpecificOutput.updatedInput;
  for (const [index, suffix] of ['\n', '\r\n', ' \t\n\n'].entries()) {
    const calls = await f.calls();
    const prompt = args.prompt + suffix;
    assert.deepEqual(await route({ ...f.thread, tool_input: { ...args, prompt } }, f.config), {});
    assert.deepEqual(await f.calls(), calls);
    const child = { ...f.input, session_id: `child-whitespace-${index}`, prompt };
    assert.deepEqual(await route(child, f.config), {});
    const compact = await route({ ...child, hook_event_name: 'SessionStart', source: 'compact' }, f.config);
    assert.match(compact.hookSpecificOutput.additionalContext, /^## Skills\n/);
    assert.equal((compact.hookSpecificOutput.additionalContext.match(/## Skills/g) || []).length, 1);
  }
  assert.equal((await f.calls()).filter(call => call === 'turn/start').length, 1);
  await assert.rejects(stat(sessionPath(f.dataDir, 'parent')), { code: 'ENOENT' });
});

test('failed rerouting strips invalidated catalogs before child cache adoption', async t => {
  const f = await threadFixture(t);
  const enriched = (await route(f.thread, f.config)).hookSpecificOutput.updatedInput;
  const task = 'Fix an unrelated database task';
  const args = { ...enriched, prompt: enriched.prompt.replace(f.thread.tool_input.prompt, task) };
  const input = { ...f.thread, tool_input: args };
  for (const [mode, skills] of [['badConfig', {}], ['ok', { include_instructions: true }],
    ['catalog', { include_instructions: false }]]) {
    await f.threadState(mode, skills);
    const result = await route(input, f.config);
    assert.deepEqual(result.hookSpecificOutput.updatedInput, { ...args, prompt: task });
    assert.match(result.systemMessage, /stale catalog removed/);
  }
  const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  process.env.CODEX_APP_TOOLS_PIPE_PATH = '';
  try {
    const target = { type: 'project', projectId: 'other', environment: { type: 'local' } };
    const result = await route({ ...f.thread, tool_input: { ...enriched, target } }, f.config);
    assert.deepEqual(result.hookSpecificOutput.updatedInput, { ...enriched, target, prompt: f.thread.tool_input.prompt });
    assert.match(result.systemMessage, /SKILLS_PROJECT_LOOKUP_UNAVAILABLE/);
  } finally { if (pipe === undefined) delete process.env.CODEX_APP_TOOLS_PIPE_PATH; else process.env.CODEX_APP_TOOLS_PIPE_PATH = pipe; }
  const cloud = { ...enriched, target: { type: 'codexCloud', environmentConfigId: 'cloud' } };
  assert.deepEqual((await route({ ...f.thread, tool_input: cloud }, f.config)).hookSpecificOutput.updatedInput,
    { ...cloud, prompt: f.thread.tool_input.prompt });
  await writeFile(f.configFile, '{broken');
  assert.deepEqual(f.call(JSON.stringify(input))[0].hookSpecificOutput.updatedInput, { ...args, prompt: task });
  assert.equal(f.call(JSON.stringify({ ...f.thread, tool_input: enriched }))[0].hookSpecificOutput, undefined);
  await writeFile(join(f.cwd, 'fake.json'), JSON.stringify({ skills: { include_instructions: false }, catalog: f.catalog, expectedTask: task }));
  const child = await route({ ...f.input, session_id: 'rerouted-child', prompt: task }, f.config);
  assert.match(child.hookSpecificOutput.additionalContext, /^## Skills\n/);
  assert(!child.systemMessage);
  await assert.rejects(stat(sessionPath(f.dataDir, 'parent')), { code: 'ENOENT' });
});

const spawnInput = (f, args = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'collaborationspawn_agent',
  session_id: 's', cwd: f.cwd, tool_input: { message: 'Fix child task', task_name: 'child', fork_turns: 'none', ...args } });


test('spawn ranks child task for fresh/full context, preserves args and isolates parent cache', async t => {
  const f = await fixture(t);
  await route(f.input, f.config);
  const parentPath = sessionPath(f.dataDir, 's'), before = await readFile(parentPath, 'utf8');
  for (const fork_turns of ['none', 'all']) {
    const input = spawnInput(f, { fork_turns, model: 'child-model', futureOption: { preserve: true } });
    await writeFile(join(f.cwd, 'fake.json'), JSON.stringify({ skills: { include_instructions: false }, catalog: f.catalog, expectedTask: input.tool_input.message }));
    const original = structuredClone(input);
    const out = (await route(input, { ...f.config, initialMinRelevance: 0.9 })).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse'); assert.equal(out.permissionDecision, 'allow');
    assert.deepEqual(input, original);
    assert.deepEqual({ ...out.updatedInput, message: original.tool_input.message }, original.tool_input);
    assert(out.updatedInput.message.startsWith(original.tool_input.message + '\n\n'));
    assert.match(out.updatedInput.message, /instead of any Skill Router catalog inherited from parent history/);
    assert.match(out.updatedInput.message, /most to least relevant/);
    assert.doesNotMatch(out.updatedInput.message, /- skill8:/);
    assert.equal((out.updatedInput.message.match(/## Skills\n/g) || []).length, 1);
    const calls = await f.calls();
    assert.deepEqual(await route({ ...input, tool_input: out.updatedInput }, f.config), {});
    assert.deepEqual(await route({ ...input, tool_input: { ...out.updatedInput, message: out.updatedInput.message + ' \n\n' } }, f.config), {});
    assert.deepEqual(await f.calls(), calls);
  }
  assert.equal(await readFile(parentPath, 'utf8'), before);
  const events = (await history(f)).filter(e => e.source === 'subagent');
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.threshold, 0.9); assert.equal(event.omittedCount, 9);
    assert.deepEqual(event.selected.map(s => s.name), ['skill10', 'skill11', 'skill9']);
    assert(!JSON.stringify(event).includes('Fix child task'));
  }
});

test('spawn cwd override discovers child skills; changed task replaces existing attachment', async t => {
  const parent = await fixture(t), child = await fixture(t);
  child.catalog.forEach(s => { s.name = 'child-' + s.name; });
  await child.state('ok', { include_instructions: false, max_context_tokens: 0 });
  await mkdir(join(child.cwd, 'skill0', 'agents'));
  await writeFile(join(child.cwd, 'skill0', 'agents', 'openai.yaml'), 'policy: {skill_router_always_injected_in_initial_turn: true}');
  const input = spawnInput(parent, { cwd: child.cwd }); input.tool_name = 'spawn_agent'; input.agent_id = 'nested-parent';
  const first = (await route(input, parent.config)).hookSpecificOutput.updatedInput;
  assert.match(first.message, /- child-skill0:/); assert.doesNotMatch(first.message, /^- skill\d+:/mu);
  assert.equal((first.message.match(/^- child-skill/gmu) || []).length, 1);
  await assert.rejects(stat(join(parent.cwd, 'calls')), { code: 'ENOENT' });
  const event = (await history(parent))[0]; assert.equal(event.cwd, child.cwd); assert.deepEqual(event.budget, { tokens: 0 });
  const changed = first.message.replace('Fix child task', 'Different child task');
  await writeFile(join(child.cwd, 'fake.json'), JSON.stringify({ skills: { include_instructions: false }, catalog: child.catalog, expectedTask: 'Different child task' }));
  const second = (await route({ ...input, tool_input: { ...first, message: changed } }, parent.config)).hookSpecificOutput.updatedInput;
  assert.equal((second.message.match(/## Skills\n/g) || []).length, 1);
  assert.equal((await child.calls()).filter(x => x === 'turn/start').length, 2);
  await assert.rejects(stat(sessionPath(parent.dataDir, 's', 'nested-parent')), { code: 'ENOENT' });
  // Relative overrides are resolved against the hook cwd, never process.cwd().
  await child.state('ok');
  const relative = spawnInput(parent, { cwd: '../' + child.cwd.split('/').at(-1) });
  assert((await route(relative, parent.config)).hookSpecificOutput.updatedInput.message.includes('child-skill'));
});

test('spawn skips unsupported tools and invalid payloads; SubagentStart no longer injects', async t => {
  const f = await fixture(t), input = spawnInput(f);
  for (const tool_name of ['Agent', 'other_spawn_agent', 'mcp__codex_app__create_thread', 'send_message_to_thread'])
    assert.deepEqual(await route({ ...input, tool_name }, f.config), {});
  for (const tool_input of [null, [], {}, { message: '' }, { message: '  ' }, { message: 1 }, { prompt: 'task' }])
    assert.deepEqual(await route({ ...input, tool_input }, f.config), {});
  assert.deepEqual(await route({ ...input, hook_event_name: 'SubagentStart' }, f.config), {});
  for (const cwd of ['', null, 4, 'bad\0path']) {
    const out = await route(spawnInput(f, { cwd }), f.config);
    assert.equal(out.hookSpecificOutput, undefined); assert.match(out.systemMessage, /SKILLS_INPUT_INVALID/);
  }
  await assert.rejects(stat(join(f.cwd, 'calls')), { code: 'ENOENT' });
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' });
});

test('spawn guard/discovery errors pass through; helper fallback and history failures preserve update', async t => {
  const f = await fixture(t), input = spawnInput(f);
  for (const [mode, skills, code] of [['badConfig', {}, 'SKILLS_CODEX_FAILED'],
    ['ok', { include_instructions: true }, 'SKILLS_NATIVE_INSTRUCTIONS'],
    ['catalog', { include_instructions: false }, 'SKILLS_CATALOG_INVALID']]) {
    await f.state(mode, skills);
    const result = await route(input, f.config);
    assert.equal(result.decision, undefined); assert.equal(result.hookSpecificOutput, undefined);
    assert.match(result.systemMessage, new RegExp(code));
  }
  await f.state('request');
  const fallback = await route(input, f.config);
  assert.match(fallback.hookSpecificOutput.updatedInput.message, /not ranked/);
  assert.deepEqual((await history(f)).map(e => e.status), ['error', 'error', 'error', 'unranked']);
  await f.state('ok');
  const badHistory = await route(input, { ...f.config, dataDir: f.configFile });
  assert(badHistory.hookSpecificOutput.updatedInput.message);
  assert.match(badHistory.systemMessage, /SKILLS_RECORD_UNAVAILABLE/);
  await assert.rejects(stat(sessionPath(f.dataDir, 's')), { code: 'ENOENT' });
});

test('child opening prompt adopts catalog without duplicate ranking or parent cache poisoning', async t => {
  const f = await fixture(t);
  await route(f.input, f.config);
  const path = sessionPath(f.dataDir, 's'), before = await readFile(path, 'utf8');
  const prompt = (await route(spawnInput(f), f.config)).hookSpecificOutput.updatedInput.message;
  for (const identity of [{ session_id: 's', agent_id: 'child' }, { session_id: 'fresh-child' }]) {
    const child = { ...f.input, ...identity, prompt };
    assert.deepEqual(await route(child, f.config), {});
    assert.deepEqual(await route(child, f.config), {});
    assert.deepEqual(await route({ ...child, prompt: 'Follow up' }, f.config), {});
    const compact = await route({ ...child, hook_event_name: 'SessionStart', source: 'compact' }, { ...f.config, codexBin: '/missing' });
    assert.match(compact.hookSpecificOutput.additionalContext, /selected for your own task/);
  }
  assert.deepEqual(await route({ ...f.input, prompt }, f.config), {});
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await f.calls()).filter(x => x === 'turn/start').length, 2);
});

test('bundled spawn hook registration, rewrite, disabled mode and config failures', async t => {
  const f = await fixture(t), input = spawnInput(f);
  const hooks = JSON.parse(await readFile('plugins/jev-skill-router/hooks/hooks.json', 'utf8')).hooks;
  assert.equal(hooks.SubagentStart, undefined);
  const matcher = new RegExp(hooks.PreToolUse.find(h => h.matcher.includes("spawn_agent")).matcher);
  for (const name of ['collaborationspawn_agent', 'spawn_agent', 'Agent']) assert(matcher.test(name));
  assert(!matcher.test('other_spawn_agent')); assert.equal(hooks.PreToolUse[0].hooks[0].timeout, 130);
  assert.match(f.call(JSON.stringify(input))[0].hookSpecificOutput.updatedInput.message, /## Skills/);
  assert.deepEqual(f.call(JSON.stringify(input), [], { JEV_SKILL_ROUTER_DISABLED: '1' }), [{}]);
  await writeFile(f.configFile, '{broken');
  const bad = f.call(JSON.stringify(input))[0];
  assert.equal(bad.decision, undefined); assert.equal(bad.hookSpecificOutput, undefined);
  assert.match(bad.systemMessage, /SKILLS_CONFIG_INVALID/);
});

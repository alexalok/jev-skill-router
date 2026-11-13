import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catalogBudget, catalogLine, contextWindow, eligibleSkills, pinnedFirst, render } from '../src/catalog.mjs';
import { rank, makeBatches } from '../src/ranker.mjs';
import { sessionPath, acquire, prepareSessions, retireStale } from '../src/session-state.mjs';
import { loadConfig, route } from '../src/router.mjs';

const fake = resolve('test/fake-codex.mjs'), bundle = resolve('plugins/jev-skill-router/scripts/router.mjs');
async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(),'skill-router-test-')));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const configFile = join(cwd,'config.json'), dataDir = join(cwd,'history');
  const env = { ...process.env, JEV_SKILL_ROUTER_CONFIG: configFile, JEV_SKILL_ROUTER_DATA_DIR: dataDir,
    JEV_SKILL_ROUTER_DISABLED: '0', JEV_CODEX_BIN: fake };
  const settings = { model:'custom', reasoningEffort:'high', dashboardAutoStart:false, searchMaxResults:2, timeoutMs:4000 };
  await writeFile(configFile,JSON.stringify(settings));
  const config = await loadConfig(env), catalog = [];
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
  assert.deepEqual([config.model,config.reasoningEffort,config.searchMaxResults,config.searchMinRelevance,config.timeoutMs],['gpt-6-luna','medium',10,0.8,45000]);
  assert.deepEqual(config.obsolete,['apiKey','threshold','maxSkills']); assert(!('apiKey' in config));
  assert.match(f.call('{')[0].reason,/SKILLS_INPUT_INVALID/);
  for (const bad of [{unexpected:true},{timeoutMs:999},{timeoutMs:120001},{searchMaxResults:51},{searchMinRelevance:-0.1},{reasoningEffort:''},{dashboardPort:0},{dataDir:'relative'}]) {
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
  assert(block.indexOf('- skill10:')<block.indexOf('- skill9:')); assert.equal((block.match(/^- skill/gmu)||[]).length,12);
  assert.deepEqual(await route(f.input,f.config),{}); assert.equal((await f.calls()).filter(x=>x==='turn/start').length,1);
  assert((await route({...f.input,agent_id:'child'},f.config)).hookSpecificOutput);
  const compact=await route({...f.input,hook_event_name:'SessionStart',source:'compact'}, {...f.config,codexBin:'/missing'});
  assert.equal(compact.hookSpecificOutput.additionalContext,block);
  assert.equal((await stat(sessionPath(f.dataDir,'s'))).mode & 0o777,0o600);
  await f.state('ok',{}); assert.equal((await route(f.input,f.config)).decision,'block');
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
  }},{},{});
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

test('subagents inherit the parent list; without one they get the unranked catalog',async t=>{
  const f=await fixture(t), sub={hook_event_name:'SubagentStart',session_id:'s',agent_id:'kid',agent_type:'default',cwd:f.cwd};
  const fallback=(await route(sub,f.config)).hookSpecificOutput;
  assert.equal(fallback.hookEventName,'SubagentStart'); assert.match(fallback.additionalContext,/not ranked \(no ranked list from the parent session\)/);
  assert(!(await f.calls()).includes('turn/start'));
  await f.state('ok',{}); assert.deepEqual(await route({...sub,agent_id:'native'},f.config),{});
  await f.state('ok');
  const parent=(await route(f.input,f.config)).hookSpecificOutput.additionalContext;
  const child=(await route({...sub,agent_id:'kid2'},{...f.config,codexBin:'/missing'})).hookSpecificOutput.additionalContext;
  assert(child.startsWith('Skill list inherited from the parent session')); assert(child.endsWith(parent));
  assert.match(child.slice(0,-parent.length),/call the search_skills tool/);
  assert.deepEqual(await route({...f.input,agent_id:'kid2'},f.config),{});
  assert.equal((await f.calls()).filter(x=>x==='turn/start').length,1);
  assert.match((await route({...sub,agent_id:'kid3',session_id:'other'},{...f.config,codexBin:'/missing'})).systemMessage,/SKILLS_CODEX_UNAVAILABLE/);
  const [hook]=f.call(JSON.stringify({...sub,agent_id:'kid4'})); assert(hook.hookSpecificOutput.additionalContext.endsWith(parent));
});

test('catalog read waits for plugin skills that appear after login loads',async t=>{
  const f=await fixture(t); await f.state('late');
  const block=(await route(f.input,f.config)).hookSpecificOutput.additionalContext;
  assert.equal((block.match(/^- skill/gmu)||[]).length,12); assert.match(block,/### Available skills\n- skill/);
});

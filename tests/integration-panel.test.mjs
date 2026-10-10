import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {JSDOM} from 'jsdom';
import * as profiles from '../extension/profiles.js';import * as recovery from '../extension/recovery.js';import {AutoRetryClock} from '../extension/auto-retry.js';import {createTask,ImportEngine} from '../extension/engine.js';import {buildExports,contentHash} from '../extension/core.js';import {parseSpecification} from '../extension/openapi.js';import * as bindCheck from '../extension/bind-check.js';
const html=await readFile(new URL('../extension/panel.html',import.meta.url),'utf8');
const source=(await readFile(new URL('../extension/panel.js',import.meta.url),'utf8')).replace(/^import .*$/gm,'');
const flush=()=>new Promise(r=>setImmediate(r));
const seed=()=>profiles.validateProfile({schemaVersion:1,id:'profile',revision:1,name:'IPS',adapterId:'generic',entry:'https://manual.test/docs/index',origin:'https://manual.test',pathPrefix:'/docs',hashMode:'route',queryKeys:[],tocSelector:'nav',contentSelector:'main',navigation:'links',samples:[]});
async function setup(t,{holdTab=false,savedProfiles=[],savedTasks=[],currentURL=null,savedSettings=[]}={}){
 const dom=new JSDOM(html,{url:'https://extension.test/panel.html?tab=1',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());
 const settings=new Map(savedSettings);let releaseTab;const gate=new Promise(r=>releaseTab=r),disk=new Map(savedTasks.map(task=>[task.taskId,structuredClone(task)])),held=new Set();
 const state={captured:[],verified:[],rotation:{running:false,count:0,message:'未开始'},profile:currentURL?{...seed(),id:'detected-profile',entry:currentURL}:seed(),detected:0,picked:null,previewPage:{status:'ok',text:'preview'},verificationPreviews:null,detectionWarnings:[],discoveryWarnings:[],discoveredChapters:null};
 const chapters=['A','C'].map(title=>({key:'url:https://manual.test/docs/'+title,url:'https://manual.test/docs/'+title,title}));
 const clone=v=>structuredClone(v);
 const io={recover:async()=>{state.recovered=(state.recovered||0)+1;},tab:async()=>{if(holdTab)await gate;return{id:1,url:state.profile.entry,status:'complete'};},install:async()=>{if(state.installGate)await state.installGate;},detect:async()=>{state.detected++;return{profile:clone(state.profile),warnings:clone(state.detectionWarnings)};},discover:async()=>({items:clone(state.discoveredChapters??chapters),warnings:clone(state.discoveryWarnings),diagnostics:{}}),pick:async()=>state.picked,
  capture:async(c,p)=>{if(state.captureError)throw new Error(state.captureError);state.captured.push(clone(p));return{status:'ok',url:c.url,text:'body '+c.title,navigationProof:{verified:true},warnings:[],diagnostics:{}};},
  verifySamples:async p=>{if(state.verifyError)throw new Error(state.verifyError);state.verified.push(clone(p));return{verified:true,previews:state.verificationPreviews||p.samples.map(c=>({title:c.title,text:'body '+c.title}))};}};
 function serializable(value){if(value===undefined)throw new Error('Value is unserializable');if(value&&typeof value==='object')Object.values(value).forEach(serializable);}
 Object.assign(w,profiles,recovery,bindCheck,{AutoRetryClock,createTask,ImportEngine,buildExports,contentHash,parseSpecification,createBrowserIO:()=>io,Blob,
  loadProfiles:async()=>clone(savedProfiles),saveProfile:async p=>{state.savedProfile=clone(p);},loadTask:async id=>disk.has(id)?clone(disk.get(id)):null,listTasks:async()=>[...disk.values()],saveTask:async task=>disk.set(task.taskId,clone(task)),saveWholeTask:async task=>disk.set(task.taskId,clone(task)),setSetting:async(key,value)=>settings.set(key,clone(value)),getSetting:async key=>settings.get(key)||null,
  listSettings:async()=>[...settings.keys()],deleteSetting:async key=>{settings.delete(key);},deleteTask:async id=>{disk.delete(id);},
  chrome:{tabs:{getCurrent:async()=>({id:2}),update:async()=>{}},scripting:{executeScript:async options=>{
   if(options.files)return[];if(options.args)serializable(options.args);
   if(typeof options.args?.[0]==='string'){
    const action=options.args[0];if(action==='start')state.rotation={running:true,count:0,message:'运行中'};
    if(action==='stop')state.rotation={...state.rotation,running:false,message:'停止'};
    return[{result:{...state.rotation}}];
   }
   if(options.args)return[{result:state.previewPage}];return[{result:{running:state.rotation.running}}];
  }}}});
 w.navigator.locks={request:async(name,_options,callback)=>{if(held.has(name))return callback(null);held.add(name);try{return await callback({name});}finally{held.delete(name);}}};
 w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=()=>{};w.setInterval=()=>0;
 w.eval(source+'\n;globalThis.TestPanel={render,detect,checkBind,openTask,retryAutomatically,pauseImport,retryClock,previewCurrent,importSpec,scan,run,sample,verifyAndSave,rotationAction,rotationTrial,rotationCall,getTask:()=>task,getProfile:()=>profile,setRotation:value=>{rotationConfig=value;rotationVerified=false;showRotationTargets();},getRotationVerified:()=>rotationVerified};');
 return{w,document:w.document,state,disk,held,api:w.TestPanel,releaseTab,settle:async()=>{for(let i=0;i<15;i++)await flush();}};
}
test('panel web actions remain gated until initialization finishes',async t=>{
 const p=await setup(t,{holdTab:true});assert.equal(p.document.getElementById('start').disabled,true);assert.equal(p.document.getElementById('spec-file').disabled,false);
 p.releaseTab();await p.settle();assert.equal(p.document.getElementById('start').disabled,false);
});
test('a missing article selector exposes calibration while retaining verified default extraction',async t=>{
 const p=await setup(t);await p.settle();p.state.profile.contentSelector='';p.state.detectionWarnings=['未自动识别正文，请点选正文区域'];await p.api.detect();
 assert.equal(p.document.getElementById('start').disabled,false);
 assert.equal(p.document.getElementById('pick-content').disabled,false);
 assert.equal(p.document.getElementById('calibration')?.open,true);
 assert.match(p.document.getElementById('recognition-message')?.textContent||'',/正文/);
 await p.api.run();assert.equal(p.state.verified.length,1);assert.equal(p.state.captured.length,2);
});
test('an empty chapter discovery provides its warning and a calibration action instead of an enabled start',async t=>{
 const p=await setup(t);await p.settle();p.state.discoveredChapters=[];p.state.discoveryWarnings=['目录路径重复，已排除歧义章节'];p.document.getElementById('detect').click();await p.settle();
 assert.equal(p.document.getElementById('start').disabled,true);
 assert.equal(p.document.getElementById('pick-toc').disabled,false);
 const message=p.document.getElementById('recognition-message')?.textContent||'';
 assert.match(message,/章节|目录/);assert.match(message,/路径重复/);
});
test('detection warnings remain visible after the task renders and a later clean detection clears them',async t=>{
 const p=await setup(t);await p.settle();p.state.detectionWarnings=['跨域框架不可访问'];await p.api.detect();p.api.render();
 assert.match(p.document.getElementById('recognition-message')?.textContent||'',/跨域框架/);
 p.state.detectionWarnings=[];await p.api.detect();
 assert.doesNotMatch(p.document.getElementById('recognition-message')?.textContent||'',/跨域框架/);
});
test('switching document modes marks the current entry accessibly and keeps the matching controls visible',async t=>{
 const p=await setup(t);await p.settle();const web=p.document.querySelector('[data-mode="web"]'),spec=p.document.querySelector('[data-mode="spec"]');
 assert.equal(web.getAttribute('aria-current'),'page');spec.click();
 assert.equal(spec.getAttribute('aria-current'),'page');assert.equal(web.hasAttribute('aria-current'),false);
 assert.equal(p.document.querySelector('[data-panel="web"]').hidden,true);
 assert.equal(p.document.querySelector('[data-panel="spec"]').hidden,false);
 assert.equal(p.document.getElementById('spec-file').disabled,false);
});
test('returning from a single-interface specification restores the identified web task',async t=>{
 const p=await setup(t);await p.settle();await p.api.run();const webId=p.api.getTask().taskId;
 p.document.querySelector('[data-mode="spec"]').click();
 await p.api.importSpec(JSON.stringify({openapi:'3.0.3',info:{title:'API',version:'1'},paths:{'/one':{get:{responses:{'200':{description:'OK'}}}}}}),'api.json');
 assert.equal(p.api.getTask().sourceKind,'openapi');
 p.document.querySelector('[data-mode="web"]').click();
 assert.equal(p.api.getTask().taskId,webId);assert.equal(p.document.getElementById('start').disabled,false);
 assert.equal(p.document.getElementById('start').textContent,'继续采集');
});
test('opening a saved specification from the library preserves the current web task',async t=>{
 const spec={taskId:'saved-spec',sourceKind:'openapi',product:'API',version:'1',entry:'local.json',queue:[{key:'one',title:'GET /one',status:'captured'}],pages:{one:{text:'API body'}},status:'finished'};
 const p=await setup(t,{savedTasks:[spec]});await p.settle();const webId=p.api.getTask().taskId;
 p.document.querySelector('[data-mode="library"]').click();await p.settle();
 const specEntry=[...p.document.querySelectorAll('#task-list .task-open')].find(button=>button.textContent.includes('API'));
 assert.ok(specEntry,'the saved specification must be listed');specEntry.click();await p.settle();
 assert.equal(p.api.getTask().taskId,spec.taskId);p.document.querySelector('[data-mode="web"]').click();
 assert.equal(p.api.getTask().taskId,webId);assert.equal(p.document.getElementById('start').disabled,false);
});
test('the library lists source, progress and update time, and deletes a task after confirmation',async t=>{
 const saved={taskId:'saved-web',sourceKind:'web',product:'OldManual',version:'2.1',entry:'https://manual.test/docs/index',profile:seed(),
  queue:[{key:'a',title:'A',status:'captured'},{key:'b',title:'B',status:'failed'}],pages:{},status:'finished',
  createdAt:'2026-01-01T00:00:00.000Z',updatedAt:new Date(Date.now()-3600000).toISOString()};
 const p=await setup(t,{savedTasks:[saved]});await p.settle();
 p.document.querySelector('[data-mode="library"]').click();await p.settle();
 const item=[...p.document.querySelectorAll('#task-list .task-item')].find(row=>row.textContent.includes('OldManual'));
 assert.ok(item,'the saved task must be listed');const text=item.textContent;
 assert.match(text,/OldManual/);assert.match(text,/2\.1/);
 assert.match(text,/已保存 1\/2 章/,'progress must be shown');
 assert.match(text,/docs\/index/,'the source entry must be shown');
 assert.match(text,/更新/,'an update time must be shown');
 assert.match(text,/创建/,'a creation time must be shown');
 assert.equal(item.querySelector('.task-open').disabled,false);
 p.w.confirm=()=>false;item.querySelector('.danger').click();await p.settle();
 assert.equal(p.disk.has('saved-web'),true,'a declined confirmation must not delete anything');
 p.w.confirm=()=>true;item.querySelector('.danger').click();await p.settle();
 assert.equal(p.disk.has('saved-web'),false,'confirming must delete the task');
 assert.doesNotMatch(p.document.querySelector('#task-list').textContent,/OldManual/,'the deleted task must disappear from the list');
});
test('returning to the web task restores a retry timer that expired while viewing a specification',async t=>{
 const p=await setup(t);await p.settle();let callback,timerNumber=0;const clock=p.api.retryClock;
 clock.setTimer=fn=>{callback=fn;return ++timerNumber;};clock.clearTimer=()=>{};
 p.state.verifyError='Failed to fetch';await p.api.run();const original=p.api.getTask().taskId;
 p.document.querySelector('[data-mode="spec"]').click();
 await p.api.importSpec(JSON.stringify({openapi:'3.0.3',info:{title:'API',version:'1'},paths:{}}),'empty.json');
 await callback();assert.equal(clock.timer,null);p.state.verifyError=null;
 p.document.querySelector('[data-mode="web"]').click();assert.equal(p.api.getTask().taskId,original);assert.notEqual(clock.timer,null);
 await callback();await p.settle();assert.equal(p.state.captured.length,2);clock.dispose();
});
test('two selected samples allow collection after custom calibration before a directory rescan',async t=>{
 const p=await setup(t);await p.settle();p.state.discoveredChapters=[];
 p.state.picked={selector:'#custom-toc'};p.document.getElementById('pick-toc').click();await p.settle();
 p.state.picked={url:'https://manual.test/docs/A',title:'A'};await p.api.sample(0);
 p.state.picked={url:'https://manual.test/docs/C',title:'C'};await p.api.sample(1);await p.api.verifyAndSave();p.api.render();
 assert.equal(p.document.getElementById('start').disabled,false);
});
test('edited selectors verify and capture in a new task without replacing earlier pages',async t=>{
 const p=await setup(t);await p.settle();const oldId=p.api.getTask().taskId;
 p.document.getElementById('content-selector').value='#article';await p.api.run();
 assert.notEqual(p.api.getTask().taskId,oldId);assert.ok(p.disk.has(oldId));assert.ok(p.state.captured.every(profile=>profile.contentSelector==='#article'));
 assert.equal(p.api.getTask().profile.contentSelector,p.api.getProfile().contentSelector);
});
test('a denied task lock leaves another task running and scan does not overwrite its metadata',async t=>{
 const p=await setup(t);await p.settle();const task=p.api.getTask();task.status='running';task.queue[0].status='processing';p.disk.set(task.taskId,structuredClone(task));p.held.add('task:'+task.taskId);
 await assert.rejects(p.api.scan(),/另一个|正在/);assert.equal(p.disk.get(task.taskId).status,'running');assert.equal(p.disk.get(task.taskId).queue[0].status,'processing');
});
test('sample B selected first stays in the B slot when A is selected later',async t=>{
 const p=await setup(t);await p.settle();p.state.picked={url:'https://manual.test/docs/B',title:'B'};await p.api.sample(1);p.state.picked={url:'https://manual.test/docs/A',title:'A'};await p.api.sample(0);await p.api.verifyAndSave();
 assert.deepEqual(p.state.verified.at(-1).samples.map(c=>c.title),['A','B']);
});
test('trial can be interrupted from the control page and cannot mutate targets while running',async t=>{
 const p=await setup(t);await p.settle();p.api.setRotation({origin:'https://manual.test',pathPrefix:'/docs',intervalMs:60000,targets:[{selector:'#a',title:'A'}]});
 const trial=p.api.rotationAction(p.api.rotationTrial);await p.settle();assert.equal(p.state.rotation.running,true);
 assert.equal(p.document.querySelector('#rotation-targets button').disabled,true);
 p.document.getElementById('rotation-stop').click();await p.settle();assert.equal(p.state.rotation.running,false);
 await trial;assert.equal(p.api.getRotationVerified(),false);
});

test('all panel previews replace embedded image payloads with a readable offline-image note',async t=>{
 const p=await setup(t);await p.settle();const page={status:'ok',title:'示意图',text:'正常正文',markdown:'正常正文\n![拓扑](data:image/png;base64,QUJDREVGRw==)\n<img alt="截图" src="data:image/png;base64,SElKS0w=">\n'};
 const check=()=>{const value=p.document.getElementById('preview').textContent;assert.match(value,/正常正文/);assert.match(value,/图片：拓扑，导出离线HTML可查看/);assert.match(value,/图片：截图，导出离线HTML可查看/);assert.doesNotMatch(value,/data:image|QUJDREVGRw|SElKS0w/);};
 p.state.previewPage=page;await p.api.previewCurrent();check();
 p.state.verificationPreviews=[page,page];await p.api.verifyAndSave();check();
 p.api.getTask().pages={one:page};p.api.render();check();assert.match(page.markdown,/QUJDREVGRw/);
});
test('panel rejects specification files above 16 MiB before reading or parsing',async t=>{
 const p=await setup(t);await p.settle();let read=false;
 Object.defineProperty(p.document.getElementById('spec-file'),'files',{value:[{size:16*1024*1024+1,name:'large.json',text:async()=>{read=true;return '{}';}}]});
 await p.document.getElementById('spec-file').onchange();assert.equal(read,false);assert.match(p.document.getElementById('error').textContent,/16MiB/);
 await assert.rejects(p.api.importSpec(' '.repeat(16*1024*1024+1),'large.json'),/16MiB/);
});

function storedTask(p,{product='Custom IPS',version='2026.9',updatedAt='2026-09-16T00:00:00Z'}={}){const task=createTask(p,product,version);task.updatedAt=updatedAt;task.queue=[{key:'url:https://manual.test/docs/A',url:'https://manual.test/docs/A',title:'A',status:'captured'}];task.pages={[task.queue[0].key]:{status:'ok',text:'saved content'}};return task;}
test('an unfamiliar manual under the same scope gets detection and a separate task',async t=>{
 const original=seed(),old=storedTask(original);const p=await setup(t,{savedProfiles:[original],savedTasks:[old],currentURL:'https://manual.test/docs/other'});await p.settle();
 assert.equal(p.api.getProfile().entry,'https://manual.test/docs/other');assert.notEqual(p.api.getTask().taskId,old.taskId);assert.equal(p.state.detected,1);assert.equal(p.disk.get(old.taskId).pages[old.queue[0].key].text,'saved content');
});
test('reopening a known chapter restores the newest proven profile and custom product/version',async t=>{
 const a=seed(),b={...seed(),id:'second',contentSelector:'#body'};const older=storedTask(a,{updatedAt:'2026-09-15T00:00:00Z'}),recent=storedTask(b,{product:'My appliance',version:'release 42'});
 const p=await setup(t,{savedProfiles:[a,b],savedTasks:[older,recent],currentURL:'https://manual.test/docs/A'});await p.settle();
 assert.equal(p.api.getProfile().id,'second');assert.equal(p.api.getTask().taskId,recent.taskId);assert.equal(p.document.getElementById('product').value,'My appliance');assert.equal(p.document.getElementById('version').value,'release 42');assert.equal(p.api.getTask().queue[0].status,'captured');assert.equal(p.state.detected,0);
});
test('ambiguous proven profiles wait for explicit saved-rule selection rather than creating a new task',async t=>{
 const a=seed(),b={...seed(),id:'second'};const p=await setup(t,{savedProfiles:[a,b]});await p.settle();
 assert.equal(p.api.getProfile(),null);assert.equal(p.api.getTask(),null);assert.equal(p.state.detected,0);assert.match(p.document.getElementById('profile-status').textContent,/选择.*规则/);assert.equal(p.document.getElementById('start').disabled,true);assert.equal(p.document.getElementById('profile-list').disabled,false);
 p.document.getElementById('profile-list').value='second';await p.document.getElementById('profile-list').onchange();assert.equal(p.api.getTask().profileId,'second');assert.equal(p.state.detected,0);
});


test('transient capture failure schedules automatic recovery and resumes only unsaved chapters',async t=>{
 const p=await setup(t);await p.settle();p.state.captureError='Failed to fetch';await p.api.run();
 const failed=p.api.getTask();assert.equal(failed.autoRecovery.enabled,true);assert.ok(failed.autoRecovery.nextAttemptAt-Date.now()>170000);
 p.state.captureError=null;await p.api.retryAutomatically(failed.taskId);await p.settle();
 assert.equal(p.api.getTask().queue.filter(c=>c.status==='captured').length,2);assert.equal(p.api.getTask().autoRecovery.enabled,false);assert.equal(p.state.recovered,1);
});
test('a temporary preflight error also gets a retry deadline',async t=>{
 const p=await setup(t);await p.settle();p.state.verifyError='Failed to fetch';await p.api.run();
 assert.equal(p.api.getTask().autoRecovery.enabled,true);assert.ok(p.disk.get(p.api.getTask().taskId).autoRecovery.nextAttemptAt);
 await p.api.pauseImport();assert.equal(p.api.getTask().autoRecovery.enabled,false);assert.equal(p.disk.get(p.api.getTask().taskId).autoRecovery.enabled,false);
});
test('duplicate-body review is retained and never scheduled for automatic retry',async t=>{
 const p=await setup(t);await p.settle();await p.api.run();const task=p.api.getTask();
 task.queue[1].status='review';task.queue[1].error='duplicate';p.disk.set(task.taskId,structuredClone(task));
 await p.api.run();assert.equal(p.api.getTask().queue[1].status,'review');assert.equal(p.api.getTask().autoRecovery.enabled,false);
});
test('changing task metadata prevents a pending automatic recovery from taking over another task',async t=>{
 const p=await setup(t);await p.settle();p.state.verifyError='Failed to fetch';await p.api.run();const old=p.api.getTask().taskId;
 p.document.getElementById('product').value='A different manual';await p.api.retryAutomatically(old);
 assert.equal(p.state.recovered||0,0);assert.equal(p.api.getTask().taskId,old);assert.equal(p.api.getTask().autoRecovery.enabled,false);
});


test('reopening the same source login tab restores its persisted recovery plan without fresh detection',async t=>{
 const profile=seed(),saved=createTask(profile,'Saved product','V1');saved.status='waiting_login';saved.recovery={retryable:true,reason:'auth'};
 saved.queue=[{key:'url:https://manual.test/docs/A',url:'https://manual.test/docs/A',title:'A',status:'captured'},{key:'url:https://manual.test/docs/C',url:'https://manual.test/docs/C',title:'C',status:'waiting_login'}];
 saved.pages={[saved.queue[0].key]:{status:'ok',text:'already saved'}};saved.autoRecovery={enabled:true,nextAttemptAt:Date.now()+180000,attempts:2,sourceTabId:1};
 const p=await setup(t,{savedTasks:[saved],savedSettings:[['recovery-tab:1',saved.taskId]],currentURL:'https://manual.test/login'});await p.settle();
 assert.equal(p.api.getTask().taskId,saved.taskId);assert.equal(p.api.getTask().autoRecovery.attempts,2);assert.equal(p.state.detected,0);assert.equal(p.api.getTask().pages[saved.queue[0].key].text,'already saved');await p.api.pauseImport();
});


test('a controller cannot reclaim automatic recovery after the task was bound to another source tab',async t=>{
 const p=await setup(t);await p.settle();p.state.verifyError='Failed to fetch';await p.api.run();const local=p.api.getTask();
 const saved=structuredClone(local);saved.autoRecovery.sourceTabId=9;p.disk.set(saved.taskId,saved);
 await p.api.retryAutomatically(local.taskId);assert.equal(p.state.recovered||0,0);assert.equal(p.disk.get(saved.taskId).autoRecovery.sourceTabId,9);await p.api.pauseImport();
});
test('a newer persisted retry deadline is honored instead of a stale controller starting immediately',async t=>{
 const p=await setup(t);await p.settle();p.state.verifyError='Failed to fetch';await p.api.run();const local=p.api.getTask();
 const saved=structuredClone(local);saved.autoRecovery.nextAttemptAt+=180000;p.disk.set(saved.taskId,saved);
 await p.api.retryAutomatically(local.taskId);assert.equal(p.state.recovered||0,0);assert.equal(p.disk.get(saved.taskId).autoRecovery.nextAttemptAt,saved.autoRecovery.nextAttemptAt);await p.api.pauseImport();
});
test('pausing during source preflight prevents subsequent sample navigation',async t=>{
 const p=await setup(t);await p.settle();let release;p.state.installGate=new Promise(r=>release=r);const running=p.api.run();await p.settle();assert.equal(p.document.getElementById('pause').disabled,false);
 await p.api.pauseImport();release();await running;assert.equal(p.state.verified.length,0);assert.equal(p.state.captured.length,0);assert.equal(p.api.getTask().autoRecovery.enabled,false);
});


test('reopening an interrupted running task persists its new retry deadline before scheduling',async t=>{
 const profile=seed(),saved=createTask(profile,'Interrupted','V1');saved.status='running';saved.autoRecovery={enabled:true,nextAttemptAt:null,attempts:0,sourceTabId:1};
 saved.queue=[{key:'url:https://manual.test/docs/A',url:'https://manual.test/docs/A',title:'A',status:'processing'},{key:'url:https://manual.test/docs/C',url:'https://manual.test/docs/C',title:'C',status:'pending'}];
 const p=await setup(t,{savedTasks:[saved],savedSettings:[['recovery-tab:1',saved.taskId]],currentURL:profile.entry});await p.settle();
 const deadline=p.api.getTask().autoRecovery.nextAttemptAt;assert.ok(deadline>Date.now());assert.equal(p.disk.get(saved.taskId).autoRecovery.nextAttemptAt,deadline);
 await p.api.retryAutomatically(saved.taskId);assert.equal(p.state.recovered,1);assert.equal(p.api.getTask().queue.filter(c=>c.status==='captured').length,2);assert.equal(p.api.getTask().autoRecovery.enabled,false);
});

test('a successful navigation trial remains valid when only the click interval changes',async t=>{
 const p=await setup(t);await p.settle();p.api.setRotation({origin:'https://manual.test',pathPrefix:'/docs',intervalMs:60000,targets:[{selector:'#a',title:'A'}]});
 const trial=p.api.rotationAction(p.api.rotationTrial);await p.settle();p.state.rotation.count=1;await trial;
 assert.equal(p.api.getRotationVerified(),true);p.document.getElementById('rotation-interval').value='120';p.document.getElementById('rotation-interval').dispatchEvent(new p.w.Event('change'));
 p.document.getElementById('rotation-start').click();await p.settle();assert.equal(p.document.getElementById('error').textContent,'');assert.equal(p.state.rotation.running,true);
 p.document.querySelector('#rotation-targets button').click();await p.settle();assert.equal(p.api.getRotationVerified(),false,'removing a target still requires a new trial');
});

test('a saved task from another origin stays listed and selectable, and a stale running task is marked interrupted',async t=>{
 const foreign=profiles.validateProfile({...seed(),id:'foreign',entry:'https://other.test/docs/index'});
 const task={schemaVersion:2,taskId:'foreign-task',profileId:'foreign',profileRevision:1,profile:foreign,entry:foreign.entry,sourceKind:'web',
  product:'IPS',version:'1',createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z',status:'running',
  queue:[{key:'url:https://other.test/docs/A',url:'https://other.test/docs/A',title:'A',status:'captured'}],pages:{},discoveryWarnings:[],scanDiagnostics:{}};
 const p=await setup(t,{savedTasks:[task],currentURL:'https://manual.test/docs/index'});await p.settle();
 assert.equal(p.disk.get('foreign-task').status,'paused','a task left running by a closed console is recognised as interrupted, not live');
 p.document.querySelector('[data-mode="library"]').click();await p.settle();
 // The console also auto-created a task for this tab; pick the foreign one.
 const item=[...p.document.querySelectorAll('#task-list .task-item')].find(li=>li.textContent.includes('other.test'));
 assert.ok(item,'the task must be listed even though its origin differs from this tab');
 assert.doesNotMatch(item.textContent,/正在采集/);
 const open=item.querySelector('.task-open');
 assert.equal(open.disabled,false,'the task must be selectable without matching origin');
 open.click();await p.settle();
 assert.match(p.document.getElementById('error').textContent,/other\.test/,'binding is refused with the reason, not silently matched by origin');
 assert.equal(p.api.getTask().taskId,'foreign-task','the task is still loaded so the user can switch tabs and retry');
});

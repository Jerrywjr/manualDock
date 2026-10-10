import {validateProfile,cleanChapter,jobKey,exportProfile,normalizeDocumentURL,reviseProfile,bindProfile,specificationURL,specificationTaskId,selectSavedProfile} from './profiles.js';
import {classifyBind} from './bind-check.js';
import {redact} from './recovery.js';
import {createTask,ImportEngine} from './engine.js';
import {createBrowserIO} from './browser-io.js';
import {saveTask,saveWholeTask,loadTask,listTasks,saveProfile,loadProfiles,setSetting,getSetting,listSettings,deleteSetting,deleteTask} from './task-store.js';
import {buildExports,contentHash} from './core.js';
import {parseSpecification} from './openapi.js';
import {RETRY_INTERVAL_MS,classifyRecoveryError,recoveryError,resetRetryableChapters,taskHasRetryableWork} from './recovery.js';
import {AutoRetryClock} from './auto-retry.js';
const $=id=>document.getElementById(id),tabId=Number(new URL(location.href).searchParams.get('tab')),io=createBrowserIO(tabId);
let profile=null,task=null,engine=null,busy=false,mode='web',profiles=[],sourceOrigin='',sourcePath='/',rotationConfig=null,rotationVerified=false,rotationBusy=false,rotationPoll=null;
let initialized=false,profileSelectionRequired=false,heldTaskId=null,sampleSlots=[null,null],sampleProfileId='',rotationTrialGeneration=0;
let runGeneration=0,detectionWarnings=[],lastWebTask=null;
const retryClock=new AutoRetryClock({getTask:()=>task?.autoRecovery?.sourceTabId===tabId?task:null,retry:retryAutomatically,onError:error});
const labels={retry_wait:'等待自动重试',ready:'准备就绪',running:'正在采集',paused:'已暂停',waiting_login:'等待重新登录',finished:'已处理当前发现的章节',pending:'待处理',processing:'读取中',captured:'已采集',review:'待核对',failed:'失败'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function showMode(value){if(mode==='web'&&value!=='web'&&task?.sourceKind==='web')lastWebTask=task;if(value==='web'&&!busy&&task?.sourceKind==='openapi'&&lastWebTask?.profileId===profile?.id){task=lastWebTask;$('product').value=task.product;$('version').value=task.version;render();refreshRetryClock();}mode=value;document.querySelectorAll('[data-panel]').forEach(el=>el.hidden=el.dataset.panel!==value);document.querySelectorAll('[data-mode]').forEach(el=>{if(el.dataset.mode===value)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});$('document-meta').hidden=!['web','spec'].includes(value);$('export-step').hidden=value!=='web';}
function error(e){$('error').textContent=e.message||String(e);$('error').hidden=false;}
function previewText(page){
 const note=label=>'[图片：'+(label?.trim()||'未命名图片')+'，导出离线HTML可查看]';
 return String(page.markdown||page.text||'')
  .replace(/!\[((?:\\.|[^\]])*)\]\(\s*<?data:image\/[^)]+\)/gi,(_match,label)=>note(label.replace(/\\([\[\]\\])/g,'$1')))
  .replace(/<img\b[^>]*>/gi,tag=>/\bsrc\s*=\s*["']?data:image\//i.test(tag)?note(tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2]):tag)
  .replace(/data:image\/[^\s"'<>)]*/gi,note('内嵌图片'));
}
function render(){
 const queue=task?.queue||[];for(const [id,value]of Object.entries({found:queue.length,captured:queue.filter(c=>c.status==='captured').length,remaining:queue.filter(c=>['pending','processing','waiting_login'].includes(c.status)).length,issues:queue.filter(c=>['failed','review'].includes(c.status)).length}))$(id).textContent=value;
 $('status').textContent=task?(labels[task.status]||task.status)+(queue.find(c=>c.status==='processing')?' · '+queue.find(c=>c.status==='processing').title:''):'准备就绪';
 $('chapters').replaceChildren(...queue.map(c=>{const li=document.createElement('li');li.textContent=`${labels[c.status]||c.status} · ${c.title}${c.error?' · '+c.error:''}`;return li;}));
 $('diagnostics').textContent=JSON.stringify({recognition:detectionWarnings,warnings:task?.discoveryWarnings||[],scan:task?.scanDiagnostics||{}},null,2);
 const last=Object.values(task?.pages||{}).at(-1);if(last)$('preview').textContent=previewText(last);
 document.querySelectorAll('[data-panel="web"] button,[data-panel="web"] input,[data-panel="web"] select').forEach(el=>el.disabled=busy||!initialized||(profileSelectionRequired&&!['profile-list','detect','import-profile'].includes(el.id)));
 document.querySelectorAll('#product,#version,[data-panel="spec"] input,[data-panel="spec"] button').forEach(el=>el.disabled=busy);
 renderRotationControls();
 renderErrorLog();
 $('pause').disabled=!engine?.running&&!task?.autoRecovery?.enabled;
 renderRecognition(queue);$('error').hidden=!$('error').textContent;
 const recovery=task?.autoRecovery;
 $('retry-status').textContent=recovery?.enabled?(recovery.nextAttemptAt?`等待恢复 · 下次 ${new Date(recovery.nextAttemptAt).toLocaleTimeString()} · 已尝试 ${recovery.attempts||0} 次${task.recovery?.reason==='auth'?' · 请在原标签页重新登录':''}`:'已启用断线恢复；异常时每 3 分钟重试。'):'采集时保留原手册页与控制页。';
 document.querySelectorAll('[data-export]').forEach(el=>el.disabled=!task?.queue.length);
}
function renderRecognition(queue){
 const toc=Boolean(profile?.tocSelector),body=Boolean(profile?.contentSelector),count=queue.length,hasSamples=profile?.samples?.length>=2;
 $('directory-state').textContent=profileSelectionRequired?'待选择规则':count?`${count} 个章节`:toc?'未找到章节':'未识别';
 $('article-state').textContent=body?'已定位':'默认提取 · 待核对';
 const warnings=[...new Set([...detectionWarnings,...(task?.discoveryWarnings||[])])].filter(message=>!(toc&&/未自动识别目录/.test(message))&&!(body&&/未自动识别正文/.test(message)));
 let message='识别完成，可开始采集。',state='ready';
 if(!initialized){message='正在检查目录与正文…';state='waiting';}
 else if(profileSelectionRequired){message='有多份匹配规则，请先选择“使用规则”。';state='attention';}
 else if(!profile){message='识别未完成，请重新识别。';state='attention';}
 else if(!toc){message='未识别目录，请在下方手动选择目录区域。';state='attention';}
 else if(count<2&&!hasSamples){message=count?'当前只找到一个章节；请检查目录范围，至少需要两章验证。':'未找到可采集章节，请选择正确目录并重新扫描。';state='attention';}
 else if(!body){message='正文将使用默认区域提取，请核对预览；开始时仍会验证两章。不准确时手动选择正文区域。';state='attention';}
 else if(warnings.length){message='有识别提示，请核对目录与正文后开始。';state='attention';}
 $('recognition-message').textContent=[message,...warnings].join(' ');$('recognition-message').dataset.state=state;
 if(initialized&&profile&&!profileSelectionRequired&&(!toc||!body||count<2))$('calibration').open=true;
 if(!toc||(count<2&&!hasSamples))$('start').disabled=true;
 $('start').textContent=task?.pages&&Object.keys(task.pages).length?'继续采集':'开始采集';
}
function populateProfile(){if(!profile)return;profileSelectionRequired=false;if(sampleProfileId!==profile.id){sampleProfileId=profile.id;sampleSlots=[profile.samples[0]||null,profile.samples[1]||null];}
 $('scope').value=profile.pathPrefix;$('toc-selector').value=profile.tocSelector;$('content-selector').value=profile.contentSelector;$('hash-mode').value=profile.hashMode;
 $('samples').textContent=sampleSlots.some(Boolean)?sampleSlots.map((chapter,index)=>`${index?'B':'A'}：${chapter?.title||'尚未选择'}`).join('；'):'尚未选择示例章节；开始时会使用目录中的前两章验证';
 $('profile-status').textContent=`${profile.adapterId==='sangfor'?'内置树目录适配':'通用识别'} · ${profile.name}`;}
function syncTaskProfile(){if(task?.profileId===profile?.id&&task?.profileRevision===profile?.revision)task.profile=JSON.parse(JSON.stringify(profile));}
function currentProfile(){if(!profile)throw new Error('请先识别或导入规则');const next=reviseProfile(profile,{pathPrefix:$('scope').value.trim(),tocSelector:$('toc-selector').value.trim(),contentSelector:$('content-selector').value.trim(),hashMode:$('hash-mode').value});
 const changed=next.id!==profile.id;profile=next;if(changed){task=null;populateProfile();}syncTaskProfile();return profile;}

async function locked(action,{source=true,initialization=false}={}){
 if(busy||(source&&!initialized&&!initialization))return;busy=true;$('error').textContent='';render();
 try{await navigator.locks.request(source?`source-tab:${tabId}`:'local-spec-import',{ifAvailable:true},async lock=>{if(!lock)throw new Error('另一个控制页正在使用这个标签页，请先暂停');await action();});}
 catch(e){error(e);}finally{busy=false;render();}
}
async function ensureTask({reload=false,recover=false}={}){profile=currentProfile();const product=$('product').value.trim()||profile.name,version=$('version').value.trim()||'未知';const id=jobKey(profile,product,version);
 if(task?.taskId!==id||reload)task=await loadTask(id)||createTask(profile,product,version);
 if(recover){if(task.status==='running')task.status='paused';for(const c of task.queue)if(c.status==='processing')c.status='pending';}
 syncTaskProfile();return task;
}
async function withTaskLock(action){await ensureTask();const id=task.taskId;if(heldTaskId===id)return action();if(heldTaskId)throw new Error('采集中不能切换规则');
 return navigator.locks.request('task:'+id,{ifAvailable:true},async lock=>{if(!lock)throw new Error('这份手册正在另一个控制页采集');heldTaskId=id;
 try{await ensureTask({reload:true,recover:true});return await action();}finally{heldTaskId=null;}});
}

async function profileList(){profiles=await loadProfiles();$('profile-list').replaceChildren(new Option('自动识别当前页面',''),...profiles.filter(p=>p.origin===sourceOrigin).map(p=>new Option(p.name+' · '+p.entry+' · '+p.id.slice(0,8),p.id)));if(profile)$('profile-list').value=profiles.some(p=>p.id===profile.id)?profile.id:'';}
async function scan(){return withTaskLock(async()=>{engine=new ImportEngine(task,{discover:io.discover,capture:io.capture,save:saveTask,onChange:render});await engine.scan();render();return task.queue;});}
async function previewCurrent(){const current=await io.tab();await io.install();const result=await chrome.scripting.executeScript({target:{tabId},args:[{entry:profile.entry,profile,selector:profile.contentSelector,expectedURL:current.url}],func:opts=>globalThis.ManualCapture.capture(opts)});const page=result[0]?.result;if(page?.status==='ok')$('preview').textContent=previewText(page);}
async function detect(){detectionWarnings=[];const result=await io.detect();detectionWarnings=result.warnings||[];profile={...validateProfile(result.profile),id:crypto.randomUUID(),revision:1,samples:[]};task=null;populateProfile();await scan();await previewCurrent();}
async function selectRegion(kind){const control=await chrome.tabs.getCurrent();await chrome.tabs.update(tabId,{active:true});let picked;try{picked=await io.pick(kind,currentProfile());}finally{if(control?.id)await chrome.tabs.update(control.id,{active:true});}
 if(!picked)throw new Error('未选择页面区域');
 if(kind==='toc'||kind==='content'){profile={...currentProfile(),id:crypto.randomUUID(),revision:1,samples:[],[kind==='toc'?'tocSelector':'contentSelector']:picked.selector};if(picked.frameSelector)profile.frameSelector=picked.frameSelector;else delete profile.frameSelector;populateProfile();task=null;}
 return picked;
}
async function sample(index){const picked=await selectRegion('sample');const chapter=cleanChapter(picked,currentProfile());if(!chapter)throw new Error('所选章节不在当前手册范围内，请重新识别或检查范围');
 sampleSlots[index]=chapter;profile={...profile,samples:sampleSlots.every(Boolean)?[...sampleSlots]:[]};syncTaskProfile();populateProfile();}
async function verifyAndSave(shouldContinue=()=>true){if(!shouldContinue())throw recoveryError("采集已暂停","CANCELLED");profile=currentProfile();if(sampleSlots.some(Boolean)&&!sampleSlots.every(Boolean))throw new Error('请补选另一个示例章节 A 或 B');
 if(sampleSlots.every(Boolean))profile.samples=[...sampleSlots];
 if(profile.samples.length<2){const queue=await scan();if(queue.length<2)throw new Error('需要两个不同章节来验证规则，请点选示例A和B');profile.samples=queue.slice(0,2).map(c=>cleanChapter(c,profile));}
 sampleSlots=[...profile.samples];syncTaskProfile();$('profile-status').textContent='正在打开两个示例，核对正文切换…';if(!shouldContinue())throw recoveryError('采集已暂停','CANCELLED');const result=await io.verifySamples(profile,{shouldContinue});
 await saveProfile(profile);await profileList();populateProfile();$('profile-status').textContent='两个示例验证通过，规则已保存';$('preview').textContent=result.previews.map(p=>p.title+'\n'+previewText(p)).join('\n\n────────\n\n');
}
async function isRotating(){await io.install();const r=await chrome.scripting.executeScript({target:{tabId},func:()=>({running:Boolean(globalThis.SecurityNavigationRotation?.snapshot().running||globalThis.SangforMenuRotation?.snapshot().running)})});return r[0]?.result?.running;}
function refreshRetryClock(){if(!retryClock.running)retryClock.refresh();}
async function pauseImport(){
 runGeneration++;retryClock.dispose();engine?.pause();const current=task;if(!current)return;
 current.autoRecovery={...current.autoRecovery,enabled:false,nextAttemptAt:null};
 $('status').textContent=engine?.running?'将在当前章节保存后暂停…':'已暂停自动恢复';render();
 if(heldTaskId===current.taskId)return;
 await navigator.locks.request('task:'+current.taskId,{ifAvailable:true},async lock=>{
  if(!lock)return;const saved=await loadTask(current.taskId);if(!saved)return;
  saved.autoRecovery={...saved.autoRecovery,enabled:false,nextAttemptAt:null};if(saved.status!=='finished')saved.status='paused';await saveTask(saved);
  if(task?.taskId===current.taskId){task.autoRecovery=saved.autoRecovery;task.status=saved.status;render();}
 });
}
function stillSelected(taskId){
 if(!task||task.taskId!==taskId||!profile)return false;
 const candidate=reviseProfile(profile,{pathPrefix:$('scope').value.trim(),tocSelector:$('toc-selector').value.trim(),contentSelector:$('content-selector').value.trim(),hashMode:$('hash-mode').value});
 return jobKey(candidate,$('product').value.trim()||profile.name,$('version').value.trim()||'未知')===taskId;
}
async function retryAutomatically(taskId){
 if(!task?.autoRecovery?.enabled||task.taskId!==taskId)return;
 if(!stillSelected(taskId)){await pauseImport();return;}
 // A concurrent scan or another controller must not cause a tight retry loop.
 const expectedAttemptAt=task.autoRecovery.nextAttemptAt;task.autoRecovery.nextAttemptAt=Date.now()+RETRY_INTERVAL_MS;
 if(busy||rotationBusy||!initialized)return;
 await locked(()=>run(false,{automatic:true,expectedTaskId:taskId,expectedAttemptAt}));
}
async function run(retry=false,{automatic=false,expectedTaskId=null,expectedAttemptAt=null}={}){
 const generation=++runGeneration;
 return withTaskLock(async()=>{
  if(generation!==runGeneration)return;
  if(automatic&&(task.taskId!==expectedTaskId||!task.autoRecovery?.enabled||task.autoRecovery.sourceTabId!==tabId||task.autoRecovery.nextAttemptAt!==expectedAttemptAt))return;
  task.autoRecovery={enabled:true,nextAttemptAt:null,attempts:(task.autoRecovery?.attempts||0)+(automatic?1:0),sourceTabId:tabId};render();
  await saveTask(task);await setSetting('recovery-tab:'+tabId,task.taskId);
  try{
   if(generation!==runGeneration)return;
   if(automatic){const state=await io.recover(profile);if(state?.status==='auth')throw recoveryError('登录已失效，请在原页面重新登录','AUTH_REQUIRED');}
   if(generation!==runGeneration)return;
   if(await isRotating())throw new Error('此标签页正在导航轮换，请另开手册标签页采集');
   if(generation!==runGeneration)return;await verifyAndSave(()=>generation===runGeneration);if(generation!==runGeneration)return;
   if(automatic)resetRetryableChapters(task);
   // Re-collecting a "review" chapter replaces its saved page, so never do it
   // silently; failed chapters carry no kept body and are safe to retry.
   else if(retry){const reviews=task.queue.filter(c=>c.status==='review');
    for(const c of task.queue)if(c.status==='failed'){c.status='pending';delete c.error;delete c.recovery;}
    if(reviews.length&&confirm(`有 ${reviews.length} 个「待核对」章节。继续会用新采集的内容替换已保存的原文，原有正文不再保留。\n\n确认重新采集这些章节？`))for(const c of reviews){c.status='pending';delete c.error;delete c.recovery;}}
   engine=new ImportEngine(task,{discover:io.discover,capture:io.capture,save:saveTask,onChange:render});await engine.run();
  }catch(e){task.recovery={...classifyRecoveryError(e),message:redact(e.message)};task.status=task.recovery.reason==='auth'?'waiting_login':'paused';error(e);}
  finally{
   const again=generation===runGeneration&&taskHasRetryableWork(task);
   task.autoRecovery={...task.autoRecovery,enabled:again,nextAttemptAt:again?Date.now()+RETRY_INTERVAL_MS:null};
   if(again&&task.status!=='waiting_login')task.status='retry_wait';
   if(generation!==runGeneration&&task.status!=='finished')task.status='paused';
   await saveTask(task);render();refreshRetryClock();
  }
 });
}

function download(text,name,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type:type+';charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
const statusLabels={ready:'准备就绪',paused:'已暂停',finished:'已处理当前发现的章节',waiting_login:'等待重新登录',retry_wait:'等待自动重试'};
 function taskState(task){
 if(!task)return '未知';
 // A task left as running by a closed control page must not look live forever.
 // The heartbeat is written by every checkpoint; a stale one means interrupted,
 // never background execution.
 const stamp=Date.parse(task.heartbeat?.at||task.updatedAt||0);
 const fresh=Number.isFinite(stamp)&&Date.now()-stamp<120000;
 if(task.status==='running')return fresh?'正在采集':'已中断，可继续采集';
 return statusLabels[task.status]||task.status||'未知';
}
function stamp(value){const time=Date.parse(value||0);return Number.isFinite(time)?new Date(time).toLocaleString():'未知';}
function ago(value){const time=Date.parse(value||0);if(!Number.isFinite(time))return '未知';
 const minutes=Math.round((Date.now()-time)/60000);
 if(minutes<1)return '刚刚';if(minutes<60)return minutes+' 分钟前';
 const hours=Math.round(minutes/60);if(hours<24)return hours+' 小时前';return Math.round(hours/24)+' 天前';}
/** Prove the current tab really serves this task before binding: scope, login
 *  state and the saved calibration rule, never origin equality alone. */
async function checkBind(profile,task){
 let current;try{current=await io.tab();}catch(error){return {ok:false,reason:error.message};}
 const pre=classifyBind(profile,current?.url);
 if(!pre.ok)return pre;
 try{
  await io.install();
  const r=await chrome.scripting.executeScript({target:{tabId},args:[profile],func:profile=>{
   const adapters=globalThis.SecurityManualAdapters;if(!adapters)return {ok:false,reason:'页面脚本未加载，请刷新手册页'};
   try{
    const doc=profile.frameSelector?document.querySelector(profile.frameSelector)?.contentDocument:document;
    if(!doc?.documentElement)return {ok:false,reason:'无法访问文档框架'};
    if(!profile.tocSelector)return {ok:false,reason:'已保存规则缺少目录选择器，请重新校准'};
    if(doc.querySelectorAll(profile.tocSelector).length!==1)return {ok:false,reason:'已保存的目录规则在当前页面不唯一，请重新校准'};
    if(profile.contentSelector&&doc.querySelectorAll(profile.contentSelector).length!==1)return {ok:false,reason:'已保存的正文规则在当前页面不唯一，请重新校准'};
    const body=globalThis.ManualCapture.readState({entry:profile.entry,profile,selector:profile.contentSelector});
    if(body?.auth)return {ok:false,reason:'当前页面需要登录，请登录后重试'};
    return {ok:true};
   }catch(error){return {ok:false,reason:error?.message||'规则检查失败'};}
  }});
  const result=r[0]?.result;if(!result?.ok)return {ok:false,reason:result?.reason||'无法在当前标签页完成规则检查'};
 }catch(error){return {ok:false,reason:'无法在当前标签页执行检查：'+error.message};}
 return {ok:true};
}
/** Open any saved task; a web task is bound only after checkBind passes. */
async function openTask(summary){
 const full=await loadTask(summary.taskId);if(!full)throw new Error('任务已不存在，请刷新列表');
 if(full.sourceKind!=='web'){task=full;$('product').value=task.product;$('version').value=task.version;render();return;}
 if(!full.profile)throw new Error('该任务没有保存识别规则，请重新识别');
 let saved;try{saved=validateProfile(full.profile);}catch(error){throw new Error('已保存的识别规则无效：'+error.message);}
 const check=await checkBind(saved,full);
 task=full;$('product').value=task.product;$('version').value=task.version;
 if(!check.ok){error(new Error(check.reason));render();return;}
 profile=saved;populateProfile();
 task.autoRecovery={...(task.autoRecovery||{}),sourceTabId:tabId};
 await setSetting('recovery-tab:'+tabId,task.taskId);
 await saveTask(task);
 if(task.status==='running'){task.status='paused';await saveTask(task);}
 showMode('web');render();refreshRetryClock();
}
/** A closed console leaves status 'running'; only mark it interrupted when no
 *  other console holds the task lock. This is labelling, not background work. */
async function markInterrupted(){
 for(const summary of await listTasks()){
  if(summary.sourceKind!=='web'||summary.status!=='running')continue;
  const stamp=Date.parse(summary.heartbeat?.at||summary.updatedAt||0);
  if(Number.isFinite(stamp)&&Date.now()-stamp<120000)continue;
  await navigator.locks.request('task:'+summary.taskId,{ifAvailable:true},async lock=>{
   if(!lock)return;
   const full=await loadTask(summary.taskId);if(!full||full.status!=='running')return;
   const at=Date.parse(full.heartbeat?.at||full.updatedAt||0);
   if(Number.isFinite(at)&&Date.now()-at<120000)return;
   full.status='paused';full.recovery={...(full.recovery||{}),reason:'interrupted',message:'控制台已关闭，采集中断；可重新绑定标签页后继续采集'};
   await saveTask(full);
  });
 }
}
function renderErrorLog(){
 const log=Array.isArray(task?.errorLog)&&task.errorLog.length?task.errorLog.slice(0,10):null;
 $('error-log').textContent=log?log.map(entry=>{
  const when=entry.at?new Date(entry.at).toLocaleString():'未知时间';
  const where=[entry.stage,entry.chapterTitle].filter(Boolean).join(' · ')||'未标注阶段';
  return `${when}  ${where}\n  ${entry.name}: ${entry.message}\n  ${String(entry.stack||'').split('\n')[0]||''}`;
 }).join('\n\n'):'暂无记录';
}
async function library(){
 const tasks=(await listTasks()).sort((a,b)=>Date.parse(b.updatedAt||0)-Date.parse(a.updatedAt||0));
 if(!tasks.length){const li=document.createElement('li');li.className='empty-hint';li.textContent='还没有保存的任务。';$('task-list').replaceChildren(li);return;}
 $('task-list').replaceChildren(...tasks.map(t=>{
  const captured=t.queue.filter(c=>c.status==='captured').length,total=t.queue.length;
  const li=document.createElement('li');li.className='task-item';
  const open=document.createElement('button');open.className='task-open';
  for(const text of [`${t.product||'未命名'} · ${t.version||'未知'}`,
   `${t.sourceKind==='openapi'?'规范文件':'在线手册'} · 已保存 ${captured}/${total} 章 · ${taskState(t)}${t.errorLog?.length?` · 错误 ${t.errorLog.length} 条`:''}`,
   `来源 ${t.entry||'未知'}`,`更新 ${stamp(t.updatedAt)}（${ago(t.updatedAt)}） · 创建 ${stamp(t.createdAt)}`]){
   const span=document.createElement('span');span.textContent=text;open.append(span);}
  // A specification task is local, so it can always be opened; a web task needs
  // the control page that is bound to the same manual tab.
  // Every saved task is listed and selectable; binding is decided by checkBind
  // at click time, not by comparing origins in the list.
  open.disabled=false;
  open.title=t.sourceKind==='web'?'打开这个任务；若当前标签页不是该手册，会先检查来源、手册范围、登录状态与采集规则':'在控制页打开这个规范任务';
  open.onclick=()=>locked(async()=>{await openTask(t);},{source:false});
  const save=document.createElement('button');save.textContent='导出 JSON';save.className='quiet';
  save.onclick=async()=>{try{const full=await loadTask(t.taskId);if(full)download(buildExports(full).json,`${String(t.product||'manual').replace(/[\\/:*?"<>|]/g,'_')}.json`);}catch(e){error(e);}};
  const drop=document.createElement('button');drop.textContent='删除';drop.className='quiet danger';
  drop.onclick=()=>{
   if(!confirm(`删除任务「${t.product||'未命名'} · ${t.version||'未知'}」？\n\n已保存 ${captured}/${total} 章内容与采集进度将永久删除，已保存的识别规则会保留。\n来源：${t.entry||'未知'}\n更新：${stamp(t.updatedAt)}`))return;
   Promise.resolve(deleteTask(t.taskId)).then(async()=>{
    for(const key of await listSettings())if(key.startsWith('recovery-tab:')&&await getSetting(key)===t.taskId)await deleteSetting(key);
    if(task?.taskId===t.taskId){task=null;profile=null;$('product').value='';$('version').value='';}
    await library();render();}).catch(error);};
  const actions=document.createElement('div');actions.className='task-actions';actions.append(save,drop);
  li.append(open,actions);return li;
 }));
}
async function importSpec(text,filename,sourceURL){if(text.length>16*1024*1024)throw new Error('规范文件超过16MiB上限');const result=parseSpecification(text,{filename,sourceURL,product:$('product').value,version:$('version').value});const identity=await contentHash(text),product=$('product').value.trim()||result.title,version=$('version').value.trim()||result.version||'未知';
 if(task?.sourceKind==='web')lastWebTask=task;
 task={schemaVersion:2,taskId:specificationTaskId(identity,sourceURL||'file:'+filename,product,version),sourceKind:'openapi',specVersion:result.specVersion,entry:sourceURL||'本地文件:'+filename,product:$('product').value.trim()||result.title,version:$('version').value.trim()||result.version||'未知',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'finished',queue:result.queue.map(c=>({...c,status:'captured'})),pages:result.pages,discoveryWarnings:result.warnings,scanDiagnostics:{source:'specification'}};
 for(const page of Object.values(task.pages)){page.hash=await contentHash(page.text);page.capturedAt=new Date().toISOString();}
 await saveWholeTask(task);$('spec-status').textContent=`已导入 ${task.queue.length} 个接口说明；未执行接口请求`;render();}
async function fetchSpec(){const current=await io.tab();const u=new URL(specificationURL($('spec-url').value,current.url));
 const r=await chrome.scripting.executeScript({target:{tabId},args:[u.href],func:async raw=>{const url=new URL(raw);if(url.origin!==location.origin)throw new Error('文档地址与原页面不同源');const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('读取失败：HTTP '+response.status);const reader=response.body.getReader();const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16*1024*1024){await reader.cancel();throw new Error('规范文件超过16MiB');}chunks.push(value);}return new Blob(chunks).text();}});await importSpec(r[0].result,u.pathname.split('/').at(-1),u.href);}
function renderRotationControls(){document.querySelectorAll('[data-panel="rotation"] button,[data-panel="rotation"] input').forEach(el=>{el.disabled=el.id==='rotation-stop'?!initialized:busy||rotationBusy||!initialized;});$('rotation-save').disabled=busy||rotationBusy||!initialized||!rotationVerified;}
function showRotationTargets(){const targets=rotationConfig?.targets||[];$('rotation-targets').replaceChildren(...targets.map((t,i)=>{const li=document.createElement('li');li.textContent=(i+1)+'. '+t.title;const b=document.createElement('button');b.textContent='移除';b.onclick=()=>{if(rotationBusy||busy)return;targets.splice(i,1);rotationVerified=false;showRotationTargets();};li.append(b);return li;}));renderRotationControls();}

function rotationSettings(){const interval=Number($('rotation-interval').value);if(!Number.isInteger(interval)||interval<30||interval>3600)throw new Error('间隔请设为30至3600秒');return {...rotationConfig,intervalMs:interval*1000};}
async function rotationCall(action,config){const current=await io.tab();if(new URL(current.url).origin!==sourceOrigin)throw new Error('原页面已离开所选网站');if(action==='start')await chrome.scripting.executeScript({target:{tabId},files:['navigation-discovery.js','navigation-rotation.js']});
 const r=await chrome.scripting.executeScript({target:{tabId},args:[action,config??null,sourceOrigin],func:(action,config,origin)=>{if(location.origin!==origin)throw new Error('原页面来源已变化');const c=globalThis.SecurityNavigationRotation;if(!c)return {running:false,count:0,message:'尚未启动'};return action==='start'?c.start(config):c[action]();}});const state=r[0]?.result;$('rotation-status').textContent=`${state.message} · 最近点击：${state.lastLabel||'无'} · 累计 ${state.count||0} 次`;return state;}
async function rotationAction(action){if(busy||rotationBusy||!initialized)return;rotationBusy=true;renderRotationControls();$('error').textContent='';try{await navigator.locks.request('source-tab:'+tabId,{ifAvailable:true},async lock=>{if(!lock)throw new Error('这个标签页正在采集，请选择独立管理标签页');await action();});}catch(e){error(e);}finally{rotationBusy=false;renderRotationControls();}}
async function pickRotation(){if((await rotationCall('snapshot'))?.running)throw new Error('请先停止轮换再修改');const control=await chrome.tabs.getCurrent();await chrome.tabs.update(tabId,{active:true});let picked;try{picked=await io.pick('rotation',profile);}finally{if(control?.id)await chrome.tabs.update(control.id,{active:true});}if(picked.frameSelector)throw new Error('首版轮换仅支持主页面导航，请在管理主页面选择');if(!rotationConfig)rotationConfig={origin:sourceOrigin,pathPrefix:sourcePath,intervalMs:60000,targets:[]};rotationConfig.targets.push({selector:picked.selector,title:picked.title});rotationVerified=false;showRotationTargets();}
async function stopRotation(){rotationTrialGeneration++;if(rotationBusy)rotationVerified=false;return rotationCall('stop');}
async function rotationTrial(){const config=JSON.parse(JSON.stringify(rotationSettings()));if(!config.targets.length)throw new Error('请先点选导航菜单');
 const trial=++rotationTrialGeneration;rotationVerified=false;await rotationCall('stop');let state=await rotationCall('start',{...config,intervalMs:1000});if(!state.running)throw new Error(state.message);
 try{const end=Date.now()+config.targets.length*1500+5000;
 while(trial===rotationTrialGeneration&&state.running&&state.count<config.targets.length&&Date.now()<end){await sleep(200);if(trial!==rotationTrialGeneration)break;state=await rotationCall('snapshot');}
 if(trial!==rotationTrialGeneration)throw new Error('试运行已取消');
 if(!state.running||state.count!==config.targets.length)throw new Error(state.message||'试运行未完成');rotationVerified=true;
 }finally{if(trial===rotationTrialGeneration)await rotationCall('stop');}
 showRotationTargets();$('rotation-status').textContent='所选导航顺序试运行通过，可保存规则或开始轮换';
}

async function preset(){
 if((await rotationCall('snapshot'))?.running)throw new Error('请先停止轮换再重新识别');
 await chrome.scripting.executeScript({target:{tabId},files:['navigation-discovery.js']});
 const r=await chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.SecurityNavigationDiscovery.discover()});const result=r[0]?.result;
 if(!result?.targets?.length)throw new Error(result?.warnings?.join('；')||'未识别到足够可靠的主菜单，请在原页面点选');
 if(result.origin!==sourceOrigin)throw new Error('原页面来源已变化');
 rotationConfig={origin:sourceOrigin,pathPrefix:result.pathPrefix,intervalMs:60000,targets:result.targets};rotationVerified=false;showRotationTargets();
 $('rotation-status').textContent=`已从当前页面识别 ${result.targets.length} 个导航菜单；请核对列表并试运行。${(result.warnings||[]).join('；')}`;
}
const actions={detect:()=>locked(detect),'pick-toc':()=>locked(()=>selectRegion('toc')),'pick-content':()=>locked(()=>selectRegion('content')),'sample-a':()=>locked(()=>sample(0)),'sample-b':()=>locked(()=>sample(1)),verify:()=>locked(verifyAndSave),scan:()=>locked(scan),start:()=>locked(()=>run()),retry:()=>locked(()=>run(true)),pause:()=>pauseImport().catch(error),'export-profile':()=>locked(async()=>download(exportProfile(currentProfile()),'manual-profile.json')),'fetch-spec':()=>locked(fetchSpec),'refresh-library':library,
 'rotation-pick':()=>rotationAction(pickRotation),'rotation-preset':()=>rotationAction(preset),'rotation-clear':()=>rotationAction(async()=>{await rotationCall('stop');rotationConfig={origin:sourceOrigin,pathPrefix:sourcePath,intervalMs:60000,targets:[]};rotationVerified=false;showRotationTargets();}),
 'rotation-trial':()=>rotationAction(rotationTrial),'rotation-save':()=>rotationAction(async()=>{if(!rotationVerified)throw new Error('请先试运行');rotationConfig=rotationSettings();await setSetting('rotation:'+sourceOrigin,rotationConfig);$('rotation-status').textContent='轮换规则已保存';}),
 'rotation-start':()=>rotationAction(async()=>{if(!rotationVerified)throw new Error('请先试运行所选顺序');const result=await rotationCall('start',rotationSettings());if(!result.running)throw new Error(result.message);}), 'rotation-stop':()=>stopRotation().catch(error),
 'rotation-export':()=>rotationAction(async()=>download(JSON.stringify({format:'security-navigation-profile',schemaVersion:1,config:rotationSettings()},null,2),'navigation-profile.json'))};
for(const [id,action]of Object.entries(actions))$(id).addEventListener('click',action);
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{showMode(b.dataset.mode);if(mode==='library')library().catch(error);});
async function useSavedProfile(selected,currentURL){detectionWarnings=[];profile=selected.status==='none'?bindProfile(selected.profile,currentURL):validateProfile(selected.profile);task=null;
 $('product').value=selected.task?.product||'';$('version').value=selected.task?.version||'';populateProfile();$('profile-list').value=profiles.some(p=>p.id===profile.id)?profile.id:'';
 if(selected.status==='ambiguous'){$('profile-status').textContent='规则已选择；有多份任务且无法确定最近一份，请填写原产品与版本后扫描，或从本地资料库打开任务';return;}
 await scan();await previewCurrent();}
$('profile-list').onchange=()=>locked(async()=>{const saved=profiles.find(p=>p.id===$('profile-list').value);if(!saved)return detect();const current=await io.tab();const selected=selectSavedProfile(current.url,[saved],await listTasks());await useSavedProfile({...selected,profile:saved},current.url);});
$('import-profile').onchange=()=>locked(async()=>{const file=$('import-profile').files[0];if(!file)return;if(file.size>1024*1024)throw new Error('规则文件过大');const current=await io.tab();if(new URL(current.url).origin!==sourceOrigin)throw new Error('原标签页已离开当前网站');
 profile=bindProfile(JSON.parse(await file.text()),current.url);task=null;populateProfile();await scan();$('profile-status').textContent='规则已重新绑定 '+profile.origin+' '+profile.pathPrefix+'；请验证当前设备的两个示例后保存';});
$('spec-file').onchange=()=>locked(async()=>{const f=$('spec-file').files[0];if(!f)return;if(f.size>16*1024*1024)throw new Error('规范文件超过16MiB');await importSpec(await f.text(),f.name);},{source:false});
$('rotation-import').onchange=()=>rotationAction(async()=>{const f=$('rotation-import').files[0];if(!f||f.size>1024*1024)throw new Error('轮换规则文件无效');const value=JSON.parse(await f.text());if(value.format!=='security-navigation-profile'||value.schemaVersion!==1||value.config?.origin!==sourceOrigin)throw new Error('轮换规则格式或设备来源不符');rotationConfig=value.config;rotationVerified=false;$('rotation-interval').value=(value.config.intervalMs||60000)/1000;showRotationTargets();});
$('rotation-interval').onchange=()=>{showRotationTargets();};
const names={markdown:'manual.md',html:'offline.html',json:'archive.json',report:'report.txt'},types={markdown:'text/markdown',html:'text/html',json:'application/json',report:'text/plain'};
document.querySelectorAll('[data-export]').forEach(b=>b.onclick=async()=>{try{const snapshot=await loadTask(task.taskId)||task;download(buildExports(snapshot)[b.dataset.export],names[b.dataset.export],types[b.dataset.export]);}catch(e){error(e);}});
window.addEventListener('pagehide',()=>{retryClock.dispose();engine?.pause();clearInterval(rotationPoll);});
for(const id of ['product','version','scope','toc-selector','content-selector','hash-mode'])$(id).addEventListener('change',()=>{if(task?.autoRecovery?.enabled&&!engine?.running)pauseImport().catch(error);});
async function savedRecovery(current){
 const id=await getSetting('recovery-tab:'+tabId);if(!id)return null;const saved=await loadTask(id);
 if(!saved?.autoRecovery?.enabled||saved.autoRecovery.sourceTabId!==tabId||saved.sourceKind!=='web'||!saved.profile)return null;
 let candidate;try{candidate=validateProfile(saved.profile);}catch{return null;}
 const currentURL=current.url||'',browserError=/^chrome-error:\/\//i.test(currentURL);
 const address=browserError?current.pendingUrl:currentURL;if(!address)return null;
 let u;try{u=new URL(address);}catch{return null;}
 if(u.origin!==candidate.origin)return null;
 const login=/\/(?:login|logon|signin|sign-in|sso)(?:[./_-]|$)/i.test(u.pathname);
 const proven=selectSavedProfile(address,[candidate],[saved]).status==='selected';
 if(!proven&&!login&&!(browserError&&normalizeDocumentURL(address,candidate)))return null;
 return {task:saved,profile:candidate,address};
}
async function restoreRetryDeadline(){
 if(!task?.autoRecovery?.enabled)return;const id=task.taskId;
 await navigator.locks.request('task:'+id,{ifAvailable:true},async lock=>{
  if(!lock){task.autoRecovery={...task.autoRecovery,enabled:false};$('profile-status').textContent='另一个控制页正在使用此任务；本页未启动自动恢复';return;}
  const saved=await loadTask(id);if(!saved||task?.taskId!==id)return;
  if(saved.autoRecovery?.enabled&&saved.autoRecovery.sourceTabId===tabId&&!Number.isFinite(saved.autoRecovery.nextAttemptAt)){
   saved.autoRecovery.nextAttemptAt=Date.now()+RETRY_INTERVAL_MS;await saveTask(saved);
  }
  task=saved;
 });
 refreshRetryClock();
}
async function initialize(){
 try{if(!Number.isInteger(tabId)||tabId<=0)throw new Error('请从已登录的文档或管理标签页点击扩展');const current=await io.tab();const recovery=await savedRecovery(current);const u=new URL(recovery?.address||current.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('只支持HTTP/HTTPS页面');sourceOrigin=u.origin;sourcePath=u.pathname;
 $('connection').textContent='来源：'+u.origin+u.pathname;
 rotationConfig=await getSetting('rotation:'+sourceOrigin)||{origin:sourceOrigin,pathPrefix:sourcePath,intervalMs:60000,targets:[]};rotationVerified=rotationConfig.targets.length>0;$('rotation-interval').value=rotationConfig.intervalMs/1000;showRotationTargets();
 await profileList();const selected=selectSavedProfile(current.url,profiles,await listTasks());
 if(recovery){task=recovery.task;profile=recovery.profile;$('product').value=task.product;$('version').value=task.version;populateProfile();$('profile-status').textContent='已恢复原任务和自动重试计划；已保存章节保留';}
 else if(selected.status==='selected'){await locked(()=>useSavedProfile(selected,current.url),{initialization:true});}
 else if(selected.status==='ambiguous'){profileSelectionRequired=true;$('profile-status').textContent='多份已保存规则或任务均匹配，无法确定最近使用项；请从列表明确选择已保存规则';}
 else{await locked(detect,{initialization:true});}
 rotationPoll=setInterval(()=>{if(mode==='rotation'&&!busy&&!rotationBusy)rotationCall('snapshot').catch(e=>{$('rotation-status').textContent='状态未知：'+e.message;});},3000);
 }catch(e){error(e);$('connection').textContent=e.message;}finally{initialized=Boolean(sourceOrigin);try{await restoreRetryDeadline();await markInterrupted();}catch(e){error(e);}render();}}
render();initialize();

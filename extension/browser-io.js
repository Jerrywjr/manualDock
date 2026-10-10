import {normalizeDocumentURL} from './profiles.js';
import {classifyRecoveryError,recoveryError} from './recovery.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const navigationInterrupted=error=>/execution context (?:was )?(?:destroyed|removed)|frame (?:was )?removed|context invalidated|unload/i.test(error?.message||'');
const loginURL=url=>/\/(?:login|logon|signin|sign-in|sso)(?:[./_-]|$)/i.test(new URL(url).pathname);
function embeddedImageSources(page){
 if(!(page.diagnostics?.images?.embedded>0))return [];
 return [...String(page.html||'').matchAll(/<img\b[^>]*>/gi)].map(([tag])=>tag.match(/(?:^|\s)src\s*=\s*(["'])(data:image\/[\w.+-]+;base64,[a-z0-9+/=\s]+)\1/i)?.[2]?.replace(/\s/g,'')).filter(Boolean);
}
export function createBrowserIO(tabId){
  async function tab(){try{return await chrome.tabs.get(tabId);}catch{throw new Error('原标签页已关闭，请从已登录的页面重新点击扩展');}}
  async function install(){await chrome.scripting.executeScript({target:{tabId},files:['tree.js','manual-adapters.js','capture.js']});}
  async function adapter(method,options){const r=await chrome.scripting.executeScript({target:{tabId},args:[method,options],func:(name,args)=>globalThis.SecurityManualAdapters[name](args)});return r[0]?.result;}
  async function state(profile,chapter){const r=await chrome.scripting.executeScript({target:{tabId},args:[profile,chapter??null],func:(profile,chapter)=>{
    const doc=profile.frameSelector?document.querySelector(profile.frameSelector)?.contentDocument:document;
    const identities=globalThis.SecurityManualDocumentIdentities||(globalThis.SecurityManualDocumentIdentities=new WeakMap());
    if(doc&&!identities.has(doc))identities.set(doc,crypto.randomUUID());
    const documentURL=doc?globalThis.SecurityManualAdapters.normalizeURL(doc.URL,profile,doc.URL):null;
    const proof=profile.frameSelector&&chapter&&!chapter.locator?{verified:Boolean(documentURL&&documentURL===globalThis.SecurityManualAdapters.normalizeURL(chapter.url,profile)),kind:'frame-url'}:chapter?globalThis.SecurityManualAdapters.verify({profile,chapter}):null;
    return {documentId:doc?identities.get(doc):null,documentURL,body:globalThis.ManualCapture.readState({entry:profile.entry,profile,selector:profile.contentSelector}),proof};
  }});return r[0]?.result;}
  async function detect(){const current=await tab();if(!current.url||!/^https?:/.test(current.url))throw new Error('请在已登录的HTTP/HTTPS文档页点击扩展');await install();return adapter('detect',{entry:current.url});}
  async function discover(profile){const current=await tab();if(!current.url||new URL(current.url).origin!==profile.origin)throw new Error('原标签页已离开手册网站');if(loginURL(current.url))return {status:'auth'};
    await install();if((await state(profile))?.body.auth)return {status:'auth'};return adapter('discover',{profile});}
  async function recover(profile){
    let current=await tab();
    const browserError=/^chrome-error:\/\//i.test(current.url||'');
    const sameOrigin=current.url&&new URL(current.url).origin===profile.origin;
    if(sameOrigin&&loginURL(current.url))return {status:'auth'};
    if(browserError){
      if(!current.pendingUrl||!normalizeDocumentURL(current.pendingUrl,profile))throw new Error('无法确认错误标签页仍属于手册范围，请在手册页重新点击扩展');
    }else{
      if(!sameOrigin)throw new Error('原标签页已离开手册网站');
      if(!normalizeDocumentURL(current.url,profile))throw new Error('已离开手册范围，请检查登录或重新校准');
      // Inline login forms must be left available for the user to finish signing in.
      try{await install();if((await state(profile))?.body.auth)return {status:'auth'};}
      catch(error){if(!classifyRecoveryError(error).retryable)throw error;}
    }
    const entry=normalizeDocumentURL(profile.entry,profile);if(!entry)throw new Error('手册入口不在已保存的范围内，请重新校准');
    await chrome.tabs.update(tabId,{url:entry});
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      await delay(180);current=await tab();
      if(/^chrome-error:\/\//i.test(current.url||''))throw recoveryError('手册页面仍处于网络错误状态','NETWORK_ERROR');
      if(!current.url||new URL(current.url).origin!==profile.origin)throw new Error('页面跳转到其他来源，已停止');
      if(loginURL(current.url))return {status:'auth'};
      if(current.status!=='complete')continue;
      if(!normalizeDocumentURL(current.url,profile))throw new Error('已离开手册范围，请检查登录或重新校准');
      try{await install();if((await state(profile))?.body.auth)return {status:'auth'};return {status:'ok'};}
      catch(error){if(navigationInterrupted(error))continue;throw error;}
    }
    throw recoveryError('等待手册重新连接超时，将在下一轮恢复时重试','LOAD_TIMEOUT');
  }
  async function pick(kind,profile){await install();return adapter('pick',{kind,profile});}
  async function capture(chapter,profile){
    const captureStarted=Date.now();
    let current=await tab();if(!current.url||new URL(current.url).origin!==profile.origin)throw new Error('原标签页已离开手册网站');
    if(loginURL(current.url))return {status:'auth'};await install();const before=await state(profile,chapter);
    if(before?.body.auth)return {status:'auth'};
    // A page-side failure arrives as a reason string; keep the structured fault
    // that the adapter captured so the real cause survives the script boundary.
    if(chapter.locator){try{const result=await adapter('open',{profile,chapter});if(!result?.clicked)throw Object.assign(new Error(result?.reason||'无法唯一打开所选章节'),{fault:result?.fault,stage:'open-directory',chapterKey:chapter.key});}catch(error){if(!navigationInterrupted(error))throw Object.assign(error,{stage:error.stage||'open-directory',chapterKey:error.chapterKey??chapter.key});}}
    else{const target=normalizeDocumentURL(chapter.url,profile);if(!target)throw new Error('章节不在手册范围内');
      if(profile.frameSelector){await chrome.scripting.executeScript({target:{tabId},args:[profile.frameSelector,target,profile.origin],func:(selector,target,origin)=>{
        const frames=document.querySelectorAll(selector);if(frames.length!==1||!frames[0].matches('iframe,frame'))throw new Error('无法唯一定位文档框架');
        const frame=frames[0],doc=frame.contentDocument;if(!doc||new URL(target).origin!==origin||location.origin!==origin)throw new Error('文档框架或目标不同源');
        if(doc.URL!=='about:blank'&&new URL(doc.URL).origin!==origin)throw new Error('文档框架不同源');
        frame.contentWindow.location.assign(target);return {navigated:true};
      }});}else await chrome.tabs.update(tabId,{url:target});
    }
    const start=Date.now(),deadline=start+45000;let signature='',stableSince=0,installed=false,lastBlockers=[],lastFault=null;
    await delay(180);
    while(Date.now()<deadline){
      current=await tab();if(/^chrome-error:\/\//i.test(current.url||''))throw recoveryError('手册页面处于网络错误状态','NETWORK_ERROR');if(!current.url||new URL(current.url).origin!==profile.origin)throw new Error('页面跳转到其他来源，已停止');
      if(loginURL(current.url))return {status:'auth'};
      if(current.status!=='complete'){installed=false;await delay(160);continue;}
      if(!normalizeDocumentURL(current.url,profile))throw new Error('已离开手册范围，请检查登录或重新校准');
      if(!chapter.locator&&!profile.frameSelector&&normalizeDocumentURL(current.url,profile)!==chapter.url){await delay(160);continue;}
      let observed;
      try{if(!installed){await install();installed=true;}observed=await state(profile,chapter);}
      catch(error){if(navigationInterrupted(error)){installed=false;await delay(160);continue;}throw Object.assign(error,{stage:error.stage||'read-state',chapterKey:error.chapterKey??chapter.key});}
      if(observed?.body.auth)return {status:'auth'};
      const observedFault = observed?.proof?.fault || observed?.body?.fault || null;
      if(observedFault)lastFault = observedFault;
      const changed=observed?.body.signature!==before?.body.signature;
      const newDocument=Boolean(before?.documentId&&observed?.documentId&&before.documentId!==observed.documentId);
      const switched=newDocument||before?.proof?.verified||changed;
      const blockers=[!observed?.proof?.verified&&'目录选中未确认',!observed.body.nonEmpty&&'正文为空',observed.body.loading&&'仍在加载',!switched&&'正文未变化'].filter(Boolean);
      lastBlockers=blockers;
      const ready=observed?.proof?.verified&&observed.body.nonEmpty&&!observed.body.loading&&switched;
      if(!ready){signature='';stableSince=0;await delay(160);continue;}
      if(signature!==observed.body.signature){signature=observed.body.signature;stableSince=Date.now();}
      if(Date.now()-stableSince>=600&&Date.now()-start>=1200){
        const navigationFinished=Date.now();
        const r=await chrome.scripting.executeScript({target:{tabId},args:[{entry:profile.entry,profile,selector:profile.contentSelector,chapter,...(chapter.locator?{locator:chapter.locator}:{}),expectedURL:current.url,chapterTitle:chapter.title}],func:options=>globalThis.ManualCapture.capture(options)});
        const result=r[0]?.result;if(!result)throw new Error('页面未返回正文');
        if(result.status==='ok'){const final=await state(profile,chapter);if(!final?.proof?.verified)throw new Error('正文读取后目录选中状态已变化');if(final.body.loading||!final.body.nonEmpty||final.body.signature!==signature||final.documentId!==observed.documentId){signature='';stableSince=0;continue;}result.navigationProof=final.proof;if(profile.frameSelector&&!chapter.locator)result.url=final.documentURL;result.title=chapter.title||result.title;}
        result.diagnostics={...result.diagnostics,timing:{...result.diagnostics?.timing,navigationMs:navigationFinished-captureStarted,totalMs:Date.now()-captureStarted}};
        if(lastFault&&!result.diagnostics?.fault)result.diagnostics={...result.diagnostics,fault:lastFault};
        return result;
      }
      await delay(160);
    }
    // A bare timeout tells the user nothing about which proof never arrived.
    throw recoveryError(`45秒内未确认章节和正文完成切换，未保存旧正文${lastBlockers.length?`（最后未满足：${lastBlockers.join('、')}）`:''}`,'LOAD_TIMEOUT');
  }
  async function verifySamples(profile,{shouldContinue=()=>true}={}){
    if(profile.samples?.length!==2||profile.samples[0].key===profile.samples[1].key)throw new Error('请选取两个不同的示例章节');
    async function sample(chapter){
      if(!shouldContinue())throw recoveryError('采集已暂停','CANCELLED');
      const page=await capture(chapter,profile);
      if(!shouldContinue())throw recoveryError('采集已暂停','CANCELLED');
      if(page.status==='auth')throw recoveryError('登录已失效，等待用户登录后恢复','AUTH_REQUIRED');
      if(page.status!=='ok')throw recoveryError(page.error||page.diagnostics?.reason||'示例章节读取失败，请检查登录或重新点选',page.code);
      return page;
    }
    const first=await sample(profile.samples[0]),second=await sample(profile.samples[1]);
    if(String(first.text||'').trim()===String(second.text||'').trim()){
      const firstImages=embeddedImageSources(first),secondImages=embeddedImageSources(second);
      const realImageChange=JSON.stringify(firstImages)!==JSON.stringify(secondImages);
      const imageOnly= !String(first.text||'').trim();
      if(!realImageChange||(imageOnly&&(!firstImages.length||!secondImages.length)))throw new Error('两个示例正文相同，尚不能确认文字或已保存图片发生切换；请选择不同章节');
    }
    return {verified:true,previews:[first,second]};
  }
  return {tab,install,adapter,state,detect,discover,recover,pick,capture,verifySamples};
}

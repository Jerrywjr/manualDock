import {cleanChapter,jobKey} from './profiles.js';
import {contentHash} from './core.js';
import {classifyRecoveryError} from './recovery.js';
export function createTask(profile,product='未知',version='未知') {
  return {schemaVersion:2,taskId:jobKey(profile,product,version),profileId:profile.id,profileRevision:profile.revision,profile,
    entry:profile.entry,sourceKind:'web',product:product||'未知',version:version||'未知',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    status:'ready',queue:[],pages:{},discoveryWarnings:[],scanDiagnostics:{}};
}
export class ImportEngine {
  constructor(task,io){this.task=task;this.io=io;this.paused=false;this.running=false;}
  pause(){this.paused=true;}
  async checkpoint(key=null){this.task.updatedAt=new Date().toISOString();await this.io.save(this.task,key);
    // A rendering problem in the control page must never abort a running import:
    // the captured page is already stored by the time the refresh is attempted.
    try{this.io.onChange?.(this.task);}catch(error){console.warn('ManualDock：控制页刷新失败，采集继续。',error);}}
  merge(items=[]){
    const known=new Set(this.task.queue.map(c=>c.key));
    for(const raw of items){const chapter=cleanChapter(raw,this.task.profile);if(!chapter||known.has(chapter.key))continue;
      if(this.task.queue.length>=5000){this.task.discoveryWarnings.push('目录超过5000章上限，尚未加入剩余章节');break;}
      known.add(chapter.key);this.task.queue.push({...chapter,status:'pending'});
    }
  }
  async scan(){
    const result=await this.io.discover(this.task.profile);
    if(result.status==='auth'){this.task.status='waiting_login';this.task.recovery={...classifyRecoveryError(result),message:'登录已失效，等待用户登录后恢复'};await this.checkpoint();return false;}
    if(result.status==='error'||result.diagnostics?.reason==='invalid-directory')throw Object.assign(new Error(result.error||result.warnings?.[0]||'目录规则已失效，请重新校准'),{code:result.code});
    this.merge(result.items||[]);this.task.scanDiagnostics=result.diagnostics||{};
    this.task.discoveryWarnings=[...new Set([...this.task.discoveryWarnings,...(result.warnings||[])])];
    if(!this.task.queue.length)throw new Error('未识别到章节；请点选目录和正文，并验证两个示例章节');
    await this.checkpoint();return true;
  }
  async run(){
    if(this.running)return;this.running=true;this.paused=false;
    try{
      for(const c of this.task.queue)if(['processing','waiting_login'].includes(c.status))c.status='pending';
      delete this.task.recovery;this.task.status='running';await this.checkpoint();if(!await this.scan())return;
      let failures=0;
      while(!this.paused){
        const chapter=this.task.queue.find(c=>c.status==='pending');if(!chapter)break;
        chapter.status='processing';delete chapter.error;delete chapter.recovery;await this.checkpoint();
        let page;try{page=await this.io.capture(chapter,this.task.profile);}catch(error){page={status:'error',error:error.message,code:error.code};}
        if(page.status==='auth'){chapter.status='waiting_login';chapter.recovery=classifyRecoveryError(page);this.task.status='waiting_login';this.task.recovery={...chapter.recovery,message:'登录已失效，等待用户登录后恢复'};await this.checkpoint();return;}
        const hasBody=Boolean(page.text?.trim())||(Number.isInteger(page.diagnostics?.images?.embedded)&&page.diagnostics.images.embedded>0&&/<img\b[^>]*src=["']data:image\//i.test(page.html||''));
        if(page.status!=='ok'||!hasBody||page.navigationProof?.verified!==true){
          chapter.status='failed';chapter.error=page.error||page.diagnostics?.reason||'未确认所选章节的正文加载完成';
          chapter.recovery=classifyRecoveryError({...page,error:chapter.error});this.task.recovery={...chapter.recovery,message:chapter.error};
          await this.checkpoint();if(++failures>=3){this.paused=true;this.task.discoveryWarnings.push('连续三章失败，已暂停；可恢复的连接错误将按自动恢复设置重试，其他错误需要检查规则');}continue;
        }
        failures=0;
        // Hashing, duplicate detection and storing were outside every try/catch,
        // so one failure there ended the whole manual. Keep already saved pages
        // and record a failed chapter instead.
        try{
        const hash=await contentHash(page.text?.trim()?page.text:page.html);
        const duplicate=Object.entries(this.task.pages).find(([key,p])=>key!==chapter.key&&p.hash===hash);
        chapter.status=duplicate?'review':'captured';
        if(duplicate)chapter.error='正文与其他章节相同，已保留，待核对';
        this.task.pages[chapter.key]={...page,key:chapter.key,hash,capturedAt:new Date().toISOString()};
        await this.checkpoint(chapter.key);
        }catch(error){
          console.error('ManualDock：章节保存失败',chapter.key,error);
          chapter.status='failed';chapter.error=error?.message||'章节保存失败';
          chapter.recovery=classifyRecoveryError(error);this.task.recovery={...chapter.recovery,message:chapter.error};
          try{await this.checkpoint();}catch(saveError){console.warn('ManualDock：记录失败章节未完成存档。',saveError);}
          if(++failures>=3){this.paused=true;this.task.discoveryWarnings.push('连续三章失败，已暂停；可恢复的连接错误将按自动恢复设置重试，其他错误需要检查规则');}
          continue;
        }
      }
      this.task.status=this.paused?'paused':'finished';await this.checkpoint();
    }catch(error){console.error('ManualDock：采集中断',error);this.task.status='paused';this.task.recovery={...classifyRecoveryError(error),message:error.message,stack:String(error?.stack||'').slice(0,4000)};await this.checkpoint();throw error;}
    finally{this.running=false;}
  }
}

const DB='security-manual-importer-v1';
async function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>{
 r.result.createObjectStore('tasks',{keyPath:'taskId'});r.result.createObjectStore('pages',{keyPath:['taskId','key']});
 r.result.createObjectStore('profiles',{keyPath:'id'});r.result.createObjectStore('settings');
};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function transaction(stores,mode,work){const db=await openDB();try{return await new Promise((resolve,reject)=>{
 const t=db.transaction(stores,mode);const value=work(t);t.oncomplete=()=>resolve(typeof value==='function'?value():value);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||new Error('保存中断'));
});}finally{db.close();}}
export function saveTask(task,pageKey=null){return transaction(['tasks','pages'],'readwrite',t=>{const {pages,...metadata}=task;t.objectStore('tasks').put(metadata);
 if(pageKey&&pages[pageKey])t.objectStore('pages').put({taskId:task.taskId,key:pageKey,page:pages[pageKey]});
});}
export function saveWholeTask(task){return transaction(['tasks','pages'],'readwrite',t=>{const {pages,...metadata}=task;t.objectStore('tasks').put(metadata);for(const [key,page]of Object.entries(pages))t.objectStore('pages').put({taskId:task.taskId,key,page});});}
export function loadTask(taskId){return transaction(['tasks','pages'],'readonly',t=>{const r=t.objectStore('tasks').get(taskId),p=t.objectStore('pages').getAll(IDBKeyRange.bound([taskId,''],[taskId,'\uffff']));return()=>r.result?{...r.result,pages:Object.fromEntries(p.result.map(x=>[x.key,x.page]))}:null;});}
export function listTasks(){return transaction(['tasks'],'readonly',t=>{const r=t.objectStore('tasks').getAll();return()=>r.result;});}
export function saveProfile(profile){return transaction(['profiles'],'readwrite',t=>t.objectStore('profiles').put(profile));}
export function loadProfiles(){return transaction(['profiles'],'readonly',t=>{const r=t.objectStore('profiles').getAll();return()=>r.result;});}
export function setSetting(key,value){return transaction(['settings'],'readwrite',t=>t.objectStore('settings').put(value,key));}
export function getSetting(key){return transaction(['settings'],'readonly',t=>{const r=t.objectStore('settings').get(key);return()=>r.result;});}
export function listSettings(){return transaction(['settings'],'readonly',t=>{const r=t.objectStore('settings').getAllKeys();return()=>r.result;});}
export function deleteSetting(key){return transaction(['settings'],'readwrite',t=>t.objectStore('settings').delete(key));}
/** Removes a task and every page saved under it. Saved recognition rules stay. */
export function deleteTask(taskId){return transaction(['tasks','pages'],'readwrite',t=>{
 t.objectStore('tasks').delete(taskId);
 const cursor=t.objectStore('pages').openKeyCursor(IDBKeyRange.bound([taskId,''],[taskId,'\uffff']));
 cursor.onsuccess=event=>{const c=event.target.result;if(!c)return;t.objectStore('pages').delete(c.primaryKey);c.continue();};
});}

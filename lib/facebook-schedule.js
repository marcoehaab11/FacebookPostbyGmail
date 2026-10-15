import { imageBuffer } from './images.js';
import { cairoTime } from './scheduler.js';

const waiting=['facebook_scheduled','facebook_schedule_uncertain'];
async function graph(s,path,{method='GET',body}={},request=fetch){
  const r=await request(`https://graph.facebook.com/${s.apiVersion}/${path}`,{method,headers:{Authorization:'Bearer '+s.facebookToken},...(body?{body}:{}),signal:AbortSignal.timeout(method==='GET'?10000:90000),redirect:'error'});
  const data=await r.json();
  if(!r.ok || data.error){const e=new Error('Facebook رفض الطلب (كود '+(data.error?.code || r.status)+'). راجع الربط وصلاحيات الصفحة والموعد.');e.definite=r.status>=400 && r.status<500 && !!data.error;throw e;}
  return data;
}
async function context(store,id){
  const s=await store.settings(),p=await store.db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  if(!p)throw new Error('البوست غير موجود.');
  if(!/^\d+$/.test(s.pageId) || !s.facebookToken)throw new Error('أكمل ربط Facebook أولًا.');
  return {s,p};
}

export async function scheduleOnFacebook(store,id,localTime,request=fetch,now=Date.now()){
  const at=cairoTime(localTime),seconds=Math.floor(Date.parse(at)/1000),{s,p}=await context(store,id);
  // A conservative app window. Facebook remains the authority on acceptance.
  if(Date.parse(at)<now+11*60000 || Date.parse(at)>now+28*86400000)throw new Error('اختار موعدًا بعد ١١ دقيقة على الأقل وخلال ٢٨ يومًا.');
  if(!['pending','failed','missed','scheduled'].includes(p.status) || !p.image || p.issue || !p.caption.trim())throw new Error('راجع البوست والصورة قبل الجدولة.');
  const bytes=await imageBuffer(store.directory,p.image);
  const claim=await store.db.prepare("UPDATE posts SET status='facebook_scheduling',page_id=?,scheduled_at=?,photo_id=NULL,facebook_post_id=NULL,updated_at=? WHERE id=? AND status=? AND updated_at=?").run(s.pageId,at,new Date().toISOString(),id,p.status,p.updated_at);
  if(!claim.changes)throw new Error('البوست اتغير. أعد فتحه للمراجعة.');
  let feedDispatched=false,postId=null;
  try{
    const png=p.image.endsWith('.png'),upload=new FormData();upload.set('published','false');upload.set('source',new Blob([bytes],{type:png?'image/png':'image/jpeg'}),png?'nuvexa.png':'nuvexa.jpg');
    const photo=await graph(s,s.pageId+'/photos',{method:'POST',body:upload},request);
    if(!/^\d+$/.test(String(photo.id || '')))throw new Error('لم يرجع Facebook رقم الصورة.');
    await store.db.prepare('UPDATE posts SET photo_id=?,updated_at=? WHERE id=?').run(String(photo.id),new Date().toISOString(),id);
    // The feed post (not just an unpublished photo) is what Facebook schedules.
    const form=new URLSearchParams({message:p.caption,published:'false',unpublished_content_type:'SCHEDULED',scheduled_publish_time:String(seconds),attached_media:JSON.stringify([{media_fbid:String(photo.id)}])});
    feedDispatched=true;
    const created=await graph(s,s.pageId+'/feed',{method:'POST',body:form},request);
    if(!/^[\d_]+$/.test(String(created.id || '')))throw new Error('لم يرجع Facebook رقم البوست.');
    postId=String(created.id);
    await store.db.prepare("UPDATE posts SET facebook_post_id=?,status='facebook_schedule_uncertain',updated_at=? WHERE id=?").run(postId,new Date().toISOString(),id);
    const remote=await graph(s,postId+'?fields=id,is_published,scheduled_publish_time',{},request);
    if(remote.is_published!==false || Number(remote.scheduled_publish_time)!==seconds)throw new Error('لم يتم تأكيد الموعد.');
    await store.db.prepare("UPDATE posts SET status='facebook_scheduled',issue=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),id);
    await store.event(id,'facebook_scheduled','تم تأكيد جدولة البوست على Facebook نفسه: '+localTime.replace('T',' '));
    return {status:'facebook_scheduled',scheduled_at:at,facebook_post_id:postId};
  }catch(e){
    // Only a definite feed rejection, or a failure before sending feed, is safe
    // to retry. A known post ID always stays held, even if read-back fails.
    const uncertain=!!postId || (feedDispatched && !e.definite);
    const status=uncertain?'facebook_schedule_uncertain':'failed';
    const message=uncertain?'نتيجة الجدولة غير مؤكدة. راجع مخطط Meta قبل إنشاء أي نسخة جديدة.':e.definite?e.message:'تعذر رفع الصورة لجدولة البوست. حاول مرة أخرى.';
    await store.db.prepare('UPDATE posts SET status=?,issue=?,updated_at=? WHERE id=?').run(status,uncertain?message:null,new Date().toISOString(),id);
    await store.event(id,'facebook_schedule_error',message);
    return {status,message};
  }
}

export async function checkFacebookSchedule(store,id,request=fetch){
  const {s,p}=await context(store,id);
  if(!waiting.includes(p.status) || !p.facebook_post_id)throw new Error('راجع مخطط Meta يدويًا؛ رقم البوست غير متاح أو حالته اتغيرت.');
  if(p.page_id!==s.pageId)throw new Error('اربط صفحة البوست الأصلية قبل التحقق أو الإلغاء.');
  const remote=await graph(s,p.facebook_post_id+'?fields=id,is_published,scheduled_publish_time',{},request);
  if(remote.is_published===true){
    await store.db.prepare("UPDATE posts SET status='published',issue=NULL,updated_at=? WHERE id=? AND status=?").run(new Date().toISOString(),id,p.status);
    await store.event(id,'facebook_published','تم التأكد أن Facebook نشر البوست.');return {status:'published'};
  }
  if(remote.is_published!==false || !Number.isFinite(Number(remote.scheduled_publish_time)) || Number(remote.scheduled_publish_time)<=0)throw new Error('البوست ليس مجدولًا حاليًا. راجع Meta ولا تعِد النشر قبل التأكد.');
  const at=new Date(Number(remote.scheduled_publish_time)*1000).toISOString();
  await store.db.prepare("UPDATE posts SET status='facebook_scheduled',scheduled_at=?,issue=NULL,updated_at=? WHERE id=? AND status=?").run(at,new Date().toISOString(),id,p.status);
  return {status:'facebook_scheduled',scheduled_at:at};
}

export async function cancelFacebookSchedule(store,id,request=fetch){
  const {s,p}=await context(store,id);
  if(!['facebook_scheduled','facebook_schedule_uncertain'].includes(p.status) || !p.facebook_post_id)throw new Error('راجع مخطط Meta لإلغاء البوست.');
  if(p.page_id!==s.pageId)throw new Error('اربط صفحة البوست الأصلية قبل الإلغاء.');
  const claim=await store.db.prepare("UPDATE posts SET status='facebook_cancelling',updated_at=? WHERE id=? AND status=? AND updated_at=?").run(new Date().toISOString(),id,p.status,p.updated_at);
  if(!claim.changes)throw new Error('حالة البوست اتغيرت. حدّث الصفحة.');
  let dispatched=false;
  try{
    const remote=await graph(s,p.facebook_post_id+'?fields=id,is_published,scheduled_publish_time',{},request);
    if(remote.is_published===true){await store.db.prepare("UPDATE posts SET status='published',issue=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),id);return {status:'published',message:'البوست اتنشر بالفعل. لم يتم حذفه من Facebook.'};}
    if(remote.is_published!==false || Number(remote.scheduled_publish_time)*1000<Date.now()+60000)throw new Error('الموعد قريب جدًا أو الجدولة غير مؤكدة. راجع Meta لإلغائها.');
    dispatched=true;
    const result=await graph(s,p.facebook_post_id,{method:'DELETE'},request);
    if(result!==true && result.success!==true)throw new Error('لم يتم تأكيد الإلغاء.');
    await store.db.prepare("UPDATE posts SET status='pending',scheduled_at=NULL,facebook_post_id=NULL,photo_id=NULL,issue=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),id);
    await store.event(id,'facebook_schedule_cancelled','تم إلغاء وحذف البوست المجدول من Facebook وإعادته للمراجعة.');
    return {status:'pending'};
  }catch(e){
    const uncertain=dispatched && !e.definite;
    const status=uncertain?'facebook_schedule_uncertain':p.status;
    const message=uncertain?'نتيجة الإلغاء غير مؤكدة. راجع مخطط Meta قبل إعادة الجدولة.':e.message;
    await store.db.prepare('UPDATE posts SET status=?,issue=?,updated_at=? WHERE id=?').run(status,uncertain?message:p.issue,new Date().toISOString(),id);
    if(uncertain){await store.event(id,'facebook_cancel_uncertain',message);return {status,message};}
    throw new Error(message);
  }
}

export async function refreshFacebookSchedules(store,request=fetch){
  const rows=await store.db.prepare("SELECT id FROM posts WHERE status='facebook_scheduled' AND scheduled_at<=? AND updated_at<? ORDER BY updated_at LIMIT 3").all(new Date().toISOString(),new Date(Date.now()-60000).toISOString());
  for(const {id} of rows)try{await checkFacebookSchedule(store,id,request);}catch{/* Never recreate a remote post after a failed read. */}
}

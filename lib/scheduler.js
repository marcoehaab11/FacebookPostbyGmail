import { publishPost } from './publisher.js';

export function cairoTime(value) {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || ''))throw new Error('اختر تاريخ ووقت صحيحين بتوقيت القاهرة.');
  const naive=Date.parse(value+'Z'), matches=[];
  const fmt=new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  for(let offset=-840;offset<=840;offset+=15){const ms=naive-offset*60000;if(Number.isFinite(ms) && fmt.format(ms).replace(' ','T')===value)matches.push(ms);}
  if(matches.length!==1)throw new Error('الموعد غير صالح أو متكرر بسبب تغيير الساعة. اختر وقتًا آخر.');
  return new Date(matches[0]).toISOString();
}

export function schedulePost(store,id,localTime,now=Date.now()) {
  const at=cairoTime(localTime),s=store.settings();
  if(Date.parse(at)<now+60000)throw new Error('اختر موعدًا بعد دقيقة على الأقل.');
  if(!/^\d+$/.test(s.pageId) || !s.facebookToken)throw new Error('أكمل ربط Facebook أولًا.');
  const p=store.db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  if(!p || !['pending','failed','missed'].includes(p.status) || !p.image || p.issue || !p.caption.trim())throw new Error('راجع البوست وأصلح الصورة والكلام قبل الجدولة.');
  store.db.prepare("UPDATE posts SET status='scheduled',scheduled_at=?,page_id=?,updated_at=? WHERE id=?").run(at,s.pageId,new Date().toISOString(),id);
  store.event(id,'scheduled','تمت الموافقة والجدولة بتوقيت القاهرة: '+localTime.replace('T',' '));
  return {scheduled_at:at,status:'scheduled'};
}

export async function processDue(store,request=fetch,now=Date.now()) {
  const due=store.db.prepare("SELECT * FROM posts WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at").all(new Date(now).toISOString());
  for(const p of due){
    if(now-Date.parse(p.scheduled_at)>90000){
      store.db.prepare("UPDATE posts SET status='missed',updated_at=? WHERE id=? AND status='scheduled'").run(new Date().toISOString(),p.id);
      store.event(p.id,'schedule_missed','فات موعد النشر. راجع البوست واختر موعدًا جديدًا.');continue;
    }
    try{await publishPost(store,p.id,request,{scheduled:true});}
    catch(e){
      const r=store.db.prepare("UPDATE posts SET status='failed',updated_at=? WHERE id=? AND status='scheduled'").run(new Date().toISOString(),p.id);
      if(r.changes)store.event(p.id,'schedule_failed',e.message);
    }
  }
}

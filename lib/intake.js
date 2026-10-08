import { randomUUID } from 'node:crypto';
import { downloadImage, saveImage } from './images.js';

export function parsePayload(body) {
  if(typeof body==='object' && body!==null) return validatePayload(body);
  const text=String(body || '').trim();
  const fenced=text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let payload;
  const raw=fenced ? fenced[1] : text.slice(text.indexOf('{'),text.lastIndexOf('}')+1);
  try {payload=JSON.parse(raw);}catch{
    // Gmail's generated text can fold long HTML strings onto physical lines.
    // Repair only literal control characters inside strings, not JSON structure.
    let repaired='',quoted=false,escaped=false;
    for(const ch of raw){
      if(quoted && (ch==='\n' || ch==='\r' || ch==='\t')){repaired+=' ';escaped=false;continue;}
      repaired+=ch;
      if(escaped){escaped=false;continue;}
      if(quoted && ch==='\\'){escaped=true;continue;}
      if(ch==='"')quoted=!quoted;
    }
    try{payload=JSON.parse(repaired);}catch{throw new Error('محتوى الإيميل ليس JSON صالحًا.');}
  }
  return validatePayload(payload);
}
function validatePayload(p) {
  p={...p,posts:Array.isArray(p.posts)?p.posts.map(post=>post && typeof post==='object'?{...post}:post):p.posts};
  if(p.brand!=='NUVEXA PROPERTIES')throw new Error('اسم البراند يجب أن يكون NUVEXA PROPERTIES.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '') || !Number.isFinite(Date.parse(p.date)) || new Date(p.date).toISOString().slice(0,10)!==p.date)throw new Error('تاريخ غير صالح.');
  if(!Array.isArray(p.posts) || !p.posts.length || p.posts.length>50)throw new Error('الإيميل يجب أن يحتوي على 1 إلى 50 بوست.');
  const ids=new Set();
  for(const post of p.posts) {
    if(!post || typeof post!=='object')throw new Error('بيانات بوست غير صالحة.');
    post.post_id ??= post.post_number;
    post.caption ??= post.full_caption || [post.caption_ar,post.caption_en,Array.isArray(post.hashtags)?post.hashtags.join(' '):post.hashtags].filter(Boolean).join('\n\n');
    post.image_url ??= post.direct_download_url || post.drive_view_url || (post.drive_file_id ? 'https://drive.google.com/uc?export=download&id='+encodeURIComponent(post.drive_file_id):'');
    if(typeof post.image_url==='string')post.image_url=post.image_url.trim();
    const id=String(post.post_id ?? '');
    if(!/^[\w-]{1,100}$/.test(id) || ids.has(id))throw new Error('رقم بوست مكرر أو غير صالح.');ids.add(id);
    if(typeof post.caption!=='string' || !post.caption.trim() || post.caption.length>60000)throw new Error('الكابشن فارغ أو طويل جدًا.');
    if(post.image_url && typeof post.image_url!=='string')throw new Error('رابط الصورة غير صالح.');
  }
  return p;
}
export async function ingest(store,payload,attachments=[],source='manual',loader=downloadImage) {
  payload=parsePayload(payload);
  const summary={added:0,duplicates:0,issues:0};
  for(const post of payload.posts) {
    const dedup=JSON.stringify([payload.brand,payload.date,String(post.post_id)]);
    const existing=store.db.prepare('SELECT id,status,image FROM posts WHERE dedup_key=?').get(dedup);
    if(existing && (existing.image || existing.status!=='pending' || !post.image_url)){summary.duplicates++;continue;}
    let image=null,issue=null;
    try {
      let buffer;
      if(post.image_url?.trim())buffer=await loader(post.image_url.trim());
      else {
        const images=attachments.filter(a=>/^image\//.test(a.contentType || a.mimetype || ''));
        const matching=images.filter(a=>[String(post.post_id),'post_'+post.post_id].includes(String(a.filename || a.originalname || '').replace(/\.[^.]+$/,'')));
        const file=matching.length===1 ? matching[0] : payload.posts.length===1 && images.length===1 ? images[0] : null;
        if(!file)throw new Error('أضف صورة أو مرفقًا باسم post_'+post.post_id+'.jpg.');
        buffer=file.content || file.buffer;
      }
      image=await saveImage(buffer,store.directory);
    } catch(e){issue=e.message;summary.issues++;}
    if(existing){
      if(image){store.db.prepare("UPDATE posts SET image=?,issue=NULL,updated_at=? WHERE id=? AND status='pending' AND image IS NULL").run(image,new Date().toISOString(),existing.id);store.event(existing.id,'image_repaired','تم استكمال صورة البوست من إيميل محدث.');}
      summary.duplicates++;continue;
    }
    const id=randomUUID(),now=new Date().toISOString();
    const inserted=store.db.prepare(`INSERT OR IGNORE INTO posts(id,dedup_key,source_id,source_post_id,brand,date,theme,caption,image,status,issue,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)`).run(id,dedup,source,String(post.post_id),payload.brand,payload.date,String(post.theme || '').slice(0,200),post.caption,image,issue,now,now);
    if(inserted.changes){summary.added++;store.event(id,'received',issue || 'تم استلام البوست للفحص والمراجعة.');}else summary.duplicates++;
  }
  return summary;
}

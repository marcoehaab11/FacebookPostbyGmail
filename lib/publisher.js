import { imageBuffer } from './images.js';

export async function publishPost(store,id,request=fetch,{scheduled=false}={}) {
  const s=store.settings();
  if(!/^\d+$/.test(s.pageId) || !s.facebookToken)throw new Error('احفظ Page ID وتوكن Facebook في الإعدادات أولًا.');
  const post=store.db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  if(!post)throw new Error('البوست غير موجود.');
  if(!(scheduled?['scheduled']:['pending','failed','missed']).includes(post.status))throw new Error('حالة البوست لا تسمح بالنشر.');
  if(!post.image || !post.caption.trim() || post.issue)throw new Error('أصلح مشاكل الصورة أو الكلام قبل النشر.');
  if(scheduled && post.page_id!==s.pageId)throw new Error('صفحة النشر اتغيرت بعد الجدولة. راجع البوست.');
  const bytes=await imageBuffer(store.directory,post.image);
  const claimed=store.db.prepare("UPDATE posts SET status='publishing',page_id=?,updated_at=? WHERE id=? AND updated_at=? AND status=?").run(s.pageId,new Date().toISOString(),id,post.updated_at,post.status);
  if(!claimed.changes)throw new Error('البوست قيد النشر بالفعل.');
  store.event(id,'approved','تمت الموافقة اليدوية وبدء النشر.');
  const png=post.image.endsWith('.png');
  const form=new FormData();form.set('caption',post.caption);form.set('published','true');form.set('source',new Blob([bytes],{type:png?'image/png':'image/jpeg'}),png?'nuvexa.png':'nuvexa.jpg');
  let response;
  try {
    response=await request(`https://graph.facebook.com/${s.apiVersion}/${s.pageId}/photos`,{method:'POST',headers:{Authorization:'Bearer '+s.facebookToken},body:form,signal:AbortSignal.timeout(90000),redirect:'error'});
    const data=await response.json();
    if(!response.ok || data.error) {
      // Only an explicit Graph 4xx error is a safe, definite failure.
      if(response.status>=400 && response.status<500 && data.error) {
        const message='Facebook رفض النشر (كود '+(data.error.code || response.status)+'). راجع التوكن وصلاحيات الصفحة.';
        store.db.prepare("UPDATE posts SET status='failed',issue=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),id);
        store.event(id,'publish_failed',message);
        return {status:'failed',message};
      }
      throw new Error('Ambiguous Graph response');
    }
    if(!data.id)throw new Error('No photo id');
    store.db.prepare("UPDATE posts SET status='published',photo_id=?,facebook_post_id=?,issue=NULL,updated_at=? WHERE id=?").run(String(data.id),data.post_id ? String(data.post_id) : null,new Date().toISOString(),id);
    store.event(id,'published','تم النشر على Facebook. الصورة: '+data.id);
    return {status:'published',photo_id:String(data.id),facebook_post_id:data.post_id ? String(data.post_id) : null};
  } catch {
    const message='نتيجة النشر غير مؤكدة. راجع صفحة Facebook وسجّل النتيجة قبل إعادة المحاولة.';
    store.db.prepare("UPDATE posts SET status='uncertain',issue=?,updated_at=? WHERE id=?").run(message,new Date().toISOString(),id);
    store.event(id,'uncertain',message);
    return {status:'uncertain',message};
  }
}

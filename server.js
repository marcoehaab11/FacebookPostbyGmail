import express from 'express';
import multer from 'multer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { createStore } from './lib/store.js';
import { ingest } from './lib/intake.js';
import { downloadImage,saveImage,MAX_IMAGE } from './lib/images.js';
import { gmailService } from './lib/gmail.js';
import { schedulePost,processDue } from './lib/scheduler.js';
import { publishPost } from './lib/publisher.js';

const root=dirname(fileURLToPath(import.meta.url));
export function createApp({directory=join(root,'data'),port=3210,request=fetch}={}) {
  const app=express(),store=createStore(directory),baseUrl=`http://127.0.0.1:${port}`,gmail=gmailService(store,baseUrl);
  mkdirSync(join(directory,'images'),{recursive:true});
  const csrf=randomBytes(32).toString('hex');let oauthState=null;
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_IMAGE,files:10,fieldSize:512*1024}});
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return res.status(403).json({error:'عنوان محلي غير صالح.'});
    res.set({'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store'});
    if(req.path.startsWith('/api') && !['GET','HEAD'].includes(req.method)){
      const value=String(req.headers['x-csrf-token'] || '');
      if(![baseUrl,`http://localhost:${port}`].includes(req.headers.origin) || value.length!==csrf.length || !timingSafeEqual(Buffer.from(value),Buffer.from(csrf)))return res.status(403).json({error:'أعد تحميل الصفحة ثم حاول مرة أخرى.'});
    }
    next();
  });
  app.use(express.json({limit:'512kb'}));
  const safeSettings=()=>{const s=store.settings();return {mailbox:s.mailbox,allowedSender:s.allowedSender,pageId:s.pageId,apiVersion:s.apiVersion,clientId:s.clientId,autoSync:s.autoSync,hasClientSecret:!!s.clientSecret,hasFacebookToken:!!s.facebookToken,connectedEmail:s.connectedEmail || null,redirectUri:baseUrl+'/auth/google/callback'};};
  app.get('/api/bootstrap',(req,res)=>res.json({csrf,settings:safeSettings(),sync:gmail.state()}));
  app.get('/api/posts',(req,res)=>res.json(store.db.prepare("SELECT * FROM posts WHERE status!='deleted' ORDER BY created_at DESC").all()));
  app.get('/api/events',(req,res)=>res.json({events:store.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all(),emails:store.db.prepare('SELECT * FROM emails ORDER BY created_at DESC LIMIT 30').all()}));
  app.post('/api/settings',(req,res)=>{
    const b=req.body,s=store.settings();
    if(b.pageId && !/^\d+$/.test(b.pageId))throw new Error('Page ID يجب أن يكون أرقامًا.');
    if(!/^v\d+\.0$/.test(b.apiVersion || ''))throw new Error('نسخة API غير صالحة.');
    if(b.allowedSender && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.allowedSender))throw new Error('عنوان المُرسل غير صالح.');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.mailbox || ''))throw new Error('عنوان Gmail غير صالح.');
    const updated={...s,mailbox:b.mailbox,allowedSender:b.allowedSender.trim().toLowerCase(),pageId:b.pageId,apiVersion:b.apiVersion,clientId:String(b.clientId || '').trim(),autoSync:!!b.autoSync};
    if(b.clientSecret)updated.clientSecret=String(b.clientSecret).trim();if(b.facebookToken)updated.facebookToken=String(b.facebookToken).trim();
    if(updated.clientId!==s.clientId || updated.mailbox!==s.mailbox || (b.clientSecret && updated.clientSecret!==s.clientSecret)){delete updated.googleTokens;delete updated.connectedEmail;}
    store.saveSettings(updated);res.json(safeSettings());
  });
  app.post('/api/google/connect',(req,res)=>{oauthState={value:randomBytes(32).toString('hex'),expires:Date.now()+600000};res.json({url:gmail.authUrl(oauthState.value)});});
  app.get('/auth/google/callback',async(req,res)=>{
    const state=oauthState;oauthState=null;
    if(!state || state.expires<Date.now() || req.query.state!==state.value)return res.status(400).send('OAuth state invalid. Start again from Settings.');
    try {if(!req.query.code)throw new Error('No code');await gmail.connect(String(req.query.code));res.redirect('/?gmail=connected');}
    catch{res.redirect('/?gmail=failed');}
  });
  app.post('/api/google/disconnect',(req,res)=>{const s=store.settings();delete s.googleTokens;delete s.connectedEmail;store.saveSettings(s);res.json({ok:true});});
  app.post('/api/sync',async(req,res)=>res.json(await gmail.sync({retryInvalid:true})));
  app.post('/api/import',upload.array('images',10),async(req,res)=>res.json(await ingest(store,req.body.payload,req.files)));
  app.patch('/api/posts/:id',upload.single('image'),async(req,res)=>{
    const p=store.db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
    if(!p || !['pending','failed','rejected','missed'].includes(p.status))throw new Error('لا يمكن تعديل هذا البوست.');
    const caption=String(req.body.caption ?? p.caption);if(!caption.trim() || caption.length>60000)throw new Error('الكابشن فارغ أو طويل جدًا.');
    let image=p.image,issue=p.issue;
    if(req.file){image=await saveImage(req.file.buffer,directory);issue=null;}
    else if(req.body.imageUrl?.trim()){image=await saveImage(await downloadImage(req.body.imageUrl.trim()),directory);issue=null;}
    const updated=store.db.prepare("UPDATE posts SET caption=?,image=?,issue=?,status='pending',updated_at=? WHERE id=? AND updated_at=? AND status IN ('pending','failed','rejected','missed')").run(caption,image,issue,new Date().toISOString(),p.id,p.updated_at);
    if(!updated.changes)throw new Error('حالة البوست اتغيرت. أعد فتحه للمراجعة.');
    store.event(p.id,'edited','تم حفظ التعديلات وإعادته للمراجعة.');res.json({ok:true});
  });
  app.delete('/api/posts/:id',(req,res)=>{
    const r=store.db.prepare("UPDATE posts SET status='deleted',scheduled_at=NULL,updated_at=? WHERE id=? AND status NOT IN ('publishing','deleted')").run(new Date().toISOString(),req.params.id);
    if(!r.changes)throw new Error('لا يمكن حذف البوست أثناء النشر أو بعد حذفه.');
    store.event(req.params.id,'deleted','تم حذف البوست من البرنامج وإلغاء أي جدولة. نسخة Facebook إن وجدت تظل على الصفحة.');
    res.json({ok:true});
  });
  app.post('/api/posts/:id/reject',(req,res)=>{
    const r=store.db.prepare("UPDATE posts SET status='rejected',updated_at=? WHERE id=? AND status IN ('pending','failed')").run(new Date().toISOString(),req.params.id);
    if(!r.changes)throw new Error('لا يمكن رفض هذا البوست الآن.');store.event(req.params.id,'rejected','تم رفض البوست.');res.json({ok:true});
  });
  app.post('/api/posts/:id/schedule',(req,res)=>{
    if(req.body.approved!==true)throw new Error('الموافقة اليدوية مطلوبة.');
    res.json(schedulePost(store,req.params.id,req.body.localTime));
  });
  app.post('/api/posts/:id/cancel-schedule',(req,res)=>{
    const r=store.db.prepare("UPDATE posts SET status='pending',scheduled_at=NULL,updated_at=? WHERE id=? AND status='scheduled'").run(new Date().toISOString(),req.params.id);
    if(!r.changes)throw new Error('الجدولة اتنفذت أو اتلغت بالفعل.');
    store.event(req.params.id,'schedule_cancelled','تم إلغاء الجدولة وإعادة البوست للمراجعة.');res.json({ok:true});
  });
  app.post('/api/posts/:id/publish',async(req,res)=>{
    if(req.body.approved!==true)throw new Error('الموافقة اليدوية مطلوبة.');
    res.json(await publishPost(store,req.params.id,request));
  });
  app.post('/api/posts/:id/reconcile',(req,res)=>{
    const p=store.db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
    if(p?.status!=='uncertain' || req.body.checked!==true)throw new Error('راجع صفحة Facebook أولًا.');
    if(req.body.result==='published') {
      if(!/^[\d_]+$/.test(req.body.photoId || ''))throw new Error('أدخل رقم الصورة الذي ظهر في Facebook.');
      store.db.prepare("UPDATE posts SET status='published',photo_id=?,issue=NULL,updated_at=? WHERE id=? AND status='uncertain'").run(req.body.photoId,new Date().toISOString(),p.id);
    }else if(req.body.result==='not_published')store.db.prepare("UPDATE posts SET status='pending',issue=NULL,updated_at=? WHERE id=? AND status='uncertain'").run(new Date().toISOString(),p.id);
    else throw new Error('اختر نتيجة المراجعة.');
    store.event(p.id,'reconciled','تم تسجيل نتيجة مراجعة Facebook يدويًا.');res.json({ok:true});
  });
  app.use('/images',express.static(join(directory,'images'),{dotfiles:'deny'}));
  app.use(express.static(join(root,'public')));
  app.use((error,req,res,next)=>{
    const message=error.code==='LIMIT_FILE_SIZE' ? 'الصورة أكبر من 8 ميجابايت.' : error.message || 'حدث خطأ.';
    res.status(400).json({error:message});
  });
  let scheduling=false;
  const scheduleTimer=setInterval(async()=>{if(scheduling)return;scheduling=true;try{await processDue(store,request);}finally{scheduling=false;}},5000);scheduleTimer.unref();
  const timer=setInterval(()=>{const s=store.settings();if(s.autoSync && s.googleTokens && s.allowedSender)gmail.sync().catch(()=>{});},60000);timer.unref();
  return {app,store,gmail,close:()=>{clearInterval(timer);clearInterval(scheduleTimer);store.db.close();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT || 3210);const studio=createApp({port});
  studio.app.listen(port,'127.0.0.1',()=>console.log(`NUVEXA Studio ready: http://127.0.0.1:${port}`));
}

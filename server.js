import express from 'express';
import multer from 'multer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync,readFileSync } from 'node:fs';
import { authSystem } from './lib/auth.js';
import { createStore } from './lib/store.js';
import { ingest } from './lib/intake.js';
import { downloadImage,saveImage,imageBuffer,MAX_IMAGE } from './lib/images.js';
import { gmailService } from './lib/gmail.js';
import { processDue } from './lib/scheduler.js';
import { scheduleOnFacebook,cancelFacebookSchedule,checkFacebookSchedule,refreshFacebookSchedules } from './lib/facebook-schedule.js';
import { publishPost } from './lib/publisher.js';

const root=dirname(fileURLToPath(import.meta.url));
export function createApp({directory=join(root,'data'),port=3210,request=fetch,providedStore,appUrl,auth=true,authConfig,cronSecret=process.env.CRON_SECRET,backgroundJobs=true}={}) {
  const app=express(),store=providedStore || createStore(directory),baseUrl=(appUrl || `http://127.0.0.1:${port}`).replace(/\/$/,''),gmail=gmailService(store,baseUrl);
  const cloud=!!store.cloud;directory=store.directory;
  if(!cloud)mkdirSync(join(directory,'images'),{recursive:true});
  const login=auth?authSystem({store,baseUrl,config:authConfig || JSON.parse(readFileSync(join(directory,'admin.json'),'utf8'))}):null;
  const csrf=randomBytes(32).toString('hex');
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:cloud?3*1024*1024:MAX_IMAGE,files:10,fieldSize:512*1024}});
  app.disable('x-powered-by');
  app.use(async(req,res,next)=>{
    if(!(cloud?[new URL(baseUrl).host]:[`127.0.0.1:${port}`,`localhost:${port}`]).includes(req.headers.host))return res.status(403).json({error:'عنوان الموقع غير صالح.'});
    res.set({'Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store'});
    if(cloud)res.set('Strict-Transport-Security','max-age=31536000');
    req.session=login?.read(req);
    if(req.session && !(await login.validate(req.session)))req.session=null;
    const cron=req.path==='/api/jobs/tick' && cronSecret && req.headers.authorization==='Bearer '+cronSecret;
    const publicPath=['/login','/login.js','/style.css','/api/auth/session','/api/auth/login'].includes(req.path);
    if(login && !req.session?.loggedIn && !publicPath && !cron){if(req.path.startsWith('/api') || req.path.startsWith('/images'))return res.status(401).json({error:'سجّل الدخول أولًا.'});return res.redirect('/login');}
    if(req.path.startsWith('/api') && !['GET','HEAD'].includes(req.method)){
      const value=String(req.headers['x-csrf-token'] || '');
      const expected=login?req.session?.csrf:csrf;
      if(!(cloud?[baseUrl]:[baseUrl,`http://localhost:${port}`]).includes(req.headers.origin) || !expected || value.length!==expected.length || !timingSafeEqual(Buffer.from(value),Buffer.from(expected)))return res.status(403).json({error:'أعد تحميل الصفحة ثم حاول مرة أخرى.'});
    }
    next();
  });
  app.use(express.json({limit:'512kb'}));
  app.get('/login',(req,res)=>res.sendFile(join(root,'public','login.html')));
  app.get('/api/auth/session',(req,res)=>{const session=req.session || login?.issue(res,false);res.json({csrf:session?.csrf || csrf,loggedIn:session?.loggedIn || false});});
  app.post('/api/auth/login',async(req,res)=>{if(!login)return res.status(400).json({error:'Login disabled in test mode'});await login.login(req,res);});
  app.post('/api/auth/logout',async(req,res)=>{await login?.logout(req,res);res.json({ok:true});});
  const safeSettings=async()=>{const s=(await store.settings());return {mailbox:s.mailbox,allowedSender:s.allowedSender,pageId:s.pageId,apiVersion:s.apiVersion,clientId:s.clientId,autoSync:s.autoSync,hasClientSecret:!!s.clientSecret,hasFacebookToken:!!s.facebookToken,connectedEmail:s.connectedEmail || null,redirectUri:baseUrl+'/auth/google/callback'};};
  app.get('/api/bootstrap',async(req,res)=>res.json({csrf:req.session?.csrf || csrf,settings:await safeSettings(),sync:gmail.state(),runtime:{cloud,maxUploadMB:cloud?3:8,email:authConfig?.email || 'admin@admin.com'}}));
  app.get('/api/posts',async(req,res)=>res.json((await store.db.prepare("SELECT * FROM posts WHERE status!='deleted' ORDER BY created_at DESC").all())));
  app.get('/api/events',async(req,res)=>res.json({events:(await store.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all()),emails:(await store.db.prepare('SELECT * FROM emails ORDER BY created_at DESC LIMIT 30').all())}));
  app.post('/api/settings',async(req,res)=>{
    const b=req.body,s=(await store.settings());
    if(b.pageId && !/^\d+$/.test(b.pageId))throw new Error('Page ID يجب أن يكون أرقامًا.');
    if(!/^v\d+\.0$/.test(b.apiVersion || ''))throw new Error('نسخة API غير صالحة.');
    if(b.allowedSender && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.allowedSender))throw new Error('عنوان المُرسل غير صالح.');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.mailbox || ''))throw new Error('عنوان Gmail غير صالح.');
    const updated={...s,mailbox:b.mailbox,allowedSender:b.allowedSender.trim().toLowerCase(),pageId:b.pageId,apiVersion:b.apiVersion,clientId:String(b.clientId || '').trim(),autoSync:!!b.autoSync};
    if(b.clientSecret)updated.clientSecret=String(b.clientSecret).trim();if(b.facebookToken)updated.facebookToken=String(b.facebookToken).trim();
    if(updated.clientId!==s.clientId || updated.mailbox!==s.mailbox || (b.clientSecret && updated.clientSecret!==s.clientSecret)){delete updated.googleTokens;delete updated.connectedEmail;}
    (await store.saveSettings(updated));res.json(await safeSettings());
  });
  app.post('/api/google/connect',async(req,res)=>{const state=randomBytes(32).toString('hex');await store.db.prepare('DELETE FROM oauth_states WHERE expires<?').run(Date.now());await store.db.prepare('INSERT INTO oauth_states VALUES(?,?,?)').run(state,Date.now()+600000,req.session?.id || 'test');res.json({url:await gmail.authUrl(state)});});
  app.get('/auth/google/callback',async(req,res)=>{
    const state=await store.db.prepare('DELETE FROM oauth_states WHERE state=? AND expires>? AND session_id=? RETURNING state').get(String(req.query.state || ''),Date.now(),req.session?.id || 'test');
    if(!state)return res.status(400).send('OAuth state invalid. Start again from Settings.');
    try {if(!req.query.code)throw new Error('No code');await gmail.connect(String(req.query.code));res.redirect('/?gmail=connected');}
    catch{res.redirect('/?gmail=failed');}
  });
  app.post('/api/google/disconnect',async(req,res)=>{const s=(await store.settings());delete s.googleTokens;delete s.connectedEmail;(await store.saveSettings(s));res.json({ok:true});});
  app.post('/api/sync',async(req,res)=>res.json(await gmail.sync({retryInvalid:true})));
  app.post('/api/import',upload.array('images',10),async(req,res)=>res.json(await ingest(store,req.body.payload,req.files)));
  app.patch('/api/posts/:id',upload.single('image'),async(req,res)=>{
    const p=(await store.db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id));
    if(!p || !['pending','failed','rejected','missed'].includes(p.status))throw new Error('لا يمكن تعديل هذا البوست.');
    const caption=String(req.body.caption ?? p.caption);if(!caption.trim() || caption.length>60000)throw new Error('الكابشن فارغ أو طويل جدًا.');
    let image=p.image,issue=p.issue;
    if(req.file){image=await saveImage(req.file.buffer,directory);issue=null;}
    else if(req.body.imageUrl?.trim()){image=await saveImage(await downloadImage(req.body.imageUrl.trim()),directory);issue=null;}
    const updated=(await store.db.prepare("UPDATE posts SET caption=?,image=?,issue=?,status='pending',updated_at=? WHERE id=? AND updated_at=? AND status IN ('pending','failed','rejected','missed')").run(caption,image,issue,new Date().toISOString(),p.id,p.updated_at));
    if(!updated.changes)throw new Error('حالة البوست اتغيرت. أعد فتحه للمراجعة.');
    (await store.event(p.id,'edited','تم حفظ التعديلات وإعادته للمراجعة.'));res.json({ok:true});
  });
  app.delete('/api/posts/:id',async(req,res)=>{
    const r=(await store.db.prepare("UPDATE posts SET status='deleted',scheduled_at=NULL,updated_at=? WHERE id=? AND status NOT IN ('publishing','deleted','facebook_scheduling','facebook_scheduled','facebook_cancelling','facebook_schedule_uncertain')").run(new Date().toISOString(),req.params.id));
    if(!r.changes)throw new Error('لا يمكن حذف البوست الآن. لو مجدول على Facebook، ألغِ جدولته أولًا.');
    (await store.event(req.params.id,'deleted','تم حذف البوست من البرنامج وإلغاء أي جدولة. نسخة Facebook إن وجدت تظل على الصفحة.'));
    res.json({ok:true});
  });
  app.post('/api/posts/:id/reject',async(req,res)=>{
    const r=(await store.db.prepare("UPDATE posts SET status='rejected',updated_at=? WHERE id=? AND status IN ('pending','failed')").run(new Date().toISOString(),req.params.id));
    if(!r.changes)throw new Error('لا يمكن رفض هذا البوست الآن.');(await store.event(req.params.id,'rejected','تم رفض البوست.'));res.json({ok:true});
  });
  app.post('/api/posts/:id/schedule',async(req,res)=>{
    if(req.body.approved!==true)throw new Error('الموافقة اليدوية مطلوبة.');
    res.json(await scheduleOnFacebook(store,req.params.id,req.body.localTime,request));
  });
  app.post('/api/posts/:id/cancel-schedule',async(req,res)=>{
    const p=await store.db.prepare('SELECT status FROM posts WHERE id=?').get(req.params.id);
    if(['facebook_scheduled','facebook_schedule_uncertain'].includes(p?.status))return res.json(await cancelFacebookSchedule(store,req.params.id,request));
    const r=(await store.db.prepare("UPDATE posts SET status='pending',scheduled_at=NULL,updated_at=? WHERE id=? AND status='scheduled'").run(new Date().toISOString(),req.params.id));
    if(!r.changes)throw new Error('الجدولة اتنفذت أو اتلغت بالفعل.');
    (await store.event(req.params.id,'schedule_cancelled','تم إلغاء الجدولة وإعادة البوست للمراجعة.'));res.json({ok:true});
  });
  app.post('/api/posts/:id/check-facebook',async(req,res)=>res.json(await checkFacebookSchedule(store,req.params.id,request)));
  app.post('/api/posts/:id/publish',async(req,res)=>{
    if(req.body.approved!==true)throw new Error('الموافقة اليدوية مطلوبة.');
    res.json(await publishPost(store,req.params.id,request));
  });
  app.post('/api/posts/:id/reconcile',async(req,res)=>{
    const p=(await store.db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id));
    if(!['uncertain','facebook_schedule_uncertain'].includes(p?.status) || req.body.checked!==true)throw new Error('راجع صفحة Facebook ومخطط Meta أولًا.');
    if(req.body.result==='published') {
      if(!/^[\d_]+$/.test(req.body.photoId || ''))throw new Error('أدخل رقم الصورة الذي ظهر في Facebook.');
      (await store.db.prepare("UPDATE posts SET status='published',photo_id=?,issue=NULL,updated_at=? WHERE id=? AND status IN ('uncertain','facebook_schedule_uncertain')").run(req.body.photoId,new Date().toISOString(),p.id));
    }else if(req.body.result==='not_published')(await store.db.prepare("UPDATE posts SET status='pending',scheduled_at=NULL,facebook_post_id=NULL,photo_id=NULL,issue=NULL,updated_at=? WHERE id=? AND status IN ('uncertain','facebook_schedule_uncertain')").run(new Date().toISOString(),p.id));
    else throw new Error('اختر نتيجة المراجعة.');
    (await store.event(p.id,'reconciled','تم تسجيل نتيجة مراجعة Facebook يدويًا.'));res.json({ok:true});
  });
  app.get('/images/:name',async(req,res)=>{
    if(!/^[\w-]+\.(png|jpg)$/.test(req.params.name))return res.sendStatus(404);
    try{res.type(req.params.name.endsWith('.png')?'png':'jpg').send(await imageBuffer(directory,req.params.name));}catch{res.sendStatus(404);}
  });
  app.get('/api/jobs/tick',async(req,res)=>{
    if(!cronSecret || req.headers.authorization!=='Bearer '+cronSecret)return res.sendStatus(401);
    const owner=randomBytes(16).toString('hex'),now=Date.now();
    const lock=await store.db.prepare('INSERT INTO app_locks(name,owner,expires) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE app_locks.expires<?').run('jobs',owner,now+330000,now);
    if(!lock.changes)return res.json({busy:true});
    try{
      await store.db.prepare("UPDATE posts SET status='uncertain',issue='انقطع النشر. راجع Facebook قبل إعادة المحاولة.' WHERE status='publishing' AND updated_at<?").run(new Date(now-300000).toISOString());
      await store.db.prepare("UPDATE posts SET status='facebook_schedule_uncertain',issue='انقطع الاتصال أثناء الجدولة أو الإلغاء. راجع مخطط Meta قبل المحاولة.' WHERE status IN ('facebook_scheduling','facebook_cancelling') AND updated_at<?").run(new Date(now-300000).toISOString());
      await refreshFacebookSchedules(store,request);
      await processDue(store,request);
      const s=await store.settings();const sync=s.autoSync && s.googleTokens && s.allowedSender?await gmail.sync():null;
      res.json({ok:true,sync});
    }finally{await store.db.prepare('DELETE FROM app_locks WHERE name=? AND owner=?').run('jobs',owner);}
  });
  app.use(express.static(join(root,'public')));
  app.use((error,req,res,next)=>{
    const message=error.code==='LIMIT_FILE_SIZE' ? (cloud?'الصورة أكبر من 3 ميجابايت لرفعها من المتصفح.':'الصورة أكبر من 8 ميجابايت.') : error.message || 'حدث خطأ.';
    res.status(400).json({error:message});
  });
  let scheduling=false;
  const scheduleTimer=cloud || !backgroundJobs?null:setInterval(async()=>{if(scheduling)return;scheduling=true;try{await processDue(store,request);}catch(e){await store.event(null,'scheduler_error','تعذر تنفيذ الجدولة.');}finally{scheduling=false;}},5000);scheduleTimer?.unref();
  const timer=cloud || !backgroundJobs?null:setInterval(async()=>{const s=(await store.settings());if(s.autoSync && s.googleTokens && s.allowedSender)gmail.sync().catch(()=>{});},60000);timer?.unref();
  return {app,store,gmail,close:()=>{clearInterval(timer);clearInterval(scheduleTimer);store.db.close();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT || 3210);const studio=createApp({port});
  studio.app.listen(port,'127.0.0.1',()=>console.log(`NUVEXA Studio ready: http://127.0.0.1:${port}`));
}

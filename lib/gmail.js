import { OAuth2Client } from 'google-auth-library';
import { simpleParser } from 'mailparser';
import { ingest } from './intake.js';
import { randomUUID } from 'node:crypto';

export function gmailService(store,baseUrl) {
  let running=false;
  let lastSync=null,lastError=null;
  const client=async(persist=true)=>{
    const s=(await store.settings());
    const c=new OAuth2Client(s.clientId,s.clientSecret,baseUrl+'/auth/google/callback');
    c.setCredentials(s.googleTokens || {});
    if(persist){
      const writes=[];
      c.on('tokens',tokens=>{writes.push((async()=>{const latest=await store.settings();await store.saveSettings({...latest,googleTokens:{...latest.googleTokens,...tokens}});})());});
      const request=c.request.bind(c);
      c.request=async(...args)=>{try{return await request(...args);}finally{await Promise.all(writes.splice(0));}};
    }
    return c;
  };
  const authUrl=async state=>{
    const s=(await store.settings());if(!s.clientId || !s.clientSecret)throw new Error('احفظ Google Client ID وClient Secret أولًا.');
    return (await client(false)).generateAuthUrl({access_type:'offline',prompt:'consent',scope:['https://www.googleapis.com/auth/gmail.readonly'],state,login_hint:s.mailbox});
  };
  const connect=async code=>{
    const c=await client(false);const {tokens}=await c.getToken(code);c.setCredentials(tokens);
    const profile=await c.request({url:'https://gmail.googleapis.com/gmail/v1/users/me/profile',timeout:30000});
    const s=(await store.settings());if(profile.data.emailAddress.toLowerCase()!==s.mailbox.toLowerCase())throw new Error('اختار حساب '+s.mailbox+' عند تسجيل الدخول.');
    (await store.saveSettings({...s,googleTokens:tokens,connectedEmail:profile.data.emailAddress}));
  };
  async function sync({retryInvalid=false}={}) {
    if(running)return {busy:true};
    const s=(await store.settings());
    if(!s.googleTokens?.refresh_token && !s.googleTokens?.access_token)throw new Error('اربط Gmail من الإعدادات أولًا.');
    if(!s.allowedSender)throw new Error('اكتب عنوان مُرسل إيميلات Gemini في الإعدادات.');
    const owner=randomUUID(),deadline=store.cloud?Date.now()+120000:Infinity;
    if(store.cloud){const now=Date.now();const lock=await store.db.prepare('INSERT INTO app_locks(name,owner,expires) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE app_locks.expires<?').run('gmail',owner,now+240000,now);if(!lock.changes)return {busy:true};}
    running=true;lastError=null;
    const total={added:0,duplicates:0,issues:0,emails:0};
    try {
      const c=await client();let pageToken;
      // Bounded intake from the last 7 days; persistent email IDs make polling repeat-safe.
      for(let page=0;page<10;page++) {
        const list=await c.request({url:'https://gmail.googleapis.com/gmail/v1/users/me/messages',params:{q:'in:inbox subject:NUVEXA newer_than:7d',maxResults:50,...(pageToken ? {pageToken}: {})},timeout:30000});
        for(const {id} of list.data.messages || []) {
          if(Date.now()>deadline){total.incomplete=true;lastSync=new Date().toISOString();return total;}
          const previous=(await store.db.prepare('SELECT status FROM emails WHERE id=?').get(id));
          // Manual sync rechecks old mail after parser/dedup fixes. Intake remains
          // idempotent; automatic polling still skips previously handled messages.
          if(previous && !(retryInvalid && ['invalid','received','ignored'].includes(previous.status)))continue;
          try {
            const raw=await c.request({url:`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,params:{format:'raw'},timeout:30000});
            if((raw.data.sizeEstimate || 0)>25*1024*1024)throw new Error('الإيميل أكبر من 25 ميجابايت.');
            const mail=await simpleParser(Buffer.from(raw.data.raw,'base64url'));
            const sender=mail.from?.value?.[0]?.address?.toLowerCase();
            if(!mail.subject?.includes('[NUVEXA]') || sender!==s.allowedSender.toLowerCase()) {
              (await store.db.prepare('INSERT OR IGNORE INTO emails VALUES(?,?,?,?)').run(id,'ignored','الموضوع أو المرسل غير مطابق.',new Date().toISOString()));continue;
            }
            // mailparser generates text from HTML-only messages.
            const r=await ingest(store,mail.text || '',mail.attachments,id,undefined,{deadline});
            for(const key of ['added','duplicates','issues'])total[key]+=r[key];total.emails++;
            (await store.db.prepare('INSERT INTO emails VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,message=excluded.message').run(id,'received',JSON.stringify(r),new Date().toISOString()));
          }catch(e){
            if(e.code==='SYNC_BUDGET'){for(const key of ['added','duplicates','issues'])total[key]+=e.summary[key];total.incomplete=true;lastSync=new Date().toISOString();return total;}
            // Transport failures are retried next poll. Malformed content is recorded once.
            if(e.response || e.code)throw e;
            (await store.db.prepare('INSERT OR IGNORE INTO emails VALUES(?,?,?,?)').run(id,'invalid',e.message,new Date().toISOString()));
            (await store.event(null,'email_error',e.message));
          }
        }
        pageToken=list.data.nextPageToken;if(!pageToken)break;
      }
      lastSync=new Date().toISOString();return total;
    }catch(e){lastError='تعذر مزامنة Gmail. تحقق من الاتصال وصلاحية الربط.';throw new Error(lastError);}
    finally{running=false;if(store.cloud)await store.db.prepare('DELETE FROM app_locks WHERE name=? AND owner=?').run('gmail',owner);}
  }
  return {authUrl,connect,sync,state:()=>({running,lastSync,lastError})};
}

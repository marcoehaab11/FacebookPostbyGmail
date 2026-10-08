import { OAuth2Client } from 'google-auth-library';
import { simpleParser } from 'mailparser';
import { ingest } from './intake.js';

export function gmailService(store,baseUrl) {
  let running=false;
  let lastSync=null,lastError=null;
  const client=(persist=true)=>{
    const s=store.settings();
    const c=new OAuth2Client(s.clientId,s.clientSecret,baseUrl+'/auth/google/callback');
    c.setCredentials(s.googleTokens || {});
    if(persist)c.on('tokens',tokens=>{const latest=store.settings();store.saveSettings({...latest,googleTokens:{...latest.googleTokens,...tokens}});});
    return c;
  };
  const authUrl=state=>{
    const s=store.settings();if(!s.clientId || !s.clientSecret)throw new Error('احفظ Google Client ID وClient Secret أولًا.');
    return client(false).generateAuthUrl({access_type:'offline',prompt:'consent',scope:['https://www.googleapis.com/auth/gmail.readonly'],state,login_hint:s.mailbox});
  };
  const connect=async code=>{
    const c=client(false);const {tokens}=await c.getToken(code);c.setCredentials(tokens);
    const profile=await c.request({url:'https://gmail.googleapis.com/gmail/v1/users/me/profile',timeout:30000});
    const s=store.settings();if(profile.data.emailAddress.toLowerCase()!==s.mailbox.toLowerCase())throw new Error('اختار حساب '+s.mailbox+' عند تسجيل الدخول.');
    store.saveSettings({...s,googleTokens:tokens,connectedEmail:profile.data.emailAddress});
  };
  async function sync({retryInvalid=false}={}) {
    if(running)return {busy:true};
    const s=store.settings();
    if(!s.googleTokens?.refresh_token && !s.googleTokens?.access_token)throw new Error('اربط Gmail من الإعدادات أولًا.');
    if(!s.allowedSender)throw new Error('اكتب عنوان مُرسل إيميلات Gemini في الإعدادات.');
    running=true;lastError=null;
    const total={added:0,duplicates:0,issues:0,emails:0};
    try {
      const c=client();let pageToken;
      // Bounded intake from the last 7 days; persistent email IDs make polling repeat-safe.
      for(let page=0;page<10;page++) {
        const list=await c.request({url:'https://gmail.googleapis.com/gmail/v1/users/me/messages',params:{q:'in:inbox subject:NUVEXA newer_than:7d',maxResults:50,...(pageToken ? {pageToken}: {})},timeout:30000});
        for(const {id} of list.data.messages || []) {
          const previous=store.db.prepare('SELECT status FROM emails WHERE id=?').get(id);
          if(previous && !(retryInvalid && previous.status==='invalid'))continue;
          try {
            const raw=await c.request({url:`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,params:{format:'raw'},timeout:30000});
            if((raw.data.sizeEstimate || 0)>25*1024*1024)throw new Error('الإيميل أكبر من 25 ميجابايت.');
            const mail=await simpleParser(Buffer.from(raw.data.raw,'base64url'));
            const sender=mail.from?.value?.[0]?.address?.toLowerCase();
            if(!mail.subject?.includes('[NUVEXA]') || sender!==s.allowedSender.toLowerCase()) {
              store.db.prepare('INSERT OR IGNORE INTO emails VALUES(?,?,?,?)').run(id,'ignored','الموضوع أو المرسل غير مطابق.',new Date().toISOString());continue;
            }
            // mailparser generates text from HTML-only messages.
            const r=await ingest(store,mail.text || '',mail.attachments,id);
            for(const key of ['added','duplicates','issues'])total[key]+=r[key];total.emails++;
            store.db.prepare('INSERT INTO emails VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,message=excluded.message').run(id,'received',JSON.stringify(r),new Date().toISOString());
          }catch(e){
            // Transport failures are retried next poll. Malformed content is recorded once.
            if(e.response || e.code)throw e;
            store.db.prepare('INSERT OR IGNORE INTO emails VALUES(?,?,?,?)').run(id,'invalid',e.message,new Date().toISOString());
            store.event(null,'email_error',e.message);
          }
        }
        pageToken=list.data.nextPageToken;if(!pageToken)break;
      }
      lastSync=new Date().toISOString();return total;
    }catch(e){lastError='تعذر مزامنة Gmail. تحقق من الاتصال وصلاحية الربط.';throw new Error(lastError);}
    finally{running=false;}
  }
  return {authUrl,connect,sync,state:()=>({running,lastSync,lastError})};
}

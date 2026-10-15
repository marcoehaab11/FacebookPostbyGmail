// Read a replacement token through hidden stdin. Verify without publishing.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,writeFileSync } from 'node:fs';
import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');let input='',submitted=false;
console.log('Ready for Facebook token on hidden stdin. No post will be published.');
const encrypt=(value,key)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');};
const decrypt=(value,key)=>{const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());};
async function graph(path,token){const r=await fetch('https://graph.facebook.com/v26.0/'+path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000),redirect:'error'});const data=await r.json();if(!r.ok || data.error)throw Object.assign(new Error('Meta rejected request'),{code:data.error?.code || r.status,subcode:data.error?.error_subcode});return data;}
process.stdin.on('data',async chunk=>{
  if(submitted)return;input+=chunk;if(!/[\r\n]/.test(input))return;
  submitted=true;process.stdin.pause();const token=input.trim();input='';let db,cloud;
  try{
    db=new DatabaseSync('data/studio.sqlite');const key=readFileSync('data/secret.key');
    const local=decrypt(db.prepare('SELECT value FROM settings WHERE id=1').get().value,key),pageId=String(local.pageId);
    const identity=await graph('me?fields=id,name',token);let page=identity,pageToken=token;
    if(String(identity.id)!==pageId){
      let after;
      for(let i=0;i<10;i++){
        const pages=await graph('me/accounts?fields=id,name,access_token,tasks&limit=100'+(after?'&after='+encodeURIComponent(after):''),token);
        const found=pages.data?.find(p=>String(p.id)===pageId);if(found){page=found;pageToken=found.access_token;break;}
        after=pages.paging?.next?pages.paging?.cursors?.after:null;if(!after)break;
      }
    }
    if(String(page.id)!==pageId || !pageToken)throw Object.assign(new Error('Target page unavailable'),{code:'TARGET_PAGE_NOT_AVAILABLE'});
    let scopes;
    try{const debug=await graph('debug_token?input_token='+encodeURIComponent(pageToken),token);if(debug.data?.is_valid===false)throw new Error('Invalid token');scopes=debug.data?.scopes;}catch{
      const permissions=await graph('me/permissions',token);scopes=permissions.data?.filter(p=>p.status==='granted').map(p=>p.permission);
    }
    if(!scopes?.includes('pages_manage_posts'))throw Object.assign(new Error('Missing publishing permission'),{code:'MISSING_PAGES_MANAGE_POSTS'});
    const verified=await graph('me?fields=id,name',pageToken);if(String(verified.id)!==pageId)throw new Error('Wrong page');
    const old=db.prepare('SELECT value FROM settings WHERE id=1').get().value;
    const updated={...decrypt(old,key),facebookToken:pageToken,pageId,apiVersion:'v26.0'};
    if(!db.prepare('UPDATE settings SET value=? WHERE id=1 AND value=?').run(encrypt(updated,key),old).changes)throw new Error('Settings changed concurrently');
    let cloudUpdated=false;
    if(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN){
      cloud=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN});
      const cloudKey=Buffer.from(process.env.SETTINGS_ENCRYPTION_KEY || '', 'base64');
      for(let i=0;i<3;i++){
        const row=(await cloud.execute('SELECT value FROM settings WHERE id=1')).rows[0];if(!row)break;
        const settings=decrypt(row.value,cloudKey);if(String(settings.pageId)!==pageId)throw new Error('Cloud target page differs');
        const value=encrypt({...settings,facebookToken:pageToken,apiVersion:'v26.0'},cloudKey);
        const result=await cloud.execute({sql:'UPDATE settings SET value=? WHERE id=1 AND value=?',args:[value,row.value]});
        if(result.rowsAffected){cloudUpdated=true;break;}
      }
      const events=await cloud.execute("SELECT type,message,created_at FROM events WHERE type IN ('publish_failed','uncertain') ORDER BY id DESC LIMIT 3");
      console.log(JSON.stringify({recentCloudErrors:events.rows}));
    }
    const path='.env.vercel.local';let env=readFileSync(path,'utf8');
    env=env.replace(/^INITIAL_SETTINGS_ENCRYPTED=.*$/m,()=> 'INITIAL_SETTINGS_ENCRYPTED='+encrypt(updated,key));writeFileSync(path,env,{mode:0o600});
    console.log(JSON.stringify({ok:true,pageId,pageName:verified.name,publishingPermission:true,localUpdated:true,cloudUpdated,published:false}));
  }catch(e){console.log(JSON.stringify({ok:false,code:e.code || 'VERIFICATION_FAILED',subcode:e.subcode,published:false}));}
  finally{db?.close();cloud?.close();process.exit(0);}
});

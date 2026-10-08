// Read a Page token from hidden stdin; never print or put it in command arguments.
import {createStore} from '../lib/store.js';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',async chunk=>{
  input+=chunk;if(!/[\r\n]/.test(input))return;
  process.stdin.pause();const token=input.trim();input='';
  const store=createStore(join(dirname(fileURLToPath(import.meta.url)),'..','data'));
  try{
    const r=await fetch('https://graph.facebook.com/v26.0/me?fields=id,name',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(25000)});
    let p=await r.json(),pageToken=token;
    if(r.ok && String(p.id)!==store.settings().pageId){
      const list=await fetch('https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(25000)});
      const pages=await list.json();
      p=pages.data?.find(page=>String(page.id)===store.settings().pageId) || {error:pages.error || {code:'target_page_not_available'}};
      pageToken=p.access_token;
    }
    if(p.error || !pageToken || String(p.id)!==store.settings().pageId || p.name?.trim().toLowerCase()!=='nuvexa real')console.log(JSON.stringify({ok:false,code:p.error?.code,name:p.name}));
    else{store.saveSettings({...store.settings(),facebookToken:pageToken,pageId:String(p.id),apiVersion:'v26.0'});console.log(JSON.stringify({ok:true,pageId:String(p.id),pageName:p.name.trim(),apiVersion:'v26.0'}));}
  }catch{console.log(JSON.stringify({ok:false,reason:'connection_failed'}));}
  finally{store.db.close();if(process.stdin.isTTY){process.stdin.setRawMode(false);process.stdin.unref();}}
});

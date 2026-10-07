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
    const r=await fetch('https://graph.facebook.com/v26.0/me?fields=id,name,category',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(25000)});
    const p=await r.json();
    if(!r.ok || !p.category || p.name?.trim().toLowerCase()!=='nuvexa real')console.log(JSON.stringify({ok:false,code:p.error?.code,name:p.name}));
    else{store.saveSettings({...store.settings(),facebookToken:token,pageId:String(p.id),apiVersion:'v26.0'});console.log(JSON.stringify({ok:true,pageId:String(p.id),pageName:p.name.trim(),apiVersion:'v26.0'}));}
  }catch{console.log(JSON.stringify({ok:false,reason:'connection_failed'}));}
  finally{store.db.close();if(process.stdin.isTTY){process.stdin.setRawMode(false);process.stdin.unref();}}
});

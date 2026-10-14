import { createClient } from '@libsql/client';
import { readFileSync,writeFileSync } from 'node:fs';
let input='',submitted=false;
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
console.log('Ready for Turso JSON on hidden stdin.');
process.stdin.on('data',async chunk=>{
  if(submitted)return;
  input+=chunk;if(!/[\r\n]/.test(input))return;
  submitted=true;process.stdin.pause();let client;
  try{
    const {url,authToken}=JSON.parse(input.trim());input='';
    if(!/^libsql:\/\//.test(url) || !authToken)throw new Error('Invalid configuration');
    client=createClient({url,authToken});
    const result=await client.execute('SELECT 1 AS connected');
    if(Number(result.rows[0]?.connected)!==1)throw new Error('Connection failed');
    const path='.env.vercel.local';let contents=readFileSync(path,'utf8');
    for(const [name,value] of Object.entries({TURSO_DATABASE_URL:url,TURSO_AUTH_TOKEN:authToken})){
      if(/[\r\n]/.test(value))throw new Error('Invalid value');
      const pattern=new RegExp('^'+name+'=.*$','m');
      contents=pattern.test(contents)?contents.replace(pattern,()=>name+'='+value):contents+'\n'+name+'='+value+'\n';
    }
    writeFileSync(path,contents,{mode:0o600});
    console.log('Turso connection verified. Updated ignored .env.vercel.local; secret values were not printed.');
    client.close();process.exit(0);
  }catch{client?.close();console.error('Turso setup failed. Check the URL, token and connection. No secret values were printed.');process.exit(1);}
});

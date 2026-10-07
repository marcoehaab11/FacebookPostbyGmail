// Isolated browser QA. Never uses the user's data directory or credentials.
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createApp } from '../server.js';
import { ingest } from '../lib/intake.js';
const directory=await mkdtemp(join(tmpdir(),'nuvexa-preview-'));
const studio=createApp({directory,port:3220});
const png=new PNG({width:480,height:480});
for(let y=0;y<480;y++)for(let x=0;x<480;x++){const i=(y*480+x)*4;png.data[i]=40+Math.round(y/9);png.data[i+1]=74+Math.round(x/15);png.data[i+2]=58;png.data[i+3]=255;}
await ingest(studio.store,{brand:'NUVEXA PROPERTIES',date:'2026-10-07',posts:[{post_id:1,theme:'معاينة تجريبية — NUVEXA',caption:'بيانات اختبار للمعاينة فقط.\nمساحة بتفاصيل أهدى، وحياة أقرب للي بتحلم بيه.\n#NUVEXA #Properties'}]},[{filename:'post_1.png',contentType:'image/png',content:PNG.sync.write(png)}]);
const server=studio.app.listen(3220,'127.0.0.1',()=>console.log('Isolated QA: http://127.0.0.1:3220'));
process.on('SIGINT',()=>server.close(async()=>{studio.close();if(!directory.startsWith(tmpdir()) || !directory.includes('nuvexa-preview-'))throw new Error('Unsafe cleanup path');await rm(directory,{recursive:true,force:true});process.exit();}));

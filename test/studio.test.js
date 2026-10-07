import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { createStore } from '../lib/store.js';
import { parsePayload,ingest } from '../lib/intake.js';
import { publishPost } from '../lib/publisher.js';
import { normalizeUrl, publicAddress,saveImage } from '../lib/images.js';
import { createApp } from '../server.js';

async function cleanFixture(directory){const parent=join(tmpdir(),'');if(!directory.startsWith(parent) || !directory.slice(parent.length).replace(/^[/\\]/,'').startsWith('nuvexa-'))throw new Error('Unsafe test cleanup path');await rm(directory,{recursive:true,force:true});}
const payload={brand:'NUVEXA PROPERTIES',date:'2026-10-07',posts:[{post_id:1,theme:'Luxury',caption:'Luxury 🏡\n#NUVEXA'}]};
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'nuvexa-'));const store=createStore(directory);t.after(async()=>{store.db.close();await cleanFixture(directory);});const png=new PNG({width:32,height:32});png.data.fill(100);const buffer=PNG.sync.write(png);return {store,buffer};}
test('validates payloads and parses Gemini code fences',()=>{
  assert.deepEqual(parsePayload('```json\n'+JSON.stringify(payload)+'\n```'),payload);
  assert.throws(()=>parsePayload({...payload,date:'2026-02-30'}));
  assert.throws(()=>parsePayload({...payload,posts:[payload.posts[0],payload.posts[0]]}));
  assert.throws(()=>parsePayload({...payload,posts:[{post_id:1,caption:''}]}));
});
test('rejects local network URLs and normalizes public Drive files',()=>{
  assert.throws(()=>normalizeUrl('http://example.com/a'));assert.throws(()=>normalizeUrl('https://127.0.0.1/a'));assert.throws(()=>normalizeUrl('https://user:secret@example.com/a'));
  for(const ip of ['127.0.0.1','10.2.3.4','172.16.4.2','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(publicAddress(ip),false);
  assert.equal(publicAddress('8.8.8.8'),true);
  assert.equal(normalizeUrl('https://drive.google.com/file/d/abcdef/view'),'https://drive.google.com/uc?export=download&id=abcdef');
});
test('intake stays pending, deduplicates and retains missing images for repair',async t=>{
  const {store,buffer}=await fixture(t);
  const a=await ingest(store,payload,[{filename:'post_1.png',contentType:'image/png',content:buffer}]);assert.equal(a.added,1);
  const post=store.db.prepare('SELECT * FROM posts').get();assert.equal(post.status,'pending');assert(post.image);assert.equal(post.caption,payload.posts[0].caption);
  assert.equal((await ingest(store,payload)).duplicates,1);
  const b=await ingest(store,{...payload,posts:[{post_id:2,caption:'Needs photo'}]});assert.equal(b.issues,1);
  await assert.rejects(saveImage(Buffer.from('<html>Login</html>'),store.directory));
  const jpg=jpeg.encode({width:2,height:2,data:Buffer.alloc(16,255)},90).data;
  assert.match(await saveImage(Buffer.from(jpg),store.directory),/\.jpg$/);
});
test('one concurrent publisher claims a post and stores Facebook IDs',async t=>{
  const {store,buffer}=await fixture(t);await ingest(store,payload,[{filename:'post_1.png',contentType:'image/png',content:buffer}]);
  store.saveSettings({...store.settings(),pageId:'123',facebookToken:'secret-token'});
  const post=store.db.prepare('SELECT * FROM posts').get();let calls=0;
  const request=async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer secret-token');assert.equal(options.body.get('published'),'true');await new Promise(r=>setTimeout(r,20));return Response.json({id:'987',post_id:'123_987'});};
  const results=await Promise.allSettled([publishPost(store,post.id,request),publishPost(store,post.id,request)]);
  assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(store.db.prepare('SELECT status FROM posts').get().status,'published');
  assert(!String(await readFile(join(store.directory,'studio.sqlite'))).includes('secret-token'));
});
test('ambiguous upload is held without automatic retries; definite Graph failure is retryable',async t=>{
  const {store,buffer}=await fixture(t);await ingest(store,payload,[{filename:'post_1.png',contentType:'image/png',content:buffer}]);store.saveSettings({...store.settings(),pageId:'123',facebookToken:'secret'});
  const post=store.db.prepare('SELECT * FROM posts').get();let calls=0;
  const r=await publishPost(store,post.id,async()=>{calls++;throw new Error('timeout');});assert.equal(r.status,'uncertain');
  await assert.rejects(publishPost(store,post.id,async()=>{calls++;}));assert.equal(calls,1);
  store.db.prepare("UPDATE posts SET status='pending',issue=NULL WHERE id=?").run(post.id);
  const failed=await publishPost(store,post.id,async()=>Response.json({error:{code:190}},{status:400}));assert.equal(failed.status,'failed');
});
test('HTTP blocks cross-origin mutation, hides secrets, and requires approval',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'nuvexa-http-'));const studio=createApp({directory,port:3219});
  const server=await new Promise(resolve=>{const s=studio.app.listen(3219,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(r=>server.close(r));studio.close();await cleanFixture(directory);});
  const base='http://127.0.0.1:3219';
  const bootstrap=await (await fetch(base+'/api/bootstrap')).json();assert(bootstrap.csrf);assert.equal(bootstrap.settings.facebookToken,undefined);
  const blocked=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
  const headers={'Content-Type':'application/json',Origin:base,'X-CSRF-Token':bootstrap.csrf};
  const noApproval=await fetch(base+'/api/posts/none/publish',{method:'POST',headers,body:'{}'});assert.equal(noApproval.status,400);assert.match((await noApproval.json()).error,/الموافقة/);
  const form=new FormData();form.set('payload',JSON.stringify(payload));const imported=await fetch(base+'/api/import',{method:'POST',headers:{Origin:base,'X-CSRF-Token':bootstrap.csrf},body:form});assert.equal(imported.status,200);
  const posts=await(await fetch(base+'/api/posts')).json();assert.equal(posts[0].status,'pending');assert(posts[0].issue);
});

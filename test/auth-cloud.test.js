import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { createCloudStore } from '../lib/cloud-store.js';
import { createApp } from '../server.js';
import { hashPassword } from '../lib/auth.js';
import { PNG } from 'pngjs';
import { ingest } from '../lib/intake.js';
import { publishPost } from '../lib/publisher.js';

test('login protects API/images, checks CSRF, rotates sessions and revokes logout',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'nuvexa-login-'));
  const studio=createApp({directory,port:3220,authConfig:{email:'test@example.com',passwordHash:hashPassword('test-only-password'),sessionSecret:'a'.repeat(64)}});
  const server=await new Promise(r=>{const s=studio.app.listen(3220,'127.0.0.1',()=>r(s));});
  t.after(async()=>{await new Promise(r=>server.close(r));studio.close();await rm(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:3220';
  for(const path of ['/api/bootstrap','/api/posts','/images/test.png'])assert.equal((await fetch(base+path)).status,401);
  assert.equal((await fetch(base,{redirect:'manual'})).headers.get('location'),'/login');
  const anonymous=await fetch(base+'/api/auth/session'),session=await anonymous.json(),cookie=anonymous.headers.get('set-cookie').split(';')[0];
  const headers={Cookie:cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers:{...headers,Origin:'https://attacker.example'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({email:'test@example.com',password:'wrong'})})).status,401);
  const logged=await fetch(base+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({email:'test@example.com',password:'test-only-password'})});
  assert.equal(logged.status,200);const authCookie=logged.headers.get('set-cookie').split(';')[0];assert.notEqual(authCookie,cookie);assert.match(logged.headers.get('set-cookie'),/HttpOnly/);
  const bootstrap=await(await fetch(base+'/api/bootstrap',{headers:{Cookie:authCookie}})).json();assert.notEqual(bootstrap.csrf,session.csrf);assert.equal(bootstrap.settings.facebookToken,undefined);
  assert.equal((await fetch(base+'/api/auth/logout',{method:'POST',headers:{...headers,Cookie:authCookie,'X-CSRF-Token':bootstrap.csrf},body:'{}'})).status,200);
  assert.equal((await fetch(base+'/api/posts',{headers:{Cookie:authCookie}})).status,401);
});

test('async cloud storage persists settings/posts and prevents two instances publishing twice',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'nuvexa-cloud-')),url='file:'+join(directory,'remote.sqlite');
  const env={TURSO_DATABASE_URL:url,TURSO_AUTH_TOKEN:'test',SETTINGS_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),SESSION_SECRET:'s'.repeat(64),ADMIN_EMAIL:'test@example.com',ADMIN_PASSWORD_HASH:hashPassword('test-only-password'),APP_URL:'https://test.example.com',CRON_SECRET:'c'.repeat(64),BLOB_READ_WRITE_TOKEN:'test'};
  const saved=new Map(),images={write:async(n,b)=>saved.set(n,b),read:async n=>saved.get(n)};
  const first=await createCloudStore(env,{client:createClient({url}),images}),second=await createCloudStore(env,{client:createClient({url}),images});
  t.after(async()=>{first.db.close();second.db.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:300});});
  await first.saveSettings({...await first.settings(),pageId:'123',facebookToken:'cloud-secret'});
  assert.equal((await second.settings()).facebookToken,'cloud-secret');
  assert(!(await first.db.prepare('SELECT value FROM settings').get()).value.includes('cloud-secret'));
  const png=new PNG({width:2,height:2});png.data.fill(255);
  await ingest(first,{brand:'NUVEXA PROPERTIES',date:'2026-10-14',posts:[{post_id:1,caption:'Cloud test'}]},[{filename:'post_1.png',contentType:'image/png',content:PNG.sync.write(png)}]);
  const post=await second.db.prepare('SELECT * FROM posts').get();assert(post.image);
  let calls=0;const request=async()=>{calls++;await new Promise(r=>setTimeout(r,20));return Response.json({id:'456'});};
  await Promise.allSettled([publishPost(first,post.id,request),publishPost(second,post.id,request)]);
  assert.equal(calls,1);assert.equal((await second.db.prepare('SELECT status FROM posts').get()).status,'published');
});

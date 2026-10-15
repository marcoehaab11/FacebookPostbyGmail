import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createStore } from '../lib/store.js';
import { ingest } from '../lib/intake.js';
import { processDue,cairoTime } from '../lib/scheduler.js';
import { scheduleOnFacebook,cancelFacebookSchedule,checkFacebookSchedule } from '../lib/facebook-schedule.js';
import { createApp } from '../server.js';

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'nuvexa-facebook-')),store=createStore(directory);
  t.after(async()=>{store.db.close();await rm(directory,{recursive:true,force:true});});
  store.saveSettings({...store.settings(),pageId:'123',facebookToken:'test-token'});
  const png=new PNG({width:2,height:2});png.data.fill(255);
  await ingest(store,{brand:'NUVEXA PROPERTIES',date:'2026-10-15',posts:[{post_id:1,caption:'Native scheduling'}]},[{filename:'post_1.png',contentType:'image/png',content:PNG.sync.write(png)}]);
  const p=store.db.prepare('SELECT * FROM posts').get();
  const at=cairoTime('2030-12-01T20:00'),now=Date.parse(at)-3600000,seconds=Date.parse(at)/1000;
  return {store,p,now,seconds};
}
function responses(seconds,{onFeed,read}={}){
  return async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer test-token');
    if(url.endsWith('/photos')){assert.equal(options.body.get('published'),'false');assert(options.body.get('source') instanceof Blob);return Response.json({id:'456'});}
    if(url.endsWith('/feed')){
      assert.equal(options.body.get('published'),'false');assert.equal(options.body.get('message'),'Native scheduling');assert.equal(options.body.get('scheduled_publish_time'),String(seconds));assert.equal(options.body.get('unpublished_content_type'),'SCHEDULED');assert.deepEqual(JSON.parse(options.body.get('attached_media')),[{media_fbid:'456'}]);
      if(onFeed)return onFeed();return Response.json({id:'123_789'});
    }
    assert.match(url,/123_789\?fields=/);return read?read():Response.json({id:'123_789',is_published:false,scheduled_publish_time:seconds});
  };
}
test('native scheduling uploads unpublished photo, creates verified feed schedule and never sends it again at due time',async t=>{
  const {store,p,now,seconds}=await fixture(t);let calls=0;const request=responses(seconds);
  const result=await scheduleOnFacebook(store,p.id,'2030-12-01T20:00',async(...args)=>{calls++;return request(...args);},now);
  assert.equal(result.status,'facebook_scheduled');assert.equal(calls,3);
  const saved=store.db.prepare('SELECT * FROM posts').get();assert.equal(saved.facebook_post_id,'123_789');assert.equal(saved.photo_id,'456');
  await processDue(store,async()=>{assert.fail('Native schedule must not be published by the local job');},seconds*1000+1000);
  assert.equal(calls,3);
});
test('native scheduling claims once and validates time before any upload',async t=>{
  const {store,p,now,seconds}=await fixture(t);let calls=0;
  await assert.rejects(scheduleOnFacebook(store,p.id,'2030-12-01T20:00',async()=>{calls++;},seconds*1000-60000));assert.equal(calls,0);
  const request=responses(seconds);
  const result=await Promise.allSettled([scheduleOnFacebook(store,p.id,'2030-12-01T20:00',request,now),scheduleOnFacebook(store,p.id,'2030-12-01T20:00',request,now)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
});
test('ambiguous feed result is held, definite rejection is retryable, and read-back failure retains remote ID',async t=>{
  const {store,p,now,seconds}=await fixture(t);
  const unknown=await scheduleOnFacebook(store,p.id,'2030-12-01T20:00',responses(seconds,{onFeed:()=>{throw new Error('Timeout');}}),now);
  assert.equal(unknown.status,'facebook_schedule_uncertain');
  await assert.rejects(scheduleOnFacebook(store,p.id,'2030-12-01T20:00',responses(seconds),now));
  store.db.prepare("UPDATE posts SET status='pending',issue=NULL WHERE id=?").run(p.id);
  const failed=await scheduleOnFacebook(store,p.id,'2030-12-01T20:00',responses(seconds,{onFeed:()=>Response.json({error:{code:200}},{status:400})}),now);assert.equal(failed.status,'failed');
  const unread=await scheduleOnFacebook(store,p.id,'2030-12-01T20:00',responses(seconds,{read:()=>{throw new Error('Timeout');}}),now);assert.equal(unread.status,'facebook_schedule_uncertain');assert.equal(store.db.prepare('SELECT facebook_post_id FROM posts').get().facebook_post_id,'123_789');
});
test('remote cancellation deletes the schedule, but refuses to delete an already published post',async t=>{
  const {store,p,now,seconds}=await fixture(t);
  await scheduleOnFacebook(store,p.id,'2030-12-01T20:00',responses(seconds),now);
  let deleted=0;
  const cancel=await cancelFacebookSchedule(store,p.id,async(url,options)=>{if(options.method==='DELETE'){deleted++;return Response.json({success:true});}return Response.json({is_published:false,scheduled_publish_time:seconds});});
  assert.equal(cancel.status,'pending');assert.equal(deleted,1);assert.equal(store.db.prepare('SELECT facebook_post_id FROM posts').get().facebook_post_id,null);
  await scheduleOnFacebook(store,p.id,'2030-12-01T20:00',responses(seconds),now);
  const published=await cancelFacebookSchedule(store,p.id,async(url,options)=>{assert.notEqual(options.method,'DELETE');return Response.json({is_published:true});});assert.equal(published.status,'published');assert.equal(deleted,1);
});
test('ambiguous cancellation blocks re-creation and a later read can reconcile an existing schedule',async t=>{
  const {store,p,now,seconds}=await fixture(t);
  await scheduleOnFacebook(store,p.id,'2030-12-01T20:00',responses(seconds),now);
  const result=await cancelFacebookSchedule(store,p.id,async(url,options)=>{if(options.method==='DELETE')throw new Error('Timeout');return Response.json({is_published:false,scheduled_publish_time:seconds});});
  assert.equal(result.status,'facebook_schedule_uncertain');
  assert.equal((await checkFacebookSchedule(store,p.id,async()=>Response.json({is_published:false,scheduled_publish_time:seconds}))).status,'facebook_scheduled');
  store.saveSettings({...store.settings(),pageId:'999'});
  await assert.rejects(cancelFacebookSchedule(store,p.id,async()=>{assert.fail('Must not send the wrong Page token');}));
});

test('HTTP schedule defaults to Facebook, requires approval and prevents hiding a live schedule with local delete',async t=>{
  const {store,p}=await fixture(t);
  const localTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(Date.now()+86400000).replace(' ','T');
  const seconds=Date.parse(cairoTime(localTime))/1000;
  const studio=createApp({providedStore:store,port:3222,auth:false,backgroundJobs:false,request:responses(seconds)});
  const server=await new Promise(r=>{const s=studio.app.listen(3222,'127.0.0.1',()=>r(s));});
  t.after(async()=>{await new Promise(r=>server.close(r));});
  const base='http://127.0.0.1:3222',bootstrap=await(await fetch(base+'/api/bootstrap')).json();
  const headers={Origin:base,'Content-Type':'application/json','X-CSRF-Token':bootstrap.csrf};
  assert.equal((await fetch(base+'/api/posts/'+p.id+'/schedule',{method:'POST',headers,body:JSON.stringify({localTime})})).status,400);
  const result=await fetch(base+'/api/posts/'+p.id+'/schedule',{method:'POST',headers,body:JSON.stringify({approved:true,localTime})});
  assert.equal((await result.json()).status,'facebook_scheduled');
  assert.equal((await fetch(base+'/api/posts/'+p.id,{method:'DELETE',headers})).status,400);
});

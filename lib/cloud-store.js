import { createClient } from '@libsql/client';
import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { put,get } from '@vercel/blob';

export async function createCloudStore(env=process.env,{client:providedClient,images:providedImages}={}) {
  for(const name of ['TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','SETTINGS_ENCRYPTION_KEY','SESSION_SECRET','ADMIN_EMAIL','ADMIN_PASSWORD_HASH','APP_URL','CRON_SECRET'])if(!env[name])throw new Error('Missing cloud configuration: '+name);
  if(!env.BLOB_READ_WRITE_TOKEN && !env.BLOB_STORE_ID)throw new Error('Private Vercel Blob storage is required.');
  if(!/^https:\/\//.test(env.APP_URL))throw new Error('APP_URL must use HTTPS.');
  const key=Buffer.from(env.SETTINGS_ENCRYPTION_KEY,'base64');
  if(key.length!==32 || env.SESSION_SECRET.length<32 || env.CRON_SECRET.length<32)throw new Error('Invalid cloud encryption/session keys.');
  const client=providedClient || createClient({url:env.TURSO_DATABASE_URL,authToken:env.TURSO_AUTH_TOKEN});
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,dedup_key TEXT UNIQUE NOT NULL,source_id TEXT,source_post_id TEXT,brand TEXT,date TEXT,theme TEXT,caption TEXT NOT NULL,image TEXT,status TEXT NOT NULL DEFAULT 'pending',issue TEXT,page_id TEXT,photo_id TEXT,facebook_post_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,scheduled_at TEXT,intake_fingerprint TEXT);
    CREATE TABLE IF NOT EXISTS emails(id TEXT PRIMARY KEY,status TEXT,message TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,post_id TEXT,type TEXT,message TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY,expires INTEGER NOT NULL,session_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_locks(name TEXT PRIMARY KEY,owner TEXT,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts(id TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
  `);
  const db={prepare(sql){const execute=async args=>client.execute({sql,args:args.map(v=>v===undefined?null:v)});return {
    get:async(...args)=>(await execute(args)).rows[0],
    all:async(...args)=>(await execute(args)).rows,
    run:async(...args)=>{const r=await execute(args);return {changes:r.rowsAffected,lastInsertRowid:r.lastInsertRowid};}
  };},close:()=>client.close()};
  const encrypt=value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]).toString('base64');};
  const decrypt=value=>{const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());};
  if(env.INITIAL_SETTINGS_ENCRYPTED)await db.prepare('INSERT OR IGNORE INTO settings(id,value) VALUES(1,?)').run(env.INITIAL_SETTINGS_ENCRYPTED);
  const settings=async()=>{const row=await db.prepare('SELECT value FROM settings WHERE id=1').get();return {mailbox:'nuvexars@gmail.com',allowedSender:'',pageId:'',apiVersion:'v26.0',autoSync:true,...(row?.value?decrypt(row.value):{})};};
  const saveSettings=async value=>db.prepare('INSERT INTO settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(encrypt(value));
  const event=async(id,type,message)=>db.prepare('INSERT INTO events(post_id,type,message,created_at) VALUES(?,?,?,?)').run(id,type,message,new Date().toISOString());
  const blobOptions={access:'private',...(env.BLOB_READ_WRITE_TOKEN?{token:env.BLOB_READ_WRITE_TOKEN}:{})};
  const images={
    async write(name,bytes){await put('nuvexa/'+name,bytes,{...blobOptions,addRandomSuffix:false,allowOverwrite:true,contentType:name.endsWith('.png')?'image/png':'image/jpeg'});},
    async read(name){if(!/^[\w-]+\.(png|jpg)$/.test(name))throw new Error('Invalid image name');const r=await get('nuvexa/'+name,blobOptions);if(!r || r.statusCode!==200)throw new Error('الصورة غير متاحة.');return Buffer.from(await new Response(r.stream).arrayBuffer());}
  };
  return {db,settings,saveSettings,event,directory:providedImages || images,cloud:true,client};
}

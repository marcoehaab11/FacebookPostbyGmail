import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export function createStore(directory) {
  mkdirSync(directory, { recursive: true });
  const keyPath = join(directory, 'secret.key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const key = readFileSync(keyPath);
  const db = new DatabaseSync(join(directory, 'studio.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, dedup_key TEXT UNIQUE NOT NULL, source_id TEXT, source_post_id TEXT,
      brand TEXT, date TEXT, theme TEXT, caption TEXT NOT NULL, image TEXT, status TEXT NOT NULL DEFAULT 'pending',
      issue TEXT, page_id TEXT, photo_id TEXT, facebook_post_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS emails (id TEXT PRIMARY KEY, status TEXT, message TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT, type TEXT, message TEXT, created_at TEXT);`);
  if(!db.prepare('PRAGMA table_info(posts)').all().some(c=>c.name==='scheduled_at'))db.exec('ALTER TABLE posts ADD COLUMN scheduled_at TEXT');
  const encrypt = value => { const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',key,iv); const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64'); };
  const decrypt = value => { const b=Buffer.from(value,'base64'); const cipher=createDecipheriv('aes-256-gcm',key,b.subarray(0,12)); cipher.setAuthTag(b.subarray(12,28)); return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString()); };
  const defaults={mailbox:'nuvexars@gmail.com',allowedSender:'',pageId:'',apiVersion:'v21.0',clientId:'',clientSecret:'',facebookToken:'',autoSync:true};
  const settings=()=>({...defaults,...(db.prepare('SELECT value FROM settings WHERE id=1').get()?.value ? decrypt(db.prepare('SELECT value FROM settings WHERE id=1').get().value) : {})});
  const saveSettings=value=>db.prepare('INSERT INTO settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(encrypt(value));
  const event=(postId,type,message)=>db.prepare('INSERT INTO events(post_id,type,message,created_at) VALUES(?,?,?,?)').run(postId,type,message,new Date().toISOString());
  for(const p of db.prepare("SELECT id FROM posts WHERE status='scheduled' AND scheduled_at<=?").all(new Date().toISOString())){
    db.prepare("UPDATE posts SET status='missed' WHERE id=?").run(p.id);
    event(p.id,'schedule_missed','فات موعد النشر والبرنامج مغلق. اختر موعدًا جديدًا.');
  }
  // A process that died during an upload may already have created a Facebook post.
  db.prepare("UPDATE posts SET status='uncertain',issue='انقطع البرنامج أثناء النشر. راجع الصفحة قبل أي إعادة نشر.' WHERE status='publishing'").run();
  return {db,settings,saveSettings,event,directory};
}

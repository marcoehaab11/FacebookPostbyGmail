import { readFileSync,writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
const admin=JSON.parse(readFileSync('data/admin.json','utf8'));
const db=new DatabaseSync('data/studio.sqlite',{readOnly:true});
const env={APP_URL:'https://YOUR-PROJECT.vercel.app',TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:'',BLOB_READ_WRITE_TOKEN:'',ADMIN_EMAIL:admin.email,ADMIN_PASSWORD_HASH:admin.passwordHash,SESSION_SECRET:randomBytes(32).toString('hex'),SETTINGS_ENCRYPTION_KEY:readFileSync('data/secret.key').toString('base64'),INITIAL_SETTINGS_ENCRYPTED:db.prepare('SELECT value FROM settings WHERE id=1').get()?.value || '',CRON_SECRET:randomBytes(32).toString('hex')};
writeFileSync('.env.vercel.local',Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});db.close();
console.log('Created .env.vercel.local (ignored by Git). Fill APP_URL, Turso and private Blob configuration before importing into Vercel.');

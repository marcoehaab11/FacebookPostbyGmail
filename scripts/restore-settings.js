// The decryption key stays OFF GitHub. Copy your own data/secret.key privately first.
import { existsSync,readFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv } from 'node:crypto';
import { createStore } from '../lib/store.js';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const keyPath=join(root,'data','secret.key');
if(!existsSync(keyPath))throw new Error('Copy your original secret.key privately to data/secret.key first. Never upload it.');
const backup=JSON.parse(readFileSync(join(root,'backup','account-settings.encrypted.json'),'utf8'));
const b=Buffer.from(backup.ciphertext,'base64');
let settings;
try{const cipher=createDecipheriv('aes-256-gcm',readFileSync(keyPath),b.subarray(0,12));cipher.setAuthTag(b.subarray(12,28));settings=JSON.parse(Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString());}
catch{throw new Error('This secret.key does not match the encrypted backup. No settings were changed.');}
const store=createStore(join(root,'data'));store.saveSettings(settings);store.db.close();console.log('Encrypted account settings restored locally.');

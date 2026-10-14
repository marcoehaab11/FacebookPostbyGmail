import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCloudConfig } from '../lib/cloud-config.js';
test('cloud setup diagnostics list all missing field names without exposing values',()=>{
  try{validateCloudConfig({SESSION_SECRET:'private-value'});assert.fail('Must reject incomplete setup');}
  catch(e){assert.equal(e.code,'CLOUD_SETUP_MISSING');assert(e.missingVariables.includes('TURSO_DATABASE_URL'));assert(e.missingVariables.includes('ADMIN_PASSWORD_HASH'));assert(!JSON.stringify(e).includes('private-value'));}
});
test('cloud setup rejects a plaintext password in the hash field and malformed origin/key',()=>{
  const env={TURSO_DATABASE_URL:'libsql://example',TURSO_AUTH_TOKEN:'test',SETTINGS_ENCRYPTION_KEY:'bad',SESSION_SECRET:'a'.repeat(64),ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD_HASH:'plaintext-password',APP_URL:'https://example.com/auth/callback',CRON_SECRET:'b'.repeat(64),BLOB_READ_WRITE_TOKEN:'test'};
  assert.throws(()=>validateCloudConfig(env),e=>e.code==='CLOUD_SETUP_INVALID' && e.invalidVariables.includes('ADMIN_PASSWORD_HASH') && e.invalidVariables.includes('APP_URL') && e.invalidVariables.includes('SETTINGS_ENCRYPTION_KEY'));
});

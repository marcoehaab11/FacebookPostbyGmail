export function validateCloudConfig(env) {
  const required=['TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','SETTINGS_ENCRYPTION_KEY','SESSION_SECRET','ADMIN_EMAIL','ADMIN_PASSWORD_HASH','APP_URL','CRON_SECRET'];
  const missingVariables=required.filter(name=>!String(env[name] || '').trim());
  if(!env.BLOB_READ_WRITE_TOKEN && !env.BLOB_STORE_ID)missingVariables.push('BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID)');
  if(missingVariables.length){const e=new Error('Missing cloud configuration');e.code='CLOUD_SETUP_MISSING';e.missingVariables=missingVariables;throw e;}
  const invalidVariables=[];
  try{const url=new URL(env.APP_URL);if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)invalidVariables.push('APP_URL');}catch{invalidVariables.push('APP_URL');}
  if(Buffer.from(env.SETTINGS_ENCRYPTION_KEY,'base64').length!==32)invalidVariables.push('SETTINGS_ENCRYPTION_KEY');
  for(const name of ['SESSION_SECRET','CRON_SECRET'])if(env[name].length<32)invalidVariables.push(name);
  if(!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(env.ADMIN_PASSWORD_HASH))invalidVariables.push('ADMIN_PASSWORD_HASH');
  if(invalidVariables.length){const e=new Error('Invalid cloud configuration');e.code='CLOUD_SETUP_INVALID';e.invalidVariables=invalidVariables;throw e;}
}

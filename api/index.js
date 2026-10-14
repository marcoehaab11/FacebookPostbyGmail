import { createCloudStore } from '../lib/cloud-store.js';
import { createApp } from '../server.js';

let initialized;
async function initialize(){
  const store=await createCloudStore();
  return createApp({providedStore:store,appUrl:process.env.APP_URL,authConfig:{email:process.env.ADMIN_EMAIL,passwordHash:process.env.ADMIN_PASSWORD_HASH,sessionSecret:process.env.SESSION_SECRET}}).app;
}
export default async function handler(req,res){
  try{
    initialized ||= initialize().catch(e=>{initialized=null;throw e;});
    const app=await initialized;return app(req,res);
  }catch(e){
    // Report field names only: never return connection strings, secret values,
    // upstream error messages or stack traces to unauthenticated visitors.
    console.error('Cloud initialization failed',{code:e.code || 'INITIALIZATION_FAILED',missingVariables:e.missingVariables || [],invalidVariables:e.invalidVariables || []});
    res.statusCode=503;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    res.end(JSON.stringify({error:e.missingVariables?'أضف متغيرات البيئة الناقصة في Vercel ثم اعمل Redeploy.':e.invalidVariables?'صحّح متغيرات البيئة المذكورة ثم اعمل Redeploy.':'تعذر الاتصال بقاعدة البيانات أو بدء الخادم. راجع Runtime Logs في Vercel.',...(e.missingVariables?{missing_variables:e.missingVariables}:{}),...(e.invalidVariables?{invalid_variables:e.invalidVariables}:{}),setup_guide:'https://github.com/marcoehaab11/FacebookPostbyGmail/blob/master/VERCEL-SETUP.md'}));
  }
}

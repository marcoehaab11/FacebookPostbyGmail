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
  }catch{
    res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'إعدادات الاستضافة غير مكتملة. راجع متغيرات البيئة والتخزين.'}));
  }
}

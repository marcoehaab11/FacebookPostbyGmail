import { randomBytes,createHmac,timingSafeEqual,scryptSync,createHash } from 'node:crypto';

export function hashPassword(password){const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');}
export function checkPassword(password,encoded){
  const [salt,hash]=String(encoded || '').split(':');if(!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(hash || ''))return false;
  const actual=scryptSync(String(password).slice(0,256),salt,64),expected=Buffer.from(hash,'hex');return timingSafeEqual(actual,expected);
}
export function authSystem({store,config,baseUrl}) {
  const secret=config.sessionSecret;if(!secret || secret.length<32 || !config.passwordHash || !config.email)throw new Error('Configure administrator login before starting.');
  const secure=baseUrl.startsWith('https:'),cookieName=secure?'__Host-nuvexa':'nuvexa';
  const sign=text=>createHmac('sha256',secret+config.passwordHash).update(text).digest('base64url');
  const encode=value=>{const text=Buffer.from(JSON.stringify(value)).toString('base64url');return text+'.'+sign(text);};
  const read=req=>{try{const token=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);if(!token || token.length>2048)return null;const [text,signature]=token.split('.'),expected=sign(text);if(signature?.length!==expected.length || !timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return null;const s=JSON.parse(Buffer.from(text,'base64url').toString());return s.exp>Date.now()?s:null;}catch{return null;}};
  const issue=(res,loggedIn)=>{const session={loggedIn,id:randomBytes(24).toString('hex'),csrf:randomBytes(32).toString('hex'),exp:Date.now()+8*3600000};res.setHeader('Set-Cookie',`${cookieName}=${encode(session)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure?'; Secure':''}`);return session;};
  const clear=res=>res.setHeader('Set-Cookie',`${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure?'; Secure':''}`);
  async function login(req,res){
    const ip=secure?String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0]:req.socket.remoteAddress;
    const id=createHash('sha256').update('login:'+ip).digest('hex'),now=Date.now();
    const attempt=await store.db.prepare(`INSERT INTO login_attempts(id,count,expires) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END RETURNING count`).get(id,now+15*60000,now,now);
    if(attempt.count>10)return res.status(429).json({error:'محاولات كثيرة. انتظر ١٥ دقيقة.'});
    if(String(req.body.email || '').trim().toLowerCase()!==config.email.toLowerCase() || !checkPassword(req.body.password,config.passwordHash))return res.status(401).json({error:'الإيميل أو كلمة المرور غير صحيحة.'});
    await store.db.prepare('DELETE FROM login_attempts WHERE id=?').run(id);
    await store.db.prepare('DELETE FROM auth_sessions WHERE expires<?').run(now);
    const session=issue(res,true);await store.db.prepare('INSERT INTO auth_sessions VALUES(?,?)').run(session.id,session.exp);res.json({ok:true});
  }
  const validate=async session=>!session?.loggedIn || !!(await store.db.prepare('SELECT id FROM auth_sessions WHERE id=? AND expires>?').get(session.id,Date.now()));
  const logout=async(req,res)=>{if(req.session?.id)await store.db.prepare('DELETE FROM auth_sessions WHERE id=?').run(req.session.id);clear(res);};
  return {read,issue,clear,login,validate,logout};
}

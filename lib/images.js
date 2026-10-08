import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_IMAGE=8*1024*1024;
export function publicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a,b]=ip.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && b===168) || (a===100 && b>=64 && b<=127) || (a===198 && (b===18 || b===19)));
  }
  // Only globally routable IPv6 unicast; IPv4-mapped and local ranges fail closed.
  return isIP(ip) === 6 && /^[23][0-9a-f]{3}:/i.test(ip);
}
const agent=new Agent({connect:{lookup(host,options,callback){
  lookup(host,{all:true}).then(addresses=>{
    if (!addresses.length || addresses.some(a=>!publicAddress(a.address))) return callback(new Error('لا يمكن تحميل صورة من شبكة داخلية.'));
    if (options.all) callback(null,addresses); else callback(null,addresses[0].address,addresses[0].family);
  }).catch(callback);
}}});
export function normalizeUrl(value) {
  const u=new URL(value);
  if(['www.google.com','google.com'].includes(u.hostname) && u.pathname==='/url') {
    const target=u.searchParams.get('q') || u.searchParams.get('url');
    if(!target || !target.startsWith('https://drive.google.com/'))throw new Error('رابط إعادة توجيه غير صالح.');
    return normalizeUrl(target);
  }
  if(u.protocol!=='https:' || u.username || u.password || (u.port && u.port!=='443')) throw new Error('استخدم رابط HTTPS عام للصورة.');
  if(isIP(u.hostname.replace(/^\[|\]$/g,'')) && !publicAddress(u.hostname.replace(/^\[|\]$/g,''))) throw new Error('رابط شبكة داخلية غير مسموح.');
  if(u.hostname==='drive.google.com') {
    const id=u.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] || u.searchParams.get('id');
    if(!id || !/^[\w-]+$/.test(id)) throw new Error('استخدم رابط ملف Google Drive وليس مجلدًا.');
    const direct=new URL('https://drive.google.com/uc'); direct.searchParams.set('export','download');direct.searchParams.set('id',id);
    if(u.searchParams.get('resourcekey')) direct.searchParams.set('resourcekey',u.searchParams.get('resourcekey'));
    return direct.href;
  }
  return u.href;
}
export async function downloadImage(value) {
  let url=normalizeUrl(value);
  const signal=AbortSignal.timeout(45000);
  for(let redirects=0;redirects<6;redirects++) {
    const r=await fetch(url,{dispatcher:agent,redirect:'manual',signal});
    if([301,302,303,307,308].includes(r.status)) {const location=r.headers.get('location');await r.body?.cancel();if(!location)throw new Error('تحويل صورة غير صالح.');url=normalizeUrl(new URL(location,url).href);continue;}
    if(!r.ok){await r.body?.cancel();throw new Error('تعذر تحميل الصورة: HTTP '+r.status);}
    if(Number(r.headers.get('content-length'))>MAX_IMAGE){await r.body?.cancel();throw new Error('الصورة أكبر من 8 ميجابايت.');}
    const chunks=[];let size=0;
    for await(const part of r.body) {size+=part.length;if(size>MAX_IMAGE){await r.body.cancel().catch(()=>{});throw new Error('الصورة أكبر من 8 ميجابايت.');}chunks.push(part);}
    return Buffer.concat(chunks);
  }
  throw new Error('تحويلات كثيرة في رابط الصورة.');
}
export async function saveImage(buffer,directory) {
  if(!buffer?.length || buffer.length>MAX_IMAGE) throw new Error('الصورة مطلوبة وبحد أقصى 8 ميجابايت.');
  let decoded,output,extension;
  try {
    if(buffer.length>24 && buffer.subarray(0,8).toString('hex')==='89504e470d0a1a0a') {
      if(buffer.readUInt32BE(16)*buffer.readUInt32BE(20)>10000000)throw new Error('Too many pixels');
      decoded=PNG.sync.read(buffer,{checkCRC:true});
      // Re-encoding strips metadata while preserving PNG transparency.
      output=PNG.sync.write(decoded);extension='png';
    }else if(buffer[0]===255 && buffer[1]===216) {
      decoded=jpeg.decode(buffer,{useTArray:true,maxResolutionInMP:10,maxMemoryUsageInMB:128,tolerantDecoding:false});
      output=Buffer.from(jpeg.encode(decoded,90).data);extension='jpg';
    }else throw new Error('Wrong format');
    if(!decoded.width || !decoded.height || decoded.width*decoded.height>10000000 || output.length>MAX_IMAGE)throw new Error('Image limit');
  }catch{throw new Error('اختر صورة JPG أو PNG صالحة، بحد أقصى 8 ميجابايت و10 مليون بكسل.');}
  const filename=randomUUID()+'.'+extension;await mkdir(join(directory,'images'),{recursive:true});await writeFile(join(directory,'images',filename),output);
  return filename;
}
export const imageBuffer=(directory,name)=>readFile(join(directory,'images',name));

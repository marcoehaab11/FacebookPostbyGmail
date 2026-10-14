import { hashPassword } from '../lib/auth.js';
import { mkdirSync,writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
let input='';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
console.log('Ready for administrator JSON on hidden stdin.');
process.stdin.on('data',chunk=>{
  input+=chunk;if(!/[\r\n]/.test(input))return;
  const {email,password}=JSON.parse(input.trim());input='';
  if(!email || !password || password.length<8)throw new Error('Email and password (8+ characters) required');
  mkdirSync('data',{recursive:true});
  writeFileSync('data/admin.json',JSON.stringify({email,passwordHash:hashPassword(password),sessionSecret:randomBytes(32).toString('hex')})+'\n',{mode:0o600});
  console.log('Administrator configured. Password stored as a salted scrypt hash.');process.exit(0);
});

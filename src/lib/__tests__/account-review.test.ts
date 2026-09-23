import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as passwords from '../passwords';
import { acceptInvite, signIn } from '../accounts';
import { authMode, createSession, sessionCookieName } from '../auth';
import { db, resetDbForTests } from '../db';
import { GET as usersGET } from '../../app/api/users/route';

const dir=mkdtempSync(join(tmpdir(),'berth-independent-review-'));
let serial=0;
beforeEach(async()=>{
 resetDbForTests(`file:${join(dir,`${++serial}.db`)}`);
 vi.stubEnv('NODE_ENV','production');
 vi.stubEnv('APP_ORIGIN','https://berth.example');
 vi.stubEnv('DEV_OPEN_WRITES','');
 await (await db()).execute({sql:'INSERT INTO users (email,name,role,password_hash,created_at) VALUES (?,?,?,?,?)',args:['admin@example.org','Admin','admin','original-hash',Date.now()]});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(()=>rmSync(dir,{recursive:true,force:true}));

it('admin browser GET without Origin can list people; anonymous GET cannot',async()=>{
 const token=await createSession(1);
 const r=await usersGET(new Request('https://berth.example/api/users',{headers:{Cookie:`${sessionCookieName(authMode())}=${token}`}}));
 expect(r.status).toBe(200);
 expect((await r.json()).people).toHaveLength(1);
 expect((await usersGET(new Request('https://berth.example/api/users'))).status).toBe(401);
});

it('a password reset during password verification prevents old-password sign-in',async()=>{
 vi.spyOn(passwords,'verifyPassword').mockImplementationOnce(async()=>{
  await (await db()).execute("UPDATE users SET password_hash='new-hash' WHERE id=1");
  return true;
 });
 await expect(signIn('admin@example.org','previous-password')).rejects.toMatchObject({status:401});
 expect((await (await db()).execute('SELECT * FROM user_sessions')).rows).toHaveLength(0);
});

it('revocation during verification cannot create a session that revives on restoration',async()=>{
 vi.spyOn(passwords,'verifyPassword').mockImplementationOnce(async()=>{
  await (await db()).execute('UPDATE users SET disabled_at=1 WHERE id=1');
  return true;
 });
 await expect(signIn('admin@example.org','previous-password')).rejects.toMatchObject({status:401});
 expect((await (await db()).execute('SELECT * FROM user_sessions')).rows).toHaveLength(0);
});

it('invalid invitation tokens never trigger expensive password hashing',async()=>{
 const hash=vi.spyOn(passwords,'hashPassword');
 await expect(acceptInvite({token:'not-a-real-invitation',name:'Nobody',password:'sufficiently-long-password'})).rejects.toMatchObject({status:410});
 expect(hash).not.toHaveBeenCalled();
});

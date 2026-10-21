import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRedisStore } from '../src/redis-store.js';

function mockRedis() {
  let stored=null;
  const fetchImpl=async(_url, options)=>{
    assert.match(options.headers.Authorization,/^Bearer /);
    const parts=JSON.parse(options.body);
    if(parts[0]==='GET') return {ok:true,json:async()=>({result:stored})};
    assert.equal(parts[0],'EVAL');
    const expected=parts[4], next=parts[5];
    if((stored??'')!==expected) return {ok:true,json:async()=>({result:0})};
    stored=next;
    return {ok:true,json:async()=>({result:1})};
  };
  return {fetchImpl,raw:()=>stored};
}

test('Redis store encrypts sensitive state and preserves concurrent updates',async()=>{
  const fake=mockRedis(),key=randomBytes(32);
  const opts={url:'https://example.upstash.io',token:'private-test-token',key,fetchImpl:fake.fetchImpl};
  const first=createRedisStore(opts), second=createRedisStore(opts);
  assert.equal((await first.get()).schema,1);
  const jobs=Array.from({length:8},(_,i)=>(i%2?first:second).mutate(s=>{
    s.profile.test_counter=(s.profile.test_counter||0)+1;
  }));
  await Promise.all(jobs);
  assert.equal((await first.get()).profile.test_counter,8);
  await first.mutate(s=>{s.travelers.me={given_name:'DO NOT EXPOSE'};});
  assert.doesNotMatch(fake.raw(),/DO NOT EXPOSE|given_name/);
  assert.equal((await second.get()).travelers.me.given_name,'DO NOT EXPOSE');
  const wrong=createRedisStore({...opts,key:randomBytes(32)});
  await assert.rejects(wrong.get());
});

test('remote failure cannot silently replace the existing vault',async()=>{
  const store=createRedisStore({url:'https://example.upstash.io',token:'private',key:randomBytes(32),
    fetchImpl:async()=>({ok:false,json:async()=>({error:'unavailable'})})});
  await assert.rejects(store.get(),/unavailable/);
  await assert.rejects(store.mutate(s=>{s.watches.any={};}),/unavailable/);
});

test('write conflicts retry against the latest ciphertext',async()=>{
  const fake=mockRedis(),opts={url:'https://example.upstash.io',token:'private',key:randomBytes(32),fetchImpl:fake.fetchImpl};
  const left=createRedisStore(opts),right=createRedisStore(opts);
  const values=await Promise.all([left.mutate(s=>{s.profile.test_counter=1;return 'left';}),
    right.mutate(s=>{s.profile.mode='fastest';return 'right';})]);
  assert.deepEqual(values.sort(),['left','right']);
  assert.equal((await left.get()).profile.test_counter,1);
  assert.equal((await right.get()).profile.mode,'fastest');
});

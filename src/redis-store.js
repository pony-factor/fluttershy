import { decrypt, encrypt, initialState } from './store.js';
// CAS is executed atomically within Redis and prevents lost updates.
const CAS = `local old=redis.call('GET', KEYS[1])
if (old or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

export function createRedisStore({url,token,key,keyName='fluttershy:state:v1',fetchImpl=fetch}) {
  if(!url || !/^https:\/\//.test(url) || !token) throw new Error('Upstash Redis HTTPS URL and token are required');
  if(!key || key.length!==32) throw new Error('A 32-byte encryption key is required');
  const endpoint=url.replace(/\/+$/,'');
  async function command(parts) {
    const response=await fetchImpl(endpoint,{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify(parts),cache:'no-store',signal:AbortSignal.timeout(15000)
    });
    if(!response.ok) throw new Error('Persistent store unavailable');
    const value=await response.json();
    if(value.error || !Object.hasOwn(value,'result')) throw new Error('Persistent store command failed');
    return value.result;
  }
  async function readRaw() {return await command(['GET',keyName]);}
  function decode(raw) {
    if(raw===null) return initialState();
    const state=decrypt(JSON.parse(raw),key);
    if(state.schema!==1)throw new Error('Unsupported database schema');
    state.award_cache ||= {};
    return state;
  }
  return {
    async get() {return structuredClone(decode(await readRaw()));},
    async mutate(fn) {
      for(let attempt=0;attempt<24;attempt++) {
        const raw=await readRaw(),next=structuredClone(decode(raw));
        const result=fn(next),ciphertext=JSON.stringify(encrypt(next,key));
        if(await command(['EVAL',CAS,1,keyName,raw??'',ciphertext])===1) return result;
        await new Promise(resolve=>setTimeout(resolve,Math.min(20+attempt*8,120)));
      }
      throw new Error('Too much concurrent activity; retry the request');
    }
  };
}

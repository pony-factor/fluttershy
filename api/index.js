import { createApplication } from '../src/app.js';
import { createRedisStore } from '../src/redis-store.js';
import { encryptionKey } from '../src/store.js';
import { createDuffel } from '../src/duffel.js';
import { createSeatsAero } from '../src/seats.js';
let cached;
function application() {
  if(cached) return cached;
  const env=process.env;
  for(const name of ['DATA_ENCRYPTION_KEY','API_TOKEN','DUFFEL_ACCESS_TOKEN','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','CRON_SECRET']) {
    if(!env[name] || env[name].startsWith('REPLACE_')) throw new Error('Missing required hosted configuration');
  }
  if(env.API_TOKEN.length<40 || env.CRON_SECRET.length<24 || env.API_TOKEN===env.CRON_SECRET)
    throw new Error('Unsafe hosted authentication configuration');
  cached=createApplication({
    store:createRedisStore({url:env.UPSTASH_REDIS_REST_URL,token:env.UPSTASH_REDIS_REST_TOKEN,
      key:encryptionKey(env.DATA_ENCRYPTION_KEY),keyName:env.REDIS_STATE_KEY||'fluttershy:state:v1'}),
    duffel:createDuffel({token:env.DUFFEL_ACCESS_TOKEN}),
    seats:createSeatsAero({key:env.SEATS_AERO_API_KEY}),
    apiToken:env.API_TOKEN,
    enableLiveBooking:env.ENABLE_LIVE_BOOKING==='true' && env.ALLOW_HOSTED_BOOKING==='true',
    enablePoller:false,
    watchIntervalMinutes:1380
  });
  return cached;
}
export default async function handler(req,res) {
  try {return await application().handle(req,res);}
  catch {
    res.statusCode=503;
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    res.end(JSON.stringify({error:'Fluttershy is not configured for hosting'}));
  }
}

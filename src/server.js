import { createApplication, httpServer } from './app.js';
import { createStore, encryptionKey } from './store.js';
import { createDuffel } from './duffel.js';
const env = process.env;
try {
  const app=createApplication({
    store:createStore({file:env.DATA_FILE || './data/private.enc.json',key:encryptionKey(env.DATA_ENCRYPTION_KEY)}),
    duffel:createDuffel({token:env.DUFFEL_ACCESS_TOKEN}),apiToken:env.API_TOKEN,
    enableLiveBooking:env.ENABLE_LIVE_BOOKING === 'true',
    watchIntervalMinutes:Math.max(30,Number(env.WATCH_POLL_MINUTES)||30)
  });
  const host=env.HOST||'127.0.0.1',port=Number(env.PORT)||3434;
  const server=httpServer(app);
  server.listen(port,host,()=>console.log(`Fluttershy listening on http://${host}:${port} (booking ${env.ENABLE_LIVE_BOOKING==='true'?'enabled':'disabled'})`));
  process.on('SIGTERM',()=>{app.close();server.close();});
} catch (err) {console.error(err.message);process.exitCode=1;}

import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { InputError, assert, ident, searchInput, profileInput, travelerInput, paymentTokenInput, airlineCode, text, number } from './validation.js';
import { flattenOffer, rankOffers, allowed, compareAwards } from './ranking.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)),'..','public');
const staticPaths = new Map([['/','index.html'],['/app.js','app.js'],['/style.css','style.css']]);
const mime = {'index.html':'text/html; charset=utf-8','app.js':'text/javascript; charset=utf-8','style.css':'text/css; charset=utf-8'};
const TTL = 5*60*1000;
function mask(n) { return n ? `••••${n.slice(-4)}` : null; }
function fingerprint(value) {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function escapeIcs(value) {return String(value ?? '').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');}
function icsBooking(booking) {
  // Duffel segment timestamps may be in airport-local time without UTC offsets.
  // Export date-only events instead of assigning the wrong timezone to flights.
  const stamp=new Date(booking.attempted_at).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Fluttershy//Flight Itinerary//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  (booking.legs||[]).forEach((leg,i)=>{
    const iso=leg.segments?.[0]?.departing_at?.slice(0,10);
    if(!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
    const start=iso.replace(/-/g,'');
    const end=new Date(Date.parse(`${iso}T12:00:00Z`)+86400000).toISOString().slice(0,10).replace(/-/g,'');
    const details=(leg.segments||[]).map(s=>`${s.operating_carrier} ${s.flight_number||''} ${s.origin}-${s.destination}: ${s.departing_at||''} to ${s.arriving_at||''}`);
    lines.push('BEGIN:VEVENT',`UID:${booking.quote_id}-${i}@fluttershy.local`,`DTSTAMP:${stamp}`,`DTSTART;VALUE=DATE:${start}`,`DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${escapeIcs(`Flight ${leg.origin} → ${leg.destination}`)}`,
      `DESCRIPTION:${escapeIcs(`Booking reference ${booking.booking_reference}. Local times: ${details.join(' | ')}. Verify times with airline.`)}`,'END:VEVENT');
  });
  return lines.concat('END:VCALENDAR','').join('\r\n');
}
function publicTraveler(t) { return {...t, loyalty_accounts:t.loyalty_accounts.map(a=>({...a,account_number:mask(a.account_number)}))}; }
function safeView(s) { return {
  profile:s.profile,travelers:Object.fromEntries(Object.entries(s.travelers).map(([id,t])=>[id,publicTraveler(t)])),
  payment_tokens:Object.fromEntries(Object.entries(s.payment_tokens).map(([id,p])=>[id,{provider:p.provider,label:p.label,last4:p.last4}])) ,
  accounts:Object.fromEntries(Object.entries(s.accounts).map(([id,a])=>[id,{provider:a.provider,label:a.label,connected:false}])),
  watches:s.watches, awards:s.awards,bookings:s.bookings
}; }
function send(res,status,data) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function errorResponse(res,e) {send(res,e.status || 500,{error:e instanceof InputError ? e.message : 'Internal error'});}
function secureEqual(a,b) {
  const x=Buffer.from(a || ''); const y=Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x,y);
}
async function body(req) {
  if(req.body !== undefined) {
    try {
      const parsed=typeof req.body==='string' ? JSON.parse(req.body) : req.body;
      if(Buffer.byteLength(JSON.stringify(parsed))>32_768) throw new InputError('Request exceeds 32 KB',413);
      return parsed;
    } catch(e) {if(e instanceof InputError)throw e;throw new InputError('Expected JSON body');}
  }
  let length=0, chunks=[];
  for await(const chunk of req) { length+=chunk.length; if(length>32_768) throw new InputError('Request exceeds 32 KB',413); chunks.push(chunk); }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new InputError('Expected JSON body');}
}
function findAward(v) {
  assert(v && typeof v==='object' && !Array.isArray(v), 'Expected award quote');
  const airline_codes=(v.airline_codes || []).map(airlineCode);
  assert(airline_codes.length<=10, 'Too many airlines');
  const outbound=searchInput({...v.trip,adults:1});
  return {id:randomUUID(),kind:'award',airline_codes,route:`${outbound.origin}-${outbound.destination}`,
    departure_date:outbound.departure_date,miles:number(v.miles,'miles',1,1e7), taxes_usd:number(v.taxes_usd,'taxes_usd',0,100000),
    program:text(v.program,'program',60), notes:v.notes ? text(v.notes,'notes',160) : '',stops:number(v.stops ?? 0,'stops',0,10),
    duration_minutes:number(v.duration_minutes ?? 0,'duration_minutes',0,10000), imported_at:new Date().toISOString()};
}
export function createApplication({store,duffel,seats=null,apiToken,enableLiveBooking=false,watchIntervalMinutes=30,enablePoller=true,now=()=>Date.now()}) {
  assert(typeof apiToken==='string' && apiToken.length>=24,'API_TOKEN must contain at least 24 characters',500);
  const inflight = new Map();
  async function readState() {return store.get();}
  async function search(query,{force=false}={}) {
    const q=searchInput(query), key=JSON.stringify(q), s=(await readState());
    const cached=s.cache[key];
    if(!force && cached && now()-cached.fetched_at<TTL) return {...cached,cached:true,offers:rankOffers(cached.offers,s.profile)};
    if(inflight.has(key)) return inflight.get(key);
    const task=(async()=>{
      const data=await duffel.search(q);
      const offers=(data.offers||[]).slice(0,300).map(flattenOffer).filter(o=>Number.isFinite(o.amount)&&o.amount>=0);
      const result={query:q,provider:'duffel',offer_request_id:data.id,fetched_at:now(),offers};
      await store.mutate(s=>{s.cache[key]=result;const keys=Object.keys(s.cache).sort((a,b)=>s.cache[b].fetched_at-s.cache[a].fetched_at);
        for(const k of keys.slice(30)) delete s.cache[k];});
      return {...result,cached:false,offers:rankOffers(offers,(await readState()).profile)};
    })();
    inflight.set(key,task);try{return await task;}finally{inflight.delete(key);}
  }
  async function refreshWatch(id) {
    const item=(await readState()).watches[id]; assert(item,'Watch not found',404);
    try {
      const result=await search(item.query,{force:true});
      await store.mutate(s=>{const w=s.watches[id];if(!w)return;
        w.last_checked=now();w.last_error=null;w.last_matches=result.offers.filter(o=>o.currency===w.currency && o.amount<=w.max_price).slice(0,15);
        w.cheapest=result.offers.find(o=>o.currency===w.currency)?.amount ?? null;});
    } catch(e) {await store.mutate(s=>{if(s.watches[id]){s.watches[id].last_checked=now();s.watches[id].last_error=e instanceof InputError?e.message:'Search failed';}});}
    return (await readState()).watches[id] || null;
  }
  let running=false;
  async function pollWatches() {
    if(running) return {checked:0,skipped:true};
    running=true;let checked=0;
    try {
      const entries=Object.entries((await readState()).watches);
      for(const [id] of entries) {
        const claimed=await store.mutate(s=>{
          const w=s.watches[id];
          if(!w || now()-(w.last_checked||0)<watchIntervalMinutes*60_000 ||
             now()-(w.last_started||0)<10*60_000) return false;
          w.last_started=now();return true;
        });
        if(claimed) {await refreshWatch(id);checked++;}
      }
      return {checked,total:entries.length};
    } finally {running=false;}
  }
  const timer=enablePoller ? setInterval(()=>{void pollWatches();},Math.max(watchIntervalMinutes,1)*60_000) : null;
  timer?.unref();
  function close(){if(timer)clearInterval(timer);}
  async function handle(req,res) {
    try {
      const url = new URL(req.url,'http://localhost');
      res.setHeader('X-Frame-Options','DENY');
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      if(req.method==='GET' && staticPaths.has(url.pathname)) {
        const file=staticPaths.get(url.pathname);res.writeHead(200,{'Content-Type':mime[file],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        res.end(await readFile(join(publicDir,file)));return;
      }
      if(!url.pathname.startsWith('/api/')) throw new InputError('Not found',404);
      if(req.method==='GET' && url.pathname==='/api/cron') {
        const secret=process.env.CRON_SECRET;
        if(!secret || secret.length<24 || !secureEqual(req.headers.authorization||'',`Bearer ${secret}`))
          throw new InputError('Unauthorized',401);
        return send(res,200,await pollWatches());
      }
      if(!secureEqual((req.headers.authorization || '').replace(/^Bearer /,''),apiToken)) throw new InputError('Unauthorized',401);
      const path=url.pathname;
      let m;
      if(req.method==='GET' && path==='/api/health') return send(res,200,{status:'ok',duffel_configured:!!process.env.DUFFEL_ACCESS_TOKEN,seats_aero_configured:!!seats?.configured,live_booking_enabled:enableLiveBooking});
      if(req.method==='GET' && path==='/api/state') return send(res,200,safeView((await readState())));
      if(req.method==='GET' && (m=/^\/api\/bookings\/([a-zA-Z0-9_-]+)\/calendar\.ics$/.exec(path))) {
        const booking=(await readState()).bookings[m[1]];
        assert(booking?.status==='confirmed','Confirmed booking not found',404);
        res.writeHead(200,{'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'attachment; filename="fluttershy-trip.ics"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        res.end(icsBooking(booking));return;
      }
      if(req.method==='PUT' && path==='/api/profile') {
        const p=profileInput(await body(req));await store.mutate(s=>{s.profile=p;});return send(res,200,p);
      }
      if(req.method==='PUT' && (m=/^\/api\/travelers\/([a-zA-Z0-9_-]+)$/.exec(path))) {
        const id=ident(m[1]),v=travelerInput(await body(req));await store.mutate(s=>{s.travelers[id]=v;});return send(res,200,publicTraveler(v));
      }
      if(req.method==='DELETE' && (m=/^\/api\/travelers\/([a-zA-Z0-9_-]+)$/.exec(path))) {
        await store.mutate(s=>{delete s.travelers[m[1]];});return send(res,200,{deleted:true});
      }
      if(req.method==='PUT' && (m=/^\/api\/payment-tokens\/([a-zA-Z0-9_-]+)$/.exec(path))) {
        const id=ident(m[1]),v=paymentTokenInput(await body(req));await store.mutate(s=>{s.payment_tokens[id]=v;});
        return send(res,200,{provider:v.provider,label:v.label,last4:v.last4,bookable_here:false});
      }
      if(req.method==='DELETE' && (m=/^\/api\/payment-tokens\/([a-zA-Z0-9_-]+)$/.exec(path))) {
        await store.mutate(s=>{delete s.payment_tokens[m[1]];});return send(res,200,{deleted:true});
      }
      if(req.method==='PUT' && (m=/^\/api\/accounts\/([a-zA-Z0-9_-]+)$/.exec(path))) {
        const id=ident(m[1]),v=await body(req);
        assert(v && Object.keys(v).every(k=>['provider','label','token_reference'].includes(k)), 'Only external token references can be saved; no passwords');
        const account={provider:text(v.provider,'provider',60),label:text(v.label,'label',60),token_reference:text(v.token_reference,'token_reference',300)};
        await store.mutate(s=>{s.accounts[id]=account;});return send(res,200,{provider:account.provider,label:account.label,connected:false});
      }
      if(req.method==='DELETE' && (m=/^\/api\/accounts\/([a-zA-Z0-9_-]+)$/.exec(path))) {
        await store.mutate(s=>{delete s.accounts[m[1]];});return send(res,200,{deleted:true});
      }
      if(req.method==='POST' && path==='/api/search') return send(res,200,await search(await body(req)));
      if(req.method==='POST' && path==='/api/award-search') {
        assert(seats?.configured,'Award search provider not configured; add SEATS_AERO_API_KEY',503);
        const q=searchInput(await body(req));
        assert(q.adults===1 && !q.return_date,'Award lookup currently supports one adult and one-way travel',400);
        const key=JSON.stringify(q),cache=(await readState()).award_cache[key];
        if(cache && now()-cache.fetched_at<30*60_000)
          return send(res,200,{...cache,offers:compareAwards([],rankOffers(cache.offers,(await readState()).profile),(await readState()).profile),cached:true});
        const result=await seats.search(q);
        await store.mutate(s=>{
          s.award_cache[key]={...result,fetched_at:now()};
          const keys=Object.keys(s.award_cache).sort((a,b)=>s.award_cache[b].fetched_at-s.award_cache[a].fetched_at);
          for(const k of keys.slice(30))delete s.award_cache[k];
        });
        return send(res,200,{...result,offers:compareAwards([],rankOffers(result.offers,(await readState()).profile),(await readState()).profile),cached:false});
      }
      if(req.method==='POST' && path==='/api/awards') {
        const a=findAward(await body(req));await store.mutate(s=>{s.awards[a.id]=a;});return send(res,201,a);
      }
      if(req.method==='GET' && path==='/api/compare') {
        const trip=searchInput({origin:url.searchParams.get('origin'),destination:url.searchParams.get('destination'),departure_date:url.searchParams.get('departure_date')});
        const s=(await readState()),awards=Object.values(s.awards).filter(a=>a.route===`${trip.origin}-${trip.destination}`&&a.departure_date===trip.departure_date);
        const cash=Object.values(s.cache).filter(c=>c.query.origin===trip.origin&&c.query.destination===trip.destination&&c.query.departure_date===trip.departure_date&&c.query.adults===1&&!c.query.return_date).flatMap(c=>c.offers);
        const found=Object.values(s.award_cache||{}).filter(c=>c.query.origin===trip.origin&&c.query.destination===trip.destination&&c.query.departure_date===trip.departure_date).flatMap(c=>c.offers);
        return send(res,200,{awards:compareAwards(cash,rankOffers([...awards,...found],s.profile),s.profile),cash_cheapest_usd:rankOffers(cash.filter(o=>o.currency==='USD'),s.profile)[0]||null});
      }
      if(req.method==='POST' && path==='/api/watches') {
        const v=await body(req),q=searchInput(v.query),max_price=number(v.max_price,'max_price',1,100000);
        const currency=text(v.currency||'USD','currency',3).toUpperCase();assert(/^[A-Z]{3}$/.test(currency),'Invalid currency');
        // Watch limits are enforced atomically below.
        const id=randomUUID(),w={id,query:q,max_price,currency,created_at:now(),last_checked:0,last_matches:[],cheapest:null,last_error:null};
        await store.mutate(s=>{assert(Object.keys(s.watches).length<30,'Watch limit reached',429);s.watches[id]=w;});
        return send(res,201,await refreshWatch(id));
      }
      if(req.method==='POST' && (m=/^\/api\/watches\/([a-zA-Z0-9_-]+)\/refresh$/.exec(path))) return send(res,200,await refreshWatch(m[1]));
      if(req.method==='DELETE' && (m=/^\/api\/watches\/([a-zA-Z0-9_-]+)$/.exec(path))) {
        await store.mutate(s=>{delete s.watches[m[1]];});return send(res,200,{deleted:true});
      }
      if(req.method==='POST' && path==='/api/bookings/quote') {
        const v=await body(req),offerId=ident(v.offer_id),ids=v.traveler_ids;
        assert(Array.isArray(ids) && ids.length>=1 && ids.length<=6 && new Set(ids).size===ids.length,'Provide unique traveler_ids');
        const s=(await readState()),ts=ids.map(id=>s.travelers[ident(id)]);
        assert(ts.every(Boolean),'Missing saved traveler',404);
        let offer=await duffel.offer(offerId);
        assert(offer.passengers?.length===ts.length,'Selected offer passenger count differs',409);
        assert(offer.expires_at && Date.parse(offer.expires_at)>now()+60_000,'Offer expired or too close to expiration',409);
        assert(allowed(flattenOffer(offer),s.profile),'Offer violates airline or trip preferences',409);
        // Updating loyalty can alter price. Refetch before presenting the final quote.
        for(let i=0;i<ts.length;i++) if(ts[i].loyalty_accounts.length) await duffel.updatePassenger(offerId,offer.passengers[i].id,ts[i]);
        if(ts.some(t=>t.loyalty_accounts.length)) offer=await duffel.offer(offerId);
        const flat=flattenOffer(offer);assert(allowed(flat,(await readState()).profile),'Offer violates preferences',409);
        const quoteId=randomUUID(),expires_at=Math.min(now()+TTL,Date.parse(offer.expires_at)-30_000);
        assert(expires_at>now(),'Offer expired',409);
        const quote={id:quoteId,offer_id:offerId,traveler_ids:ids,created_at:now(),expires_at,amount:offer.total_amount,currency:offer.total_currency,
          signature:JSON.stringify({id:offer.id,amount:offer.total_amount,currency:offer.total_currency,legs:flat.legs,airlines:flat.airline_codes}),
          travelers_fingerprint:fingerprint(ts),offer:flat};
        await store.mutate(s=>{s.quotes[quoteId]=quote;for(const [id,q] of Object.entries(s.quotes))if(q.expires_at<now()-86400000)delete s.quotes[id];});
        return send(res,200,{quote_id:quoteId,expires_at,offer:flat,approval_phrase:`BOOK ${quote.amount} ${quote.currency}`,
          payment_source:'Duffel balance (not saved card tokens)',notice:'Airline terms, refundability, change fees and baggage rules must be reviewed before purchase.'});
      }
      if(req.method==='POST' && path==='/api/bookings/confirm') {
        const v=await body(req),id=ident(v.quote_id),s=(await readState()),q=s.quotes[id];
        assert(q,'Quote not found',404);assert(now()<q.expires_at,'Quote expired',409);
        assert(v.approval===`BOOK ${q.amount} ${q.currency}`,'Explicit price confirmation required',400);
        assert(v.accept_terms===true,'You must review and accept the airline fare conditions',400);
        assert(enableLiveBooking,'Booking disabled; set ENABLE_LIVE_BOOKING=true after configuring Duffel balance',403);
        const ts=q.traveler_ids.map(t=>s.travelers[t]);
        assert(ts.every(Boolean) && fingerprint(ts)===q.travelers_fingerprint,'Traveler details changed; request a new quote',409);
        // Atomically claim the quote BEFORE any asynchronous provider call, so two
        // concurrent confirm requests cannot each create an order.
        await store.mutate(next=>{
          assert(!next.bookings[id],'Booking already attempted. Check status; never retry blindly.',409);
          next.bookings[id]={quote_id:id,offer_id:q.offer_id,status:'checking',amount:q.amount,currency:q.currency,attempted_at:now()};
        });
        let offer;
        try {
          offer=await duffel.offer(q.offer_id);
          const flat=flattenOffer(offer);
          const signature=JSON.stringify({id:offer.id,amount:offer.total_amount,currency:offer.total_currency,legs:flat.legs,airlines:flat.airline_codes});
          assert(signature===q.signature,'Offer changed: request and approve a new quote',409);
          assert(allowed(flat,(await readState()).profile),'Offer now violates preferences',409);
          assert(Date.parse(offer.expires_at)>now()+15_000,'Offer expired',409);
          await store.mutate(s=>{s.bookings[id].status='submitting';});
          const order=await duffel.order(offer,ts);
          await store.mutate(s=>{s.bookings[id]={...s.bookings[id],status:'confirmed',order_id:order.id,booking_reference:order.booking_reference,
            total_amount:order.total_amount,total_currency:order.total_currency,operating_carriers:flattenOffer(offer).operating_carriers,legs:flattenOffer(offer).legs};});
          return send(res,201,(await readState()).bookings[id]);
        } catch(e) {
          // A known pre-submission rejection is not a payment attempt; the quote
          // still cannot be reused. An unknown provider failure needs manual reconciliation.
          const status=e instanceof InputError && e.status===409 ? 'stale_quote' : 'requires_reconciliation';
          await store.mutate(s=>{s.bookings[id]={...s.bookings[id],status};});
          if(status==='stale_quote')throw e;
          throw new InputError('Provider response uncertain. Check Duffel orders before any new attempt.',502);
        }
      }
      throw new InputError('Not found',404);
    }catch(e){errorResponse(res,e);}
  }
  return {handle,close,search,pollWatches};
}
export function httpServer(app) {return createServer(app.handle);}

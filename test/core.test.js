import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptionKey, createStore } from '../src/store.js';
import { createDuffel } from '../src/duffel.js';
import { flattenOffer, rankOffers, compareAwards } from '../src/ranking.js';
import { createApplication, httpServer } from '../src/app.js';
import { searchInput, profileInput, paymentTokenInput } from '../src/validation.js';

const key=randomBytes(32);
const future=new Date(Date.now()+14*86400000).toISOString().slice(0,10);
const offer=(id='off_123',price='250.00')=>({id,total_amount:price,total_currency:'USD',expires_at:new Date(Date.now()+25*60000).toISOString(),live_mode:false,
  passengers:[{id:'pas_123'}],owner:{iata_code:'AA'}, slices:[{duration:'PT6H',origin:{iata_code:'JFK'},destination:{iata_code:'LAX'},segments:[{
  operating_carrier:{name:'American Airlines',iata_code:'AA'},marketing_carrier:{iata_code:'AA'},operating_carrier_flight_number:'22',origin:{iata_code:'JFK'},destination:{iata_code:'LAX'},departing_at:`${future}T08:00:00`,arriving_at:`${future}T11:00:00`
}]}]});
function localStore(){const dir=mkdtempSync(join(tmpdir(),'fluttershy-test-'));return {dir,file:join(dir,'test.enc'),store:createStore({file:join(dir,'test.enc'),key})};}
function makeDuffel(){return {search:async q=>({id:'orq_123',offers:[offer()]}),offer:async id=>offer(id),updatePassenger:async()=>({}),order:async()=>({id:'ord_123',booking_reference:'ABC123',total_amount:'250.00',total_currency:'USD'})};}
async function setup(duffel=makeDuffel(),enabled=true){
  const db=localStore(),app=createApplication({store:db.store,duffel,apiToken:'a'.repeat(32),enableLiveBooking:enabled});
  const server=httpServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function api(path,method='GET',value,authenticated=true){const response=await fetch(base+path,{method,headers:{...(authenticated?{Authorization:`Bearer ${'a'.repeat(32)}`}:{})},...(value?{body:JSON.stringify(value)}:{})});return {status:response.status,body:await response.json()};}
  return {...db,app,server,base,api,close:async()=>{app.close();await new Promise(r=>server.close(r));rmSync(db.dir,{recursive:true,force:true});}};
}
test('vault encrypts records; does not leak personal content or account numbers',()=>{
  const db=localStore();try{db.store.mutate(s=>{s.travelers.me={given_name:'PRIVATE NAME',loyalty_accounts:[{airline_iata_code:'AA',account_number:'PRIVATE123'}]};});
    const raw=readFileSync(db.file,'utf8');assert.doesNotMatch(raw,/PRIVATE NAME|PRIVATE123/);
    assert.equal(createStore({file:db.file,key}).get().travelers.me.given_name,'PRIVATE NAME');
    assert.throws(()=>createStore({file:db.file,key:randomBytes(32)}));
  }finally{rmSync(db.dir,{recursive:true,force:true});}
});
test('validation rejects invalid search, card numbers and invalid key',()=>{
  assert.throws(()=>searchInput({origin:'JFK',destination:'JFK',departure_date:future}),/differ/);
  assert.throws(()=>profileInput({mode:'wacky'}),/mode/);
  assert.throws(()=>paymentTokenInput({provider:'test',label:'card',token_reference:'4111111111111111'}),/Raw payment/);
  assert.throws(()=>encryptionKey('unsafe'),/64 hex/);
});
test('ranking blocks Frontier and keeps operating carrier attribution',()=>{
  const good=flattenOffer(offer('off_good','270.00'));
  const bad=flattenOffer({...offer('off_bad','80.00'),owner:{iata_code:'F9'},slices:[{...offer().slices[0],segments:[{...offer().slices[0].segments[0],operating_carrier:{name:'Frontier Airlines',iata_code:'F9'}}]}]});
  const result=rankOffers([bad,good],profileInput({}));assert.equal(result.length,1);assert.equal(result[0].id,'off_good');
  assert.equal(result[0].operating_carriers[0].name,'American Airlines');
  const awards=compareAwards([good],[{kind:'award',id:'award1',miles:10000,taxes_usd:20}],profileInput({}));
  assert.equal(awards[0].effective_usd,160);assert.equal(awards[0].bookable_here,false);
});
test('Duffel request payloads use approved API fields and account balance',async()=>{
  const calls=[];const fake=async (url,opt)=>{calls.push({url,opt});return {ok:true,json:async()=>({data:{id:'any'}})};};
  const api=createDuffel({token:'duffel_test_example',fetchImpl:fake});
  await api.search(searchInput({origin:'JFK',destination:'LAX',departure_date:future,return_date:new Date(Date.now()+20*86400000).toISOString().slice(0,10)}));
  const payload=JSON.parse(calls[0].opt.body).data;assert.equal(payload.slices.length,2);assert.deepEqual(payload.passengers,[{type:'adult'}]);
  await api.order(offer(),[{given_name:'Sam',family_name:'Smith',born_on:'1991-01-01',email:'sam@example.com',phone_number:'+12025550123',gender:'f',loyalty_accounts:[]}]);
  const booking=JSON.parse(calls[1].opt.body).data;
  assert.equal(booking.payments[0].type,'balance');assert.equal(booking.payments[0].amount,'250.00');assert.equal(booking.passengers[0].id,'pas_123');
  assert.equal('loyalty_accounts' in booking.passengers[0],false);
});
test('HTTP routes require authentication; price watches and booking need explicit approved fare',async()=>{
  const s=await setup();try{
    assert.equal((await s.api('/api/state','GET',undefined,false)).status,401);
    const traveler={given_name:'Sam',family_name:'Smith',born_on:'1991-01-01',email:'sam@example.com',phone_number:'+12025550123',gender:'f',loyalty_accounts:[{airline_iata_code:'AA',account_number:'FF-123456'}]};
    const saved=await s.api('/api/travelers/me','PUT',traveler);assert.equal(saved.status,200);
    assert.equal(saved.body.loyalty_accounts[0].account_number,'••••3456');
    const q={origin:'JFK',destination:'LAX',departure_date:future,adults:1};
    const result=await s.api('/api/search','POST',q);assert.equal(result.status,200);assert.equal(result.body.offers.length,1);
    assert.equal((await s.api('/api/search','POST',q)).body.cached,true);
    const watch=await s.api('/api/watches','POST',{query:q,max_price:300});assert.equal(watch.status,201);
    const quote=await s.api('/api/bookings/quote','POST',{offer_id:'off_123',traveler_ids:['me']});assert.equal(quote.status,200);
    let attempt=await s.api('/api/bookings/confirm','POST',{quote_id:quote.body.quote_id,approval:'BOOK 1.00 USD',accept_terms:true});assert.equal(attempt.status,400);
    attempt=await s.api('/api/bookings/confirm','POST',{quote_id:quote.body.quote_id,approval:quote.body.approval_phrase,accept_terms:true});assert.equal(attempt.status,201);assert.equal(attempt.body.booking_reference,'ABC123');
    attempt=await s.api('/api/bookings/confirm','POST',{quote_id:quote.body.quote_id,approval:quote.body.approval_phrase,accept_terms:true});assert.equal(attempt.status,409);
  }finally{await s.close();}
});
test('live booking disabled even with explicit confirmation',async()=>{
 const s=await setup(makeDuffel(),false);try{
  await s.api('/api/travelers/me','PUT',{given_name:'Sam',family_name:'Smith',born_on:'1991-01-01',email:'sam@example.com',phone_number:'+12025550123',gender:'f',loyalty_accounts:[]});
  const quote=(await s.api('/api/bookings/quote','POST',{offer_id:'off_123',traveler_ids:['me']})).body;
  assert.equal((await s.api('/api/bookings/confirm','POST',{quote_id:quote.quote_id,approval:quote.approval_phrase,accept_terms:true})).status,403);
 }finally{await s.close();}
});
test('ambiguous order failure is non-retryable and recorded for reconciliation',async()=>{
 const d=makeDuffel();let orderCalls=0;d.order=async()=>{orderCalls++;throw Error('network failure');};
 const s=await setup(d);try{
  await s.api('/api/travelers/me','PUT',{given_name:'Sam',family_name:'Smith',born_on:'1991-01-01',email:'sam@example.com',phone_number:'+12025550123',gender:'f',loyalty_accounts:[]});
  const quote=(await s.api('/api/bookings/quote','POST',{offer_id:'off_123',traveler_ids:['me']})).body;
  const req={quote_id:quote.quote_id,approval:quote.approval_phrase,accept_terms:true};
  assert.equal((await s.api('/api/bookings/confirm','POST',req)).status,502);
  assert.equal((await s.api('/api/bookings/confirm','POST',req)).status,409);
  assert.equal(orderCalls,1);assert.equal((await s.api('/api/state')).body.bookings[quote.quote_id].status,'requires_reconciliation');
 }finally{await s.close();}
});

test('calendar export uses date-only times and requires authorization',async()=>{
 const s=await setup();try{
  await s.api('/api/travelers/me','PUT',{given_name:'Sam',family_name:'Smith',born_on:'1991-01-01',email:'sam@example.com',phone_number:'+12025550123',gender:'f',loyalty_accounts:[]});
  const q=(await s.api('/api/bookings/quote','POST',{offer_id:'off_123',traveler_ids:['me']})).body;
  await s.api('/api/bookings/confirm','POST',{quote_id:q.quote_id,approval:q.approval_phrase,accept_terms:true});
  const denied=await fetch(`${s.base}/api/bookings/${q.quote_id}/calendar.ics`);assert.equal(denied.status,401);
  const result=await fetch(`${s.base}/api/bookings/${q.quote_id}/calendar.ics`,{headers:{Authorization:`Bearer ${'a'.repeat(32)}`}});
  assert.equal(result.status,200);const text=await result.text();assert.match(text,/BEGIN:VCALENDAR/);assert.match(text,/DTSTART;VALUE=DATE:/);assert.match(text,/ABC123/);
 }finally{await s.close();}
});
test('a changed traveler invalidates approval instead of changing passenger silently',async()=>{
 const s=await setup();try{
  const p={given_name:'Sam',family_name:'Smith',born_on:'1991-01-01',email:'sam@example.com',phone_number:'+12025550123',gender:'f',loyalty_accounts:[]};
  await s.api('/api/travelers/me','PUT',p);
  const q=(await s.api('/api/bookings/quote','POST',{offer_id:'off_123',traveler_ids:['me']})).body;
  await s.api('/api/travelers/me','PUT',{...p,family_name:'Jones'});
  const confirmation=await s.api('/api/bookings/confirm','POST',{quote_id:q.quote_id,approval:q.approval_phrase,accept_terms:true});
  assert.equal(confirmation.status,409);assert.match(confirmation.body.error,/Traveler details changed/);
 }finally{await s.close();}
});
test('concurrent duplicate confirmations cannot each create an order',async()=>{
 const d=makeDuffel();let orderCount=0;d.order=async()=>{orderCount++;await new Promise(r=>setTimeout(r,35));return {id:'ord',booking_reference:'SINGLE'};};
 const s=await setup(d);try{
  await s.api('/api/travelers/me','PUT',{given_name:'Sam',family_name:'Smith',born_on:'1991-01-01',email:'sam@example.com',phone_number:'+12025550123',gender:'f',loyalty_accounts:[]});
  const q=(await s.api('/api/bookings/quote','POST',{offer_id:'off_123',traveler_ids:['me']})).body;
  const request={quote_id:q.quote_id,approval:q.approval_phrase,accept_terms:true};
  const results=await Promise.all([s.api('/api/bookings/confirm','POST',request),s.api('/api/bookings/confirm','POST',request)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(orderCount,1);
 }finally{await s.close();}
});

test('Seats.aero cached awards preserve unknown tax currencies and normalize cent amounts',async()=>{
 const {createSeatsAero,normalizeAwardAvailability}=await import('../src/seats.js');
 const q=searchInput({origin:'JFK',destination:'LAX',departure_date:future,cabin_class:'economy'});
 const row={ID:'avail_1',Date:future,YAvailable:true,YMileageCost:'25,000',YTotalTaxes:3400,TaxesCurrency:'USD',YAirlines:'AA, AS',YDirect:true,Source:'alaska',UpdatedAt:'2026-10-01T00:00:00Z'};
 const normalized=normalizeAwardAvailability(row,q);assert.equal(normalized.miles,25000);assert.equal(normalized.taxes_usd,34);
 assert.equal(normalizeAwardAvailability({...row,TaxesCurrency:undefined},q).taxes_usd,null);
 assert.equal(normalizeAwardAvailability({...row,Date:'2020-02-01'},q),null);
 let calls=0;const seats=createSeatsAero({key:'test-api-key',fetchImpl:async(url,opts)=>{
   calls++;assert.match(url,/origin_airport=JFK/);assert.match(url,/cabins=economy/);
   assert.equal(opts.headers['Partner-Authorization'],'test-api-key');
   return {ok:true,json:async()=>({data:[row]})};
 }});
 const s=await setup(makeDuffel());s.app.close();await new Promise(r=>s.server.close(r)); // instantiate a new app to inject the mock
 const app=createApplication({store:s.store,duffel:makeDuffel(),seats,apiToken:'a'.repeat(32)});
 const server=httpServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const host=`http://127.0.0.1:${server.address().port}`;
  const request=()=>fetch(host+'/api/award-search',{method:'POST',headers:{Authorization:`Bearer ${'a'.repeat(32)}`},body:JSON.stringify(q)}).then(r=>r.json());
  const first=await request(),second=await request();
  assert.equal(first.offers[0].miles,25000);assert.equal(first.offers[0].effective_usd,384);
  assert.equal(second.cached,true);assert.equal(calls,1);
 }finally{app.close();await new Promise(r=>server.close(r));await s.close();}
});

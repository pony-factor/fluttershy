const $=id=>document.getElementById(id);
const text=(tag,value,cls)=>{const el=document.createElement(tag);el.textContent=String(value ?? '');if(cls)el.className=cls;return el;};
const append=(parent,...children)=>{parent.append(...children);return parent;};
let token=sessionStorage.getItem('fluttershy_api_token')||'';
let lastSearch=null, lastQuery=null, selectedQuote=null;
const format=(n,cur='USD')=>new Intl.NumberFormat('en-US',{style:'currency',currency:cur}).format(Number(n));
const dateInput=()=>new Date(Date.now()+86400000*10).toISOString().slice(0,10);
$('search-form').elements.departure_date.value=dateInput();
async function api(path,method='GET',data) {
  const res=await fetch(path,{method,headers:{Authorization:`Bearer ${token}`,...(data?{'Content-Type':'application/json'}:{})}, ...(data?{body:JSON.stringify(data)}:{})});
  const payload=await res.json();if(!res.ok)throw Error(payload.error||`Request failed ${res.status}`);return payload;
}
const msg=(value)=>{$('message').textContent=value;};
async function reload() {
  const data=await api('/api/state');
  $('connect').hidden=true;$('workspace').hidden=false;$('connection').textContent='Connected · local vault';
  const form=$('profile-form');for(const [k,v] of Object.entries(data.profile)){
    if(!form.elements[k])continue;
    if(form.elements[k].type==='checkbox')form.elements[k].checked=!!v;
    else form.elements[k].value=Array.isArray(v)?v.join(', '):(v ?? '');
  }
  const travelers=$('travelers');travelers.replaceChildren();
  for(const [id,t] of Object.entries(data.travelers))append(travelers,text('div',`${id} · ${t.given_name} ${t.family_name} · ${t.loyalty_accounts.map(a=>`${a.airline_iata_code} ${a.account_number}`).join(', ')}`,'item'));
  const tokens=$('tokens');tokens.replaceChildren();
  for(const [id,t] of Object.entries(data.payment_tokens))append(tokens,text('div',`${id} · ${t.label} · ${t.provider} ${t.last4?`••••${t.last4}`:''}`,'item'));
  const watches=$('watches');watches.replaceChildren();
  for(const w of Object.values(data.watches)){
    const item=append(text('div','', 'item'),text('strong',`${w.query.origin} → ${w.query.destination} · ${w.query.departure_date}`),text('p',`Alert under ${format(w.max_price,w.currency)} · cheapest ${w.cheapest === null ? 'not checked' : format(w.cheapest,w.currency)} · matching ${w.last_matches.length}`));
    const b=text('button','Refresh','secondary');b.onclick=()=>run(async()=>{await api(`/api/watches/${w.id}/refresh`,'POST',{});await reload();});
    const del=text('button','Remove','secondary');del.onclick=()=>run(async()=>{await api(`/api/watches/${w.id}`,'DELETE');await reload();});append(item,b,del);append(watches,item);
  }
  const bookings=$('bookings');bookings.replaceChildren();
  for(const b of Object.values(data.bookings))append(bookings,text('div',`${b.status.toUpperCase()} · ${b.booking_reference||b.offer_id} · ${format(b.amount,b.currency)}${b.status==='requires_reconciliation'?' · Check Duffel before retrying':''}`,'item'));
}
async function run(fn) {try{msg('');await fn();}catch(e){msg(e.message);}}
$('connect-form').onsubmit=e=>{e.preventDefault();token=new FormData(e.currentTarget).get('token');sessionStorage.setItem('fluttershy_api_token',token);run(async()=>{await reload();msg('Connected');});};
$('profile-form').onsubmit=e=>{e.preventDefault();run(async()=>{const f=e.currentTarget.elements;
  await api('/api/profile','PUT',{mode:f.mode.value,excluded_airlines:f.excluded_airlines.value.split(',').map(s=>s.trim()).filter(Boolean),avoid_ulcc:f.avoid_ulcc.checked,nonstops_only:f.nonstops_only.checked,miles_cents_per_point:Number(f.miles_cents_per_point.value),max_cash_usd:f.max_cash_usd.value?Number(f.max_cash_usd.value):null});
  await reload();msg('Preferences saved');});};
$('traveler-form').onsubmit=e=>{e.preventDefault();run(async()=>{const f=e.currentTarget.elements;
 const accounts=f.loyalty_accounts.value.split(',').map(v=>v.trim()).filter(Boolean).map(v=>{const [airline_iata_code,...rest]=v.split(':');return {airline_iata_code,account_number:rest.join(':')};});
 await api(`/api/travelers/${encodeURIComponent(f.id.value)}`,'PUT',{given_name:f.given_name.value,family_name:f.family_name.value,born_on:f.born_on.value,gender:f.gender.value,email:f.email.value,phone_number:f.phone_number.value,loyalty_accounts:accounts});
 f.loyalty_accounts.value='';await reload();msg('Traveler saved to encrypted vault');});};
$('token-form').onsubmit=e=>{e.preventDefault();run(async()=>{const f=e.currentTarget.elements;await api(`/api/payment-tokens/${encodeURIComponent(f.id.value)}`,'PUT',{provider:f.provider.value,token_reference:f.token_reference.value,label:f.label.value,last4:f.last4.value||undefined});f.token_reference.value='';await reload();msg('Token reference saved');});};
$('search-form').onsubmit=e=>{e.preventDefault();run(async()=>{
 const f=e.currentTarget.elements;lastQuery={origin:f.origin.value.toUpperCase(),destination:f.destination.value.toUpperCase(),departure_date:f.departure_date.value,return_date:f.return_date.value||undefined,adults:Number(f.adults.value),cabin_class:f.cabin_class.value,max_connections:Number(f.max_connections.value)};
 $('search-status').textContent='Searching live airline offers…';const r=await api('/api/search','POST',lastQuery);lastSearch=r;
 $('search-status').textContent=`${r.offers.length} matching offers · ${r.cached?'cached':'fresh'} · Prices may change before checkout`;showResults(r.offers);
});};
function showResults(offers){const root=$('results');root.replaceChildren();if(!offers.length)append(root,text('p','No offers match your airline and trip preferences.'));
 for(const o of offers.slice(0,30)){
   const item=text('article','', 'result');const summary=text('div','');
   append(summary,text('h3',`${(o.legs||[]).map(l=>`${l.origin||'?'} → ${l.destination||'?'}`).join(' / ')}`),text('p',`${o.operating_carriers.map(c=>c.name||c.code).join(' · ')} · ${o.stops} stops · ${o.duration_minutes||'?'} minutes`));
   for(const l of o.legs)append(summary,text('small',(l.segments||[]).map(s=>`${s.operating_carrier||'Airline'} ${s.flight_number||''} (${s.origin}–${s.destination})`).join(' · ')));
   const side=text('div','');const b=text('button','Review booking','secondary');b.onclick=()=>run(()=>quote(o));append(side,text('div',format(o.amount,o.currency),'price'),text('p',`Expires ${o.expires_at?new Date(o.expires_at).toLocaleTimeString():'unknown'}`),b);append(item,summary,side);append(root,item);
 }
}
async function quote(o){const s=await api('/api/state');const ids=Object.keys(s.travelers);
 if(ids.length!==lastQuery.adults)throw Error(`Save ${lastQuery.adults} adult traveler(s) in the vault first. Currently have ${ids.length}.`);
 const q=await api('/api/bookings/quote','POST',{offer_id:o.id,traveler_ids:ids});selectedQuote=q;
 const root=$('results'),old=$('approval');if(old)old.remove();
 const box=text('section','','approval');box.id='approval';
 append(box,text('h2',`Review · ${format(q.offer.amount,q.offer.currency)}`),text('p',`Operating carriers: ${q.offer.operating_carriers.map(c=>c.name).join(', ')}. This price uses your Duffel balance, not a saved card reference.`),
 text('p','Read the airline baggage, fare, cancellation and change rules before agreeing. Flights are not automatically refundable. Fare and availability are verified again before booking.'),
 text('p',`Type exactly: ${q.approval_phrase}`));
 const phrase=document.createElement('input');phrase.id='approval-text';phrase.placeholder=q.approval_phrase;phrase.autocomplete='off';
 const check=document.createElement('input');check.id='approval-terms';check.type='checkbox';
 const lbl=text('label','I reviewed the applicable fare conditions and authorize this booking.','check');lbl.prepend(check);
 const b=text('button','Confirm and book');b.className='danger';b.onclick=()=>run(async()=>{
   const result=await api('/api/bookings/confirm','POST',{quote_id:selectedQuote.quote_id,approval:phrase.value,accept_terms:check.checked});
   msg(`Booking ${result.status}: reference ${result.booking_reference||result.order_id}`);box.remove();await reload();
 });append(box,phrase,lbl,b);root.prepend(box);box.scrollIntoView({behavior:'smooth',block:'center'});
}
$('watch-form').onsubmit=e=>{e.preventDefault();run(async()=>{if(!lastQuery)throw Error('Search a route first');await api('/api/watches','POST',{query:lastQuery,max_price:Number(e.currentTarget.elements.max_price.value),currency:'USD'});await reload();msg('Background watch created');});};
$('award-form').onsubmit=e=>{e.preventDefault();run(async()=>{if(!lastQuery)throw Error('Search a route first');const f=e.currentTarget.elements;
 await api('/api/awards','POST',{trip:lastQuery,program:f.program.value,miles:Number(f.miles.value),taxes_usd:Number(f.taxes_usd.value),airline_codes:f.airline_codes.value.split(',').map(x=>x.trim()).filter(Boolean),notes:f.notes.value,stops:0});
 const url=new URL('/api/compare',location.origin);for(const k of ['origin','destination','departure_date'])url.searchParams.set(k,lastQuery[k]);
 const c=await api(url.pathname+url.search),root=$('awards');root.replaceChildren();for(const a of c.awards)append(root,text('div',`${a.program}: ${a.miles.toLocaleString()} miles + ${format(a.taxes_usd)} · estimated value ${format(a.effective_usd)}${a.savings_vs_cash_usd===null?'':` · equivalent savings ${format(a.savings_vs_cash_usd)}`} · comparison only`,'item'));
 msg('Award quote added');});};
if(token)run(reload);

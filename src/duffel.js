import { InputError, assert, ident } from './validation.js';
export function createDuffel({token, fetchImpl=globalThis.fetch, baseUrl='https://api.duffel.com'}) {
  if (!token) return {
    search: async()=>{throw new InputError('DUFFEL_ACCESS_TOKEN is not configured',503);},
    offer: async()=>{throw new InputError('DUFFEL_ACCESS_TOKEN is not configured',503);},
    updatePassenger: async()=>{throw new InputError('DUFFEL_ACCESS_TOKEN is not configured',503);},
    order: async()=>{throw new InputError('DUFFEL_ACCESS_TOKEN is not configured',503);}
  };
  async function request(method, path, data) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method, headers: {Authorization:`Bearer ${token}`, 'Duffel-Version':'v2', 'Content-Type':'application/json', Accept:'application/json'},
      ...(data ? {body:JSON.stringify({data})} : {}), signal:AbortSignal.timeout(65000)
    });
    if (!response.ok) {
      // Never forward provider payload containing PII or sensitive partner diagnostics.
      throw new InputError(`Duffel ${method} failed (HTTP ${response.status})`, response.status >= 500 ? 502 : 422);
    }
    return (await response.json()).data;
  }
  return {
    search: q => {
      const slices=[{origin:q.origin,destination:q.destination,departure_date:q.departure_date}];
      if(q.return_date) slices.push({origin:q.destination,destination:q.origin,departure_date:q.return_date});
      return request('POST','/air/offer_requests?return_offers=true',{slices, passengers:Array.from({length:q.adults},()=>({type:'adult'})), cabin_class:q.cabin_class, max_connections:q.max_connections});
    },
    offer: id => request('GET',`/air/offers/${encodeURIComponent(ident(id))}`),
    updatePassenger: (offerId, paxId, t) => request('PATCH',`/air/offers/${encodeURIComponent(ident(offerId))}/passengers/${encodeURIComponent(ident(paxId))}`,{
      given_name:t.given_name, family_name:t.family_name,
      loyalty_programme_accounts:t.loyalty_accounts.map(({airline_iata_code, account_number})=>({airline_iata_code,account_number}))
    }),
    order: (offer, travelers) => {
      assert(offer.passengers?.length === travelers.length, 'Passenger count mismatch',409);
      return request('POST','/air/orders',{
        selected_offers:[offer.id], type:'instant',
        payments:[{type:'balance',currency:offer.total_currency,amount:offer.total_amount}],
        passengers:offer.passengers.map((p,i)=>({id:p.id,...Object.fromEntries(Object.entries(travelers[i]).filter(([k])=>k!=='loyalty_accounts'))}))
      });
    }
  };
}

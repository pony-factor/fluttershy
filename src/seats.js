import { InputError, assert, searchInput } from './validation.js';

const CABINS={economy:'Y',premium_economy:'W',business:'J',first:'F'};
// Seats.aero returns summary AVAILABILITY, not a priced, bookable itinerary.
// Cabin-specific taxes are typically in minor currency units. Never infer USD
// when the API omits the currency; don't silently treat it as zero tax.
export function normalizeAwardAvailability(row, q) {
  const cabin=CABINS[q.cabin_class] || 'Y';
  if(!row || !row[`${cabin}Available`] || String(row.Date||'').slice(0,10)!==q.departure_date)return null;
  const miles=Number(String(row[`${cabin}MileageCost`]||'').replaceAll(',',''));
  if(!Number.isSafeInteger(miles) || miles<=0)return null;
  const names=String(row[`${cabin}Airlines`]||'').split(',').map(x=>x.trim().toUpperCase()).filter(x=>/^[A-Z0-9]{2,3}$/.test(x));
  const taxesRaw=row[`${cabin}TotalTaxes`], currency=row.TaxesCurrency||null;
  const taxCents=taxesRaw!==null && taxesRaw!==undefined && taxesRaw!=='' ? Number(taxesRaw) : null;
  const taxes=taxCents!==null&&Number.isFinite(taxCents)&&taxCents>=0 ? Math.round(taxCents)/100 : null;
  return {id:`seats-${String(row.ID||'unknown').replace(/[^a-zA-Z0-9_-]/g,'')}-${cabin}`,kind:'award',provider:'seats.aero',
    program:row.Source||row.Route?.Source||'unknown',departure_date:q.departure_date,route:`${q.origin}-${q.destination}`,
    miles,airline_codes:names,cabin_class:q.cabin_class,direct:row[`${cabin}Direct`]===true,
    stops:row[`${cabin}Direct`]===true?0:1,stops_are_estimate:row[`${cabin}Direct`]!==true,
    available_seats:row[`${cabin}RemainingSeats`]||null,
    taxes_amount:taxes,taxes_currency:currency,taxes_usd:currency==='USD'?taxes:null,
    updated_at:row.UpdatedAt||null,bookable_here:false,cached_availability:true};
}
export function createSeatsAero({key,fetchImpl=globalThis.fetch,baseUrl='https://seats.aero'}) {
  return {
    configured:!!key,
    async search(input) {
      if(!key)throw new InputError('SEATS_AERO_API_KEY is not configured',503);
      const q=searchInput(input);
      assert(q.adults===1 && !q.return_date,'Award lookup currently supports one adult and one-way travel',400);
      const params=new URLSearchParams({origin_airport:q.origin,destination_airport:q.destination,start_date:q.departure_date,end_date:q.departure_date,
        cabins:q.cabin_class==='premium_economy'?'premium':q.cabin_class,take:'100'});
      const response=await fetchImpl(`${baseUrl}/partnerapi/search?${params}`,{
        headers:{'Partner-Authorization':key,Accept:'application/json'},signal:AbortSignal.timeout(25000)});
      if(!response.ok)throw new InputError(`Seats.aero cached search failed (HTTP ${response.status})`,response.status>=500?502:422);
      const data=await response.json();
      assert(Array.isArray(data.data),'Unsupported award provider response',502);
      return {query:q,provider:'seats.aero',cached_availability:true,offers:data.data.map(row=>normalizeAwardAvailability(row,q)).filter(Boolean)};
    }
  };
}

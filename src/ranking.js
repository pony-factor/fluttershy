const ULCC = new Set(['F9','NK','G4','FR','W6','U2','XP','MX']);
function durationMinutes(iso) {
  const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || '');
  return m ? Number(m[1]||0)*60+Number(m[2]||0) : 0;
}
export function flattenOffer(o) {
  const segments=(o.slices || []).flatMap(s=>s.segments || []);
  const operating_carriers=[...new Map(segments.map(s=>[s.operating_carrier?.iata_code || s.operating_carrier?.name, {code:s.operating_carrier?.iata_code, name:s.operating_carrier?.name}])).values()];
  const codes=[...new Set([...operating_carriers.map(c=>c.code),...segments.map(s=>s.marketing_carrier?.iata_code),o.owner?.iata_code].filter(Boolean))];
  return {
    kind:'cash',provider:'duffel',id:o.id,amount:Number(o.total_amount),currency:o.total_currency,
    expires_at:o.expires_at, operating_carriers, airline_codes:codes,
    stops:(o.slices||[]).reduce((s,x)=>s+Math.max(0,(x.segments||[]).length-1),0),
    duration_minutes:(o.slices||[]).reduce((s,x)=>s+durationMinutes(x.duration),0),
    legs:(o.slices||[]).map(s=>({origin:s.origin?.iata_code,destination:s.destination?.iata_code,duration:s.duration,
      segments:(s.segments||[]).map(x=>({departing_at:x.departing_at,arriving_at:x.arriving_at,origin:x.origin?.iata_code,destination:x.destination?.iata_code,
        operating_carrier:x.operating_carrier?.name,flight_number:x.operating_carrier_flight_number}))})),
    cabin_class:o.cabin_class, live_mode:o.live_mode, payment_requirements:o.payment_requirements
  };
}
export function scoreOffer(o, p) {
  const dollars=o.kind==='award' ? o.taxes_usd+o.miles*p.miles_cents_per_point/100 : o.amount;
  const duration=o.duration_minutes||720, stops=o.stops||0;
  const metric={cheapest:dollars,fastest:duration+stops*60, fewest_stops:stops*10000+duration,balanced:dollars+duration*.16+stops*65};
  return metric[p.mode] ?? metric.balanced;
}
export function allowed(o,p) {
  if(o.kind==='cash' && o.currency !== 'USD' && p.max_cash_usd !== null) return true; // cannot compare budget across currencies
  if(o.kind==='cash' && p.max_cash_usd !== null && o.amount > p.max_cash_usd) return false;
  if(p.nonstops_only && o.stops > 0) return false;
  return !(o.airline_codes||[]).some(c=>p.excluded_airlines.includes(c)||(p.avoid_ulcc&&ULCC.has(c)));
}
export function rankOffers(offers,p) {
  return offers.filter(o=>allowed(o,p)).sort((a,b)=>scoreOffer(a,p)-scoreOffer(b,p)||a.id.localeCompare(b.id));
}
export function compareAwards(cash, awards, p) {
  const bestCash=rankOffers(cash.filter(o=>o.currency==='USD'),p)[0];
  return awards.map(a=>({ ...a, effective_usd:Math.round((a.taxes_usd+a.miles*p.miles_cents_per_point/100)*100)/100,
    savings_vs_cash_usd:bestCash?Math.round((bestCash.amount-a.taxes_usd-a.miles*p.miles_cents_per_point/100)*100)/100:null,
    redemption_source:'user_supplied', bookable_here:false }));
}

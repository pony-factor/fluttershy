export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function assert(ok, message, status = 400) { if (!ok) throw new InputError(message, status); }
export function text(value, label, max = 120) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${label}`);
  return value.trim();
}
export function code(value, label = 'code') {
  const v = text(value, label, 3).toUpperCase();
  assert(/^[A-Z]{3}$/.test(v), `Invalid ${label} (expected three-letter IATA code)`);
  return v;
}
export function airlineCode(value) {
  const v = text(value, 'airline code', 3).toUpperCase();
  assert(/^[A-Z0-9]{2,3}$/.test(v), 'Invalid airline IATA code');
  return v;
}
export function date(value, label = 'date') {
  const v = text(value, label, 10);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, `Invalid ${label}`);
  return v;
}
export function number(value, label, min, max) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `Invalid ${label}`);
  return value;
}
export function ident(value) { const v = text(value, 'ID', 100); assert(/^[a-zA-Z0-9_-]+$/.test(v), 'Invalid ID'); return v; }
export function searchInput(v) {
  assert(v && typeof v === 'object' && !Array.isArray(v), 'Expected search object');
  const origin = code(v.origin, 'origin'); const destination = code(v.destination, 'destination');
  assert(origin !== destination, 'Origin and destination must differ');
  const departure_date = date(v.departure_date, 'departure_date');
  assert(departure_date >= new Date().toISOString().slice(0,10), 'Departure date is in the past');
  const return_date = v.return_date ? date(v.return_date, 'return_date') : null;
  assert(!return_date || return_date > departure_date, 'Return date must follow departure');
  const adults = number(v.adults ?? 1, 'adults', 1, 6);
  assert(Number.isInteger(adults), 'adults must be an integer');
  const cabin_class = v.cabin_class ?? 'economy';
  assert(['economy','premium_economy','business','first'].includes(cabin_class), 'Invalid cabin class');
  const max_connections = v.max_connections ?? 1;
  assert(Number.isInteger(max_connections) && max_connections >= 0 && max_connections <= 2, 'Invalid max_connections');
  return {origin,destination,departure_date,return_date,adults,cabin_class,max_connections};
}
export function profileInput(v) {
  assert(v && typeof v === 'object' && !Array.isArray(v), 'Expected preferences object');
  const mode = v.mode ?? 'balanced';
  assert(['balanced','cheapest','fastest','fewest_stops'].includes(mode),'Invalid optimization mode');
  const excluded_airlines = (v.excluded_airlines ?? ['F9']).map(airlineCode);
  assert(Array.isArray(v.excluded_airlines ?? []) && excluded_airlines.length <= 30, 'Invalid excluded airlines');
  const avoid_ulcc = v.avoid_ulcc ?? true;
  assert(typeof avoid_ulcc === 'boolean', 'Invalid avoid_ulcc');
  return {
    mode, excluded_airlines: [...new Set(excluded_airlines)], avoid_ulcc,
    miles_cents_per_point: number(v.miles_cents_per_point ?? 1.4, 'miles_cents_per_point', 0.01, 20),
    max_cash_usd: v.max_cash_usd === null || v.max_cash_usd === undefined ? null : number(v.max_cash_usd, 'max_cash_usd', 1, 100000),
    nonstops_only: Boolean(v.nonstops_only)
  };
}
export function travelerInput(v) {
  assert(v && typeof v === 'object' && !Array.isArray(v), 'Expected traveler object');
  const accounts = v.loyalty_accounts ?? [];
  assert(Array.isArray(accounts) && accounts.length <= 30, 'Invalid loyalty_accounts');
  const email = text(v.email, 'email', 200);
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Invalid email');
  const phone_number = text(v.phone_number, 'phone_number', 30);
  assert(/^\+[1-9]\d{6,14}$/.test(phone_number), 'Use E.164 phone format');
  const gender = text(v.gender, 'gender', 1).toLowerCase();
  assert(['m','f'].includes(gender), 'Duffel currently requires m or f for this booking flow');
  const title = v.title ? text(v.title, 'title', 12).toLowerCase() : undefined;
  if (title) assert(['mr','mrs','ms','miss','dr'].includes(title), 'Invalid title');
  return {
    given_name: text(v.given_name, 'given_name', 20),
    family_name: text(v.family_name, 'family_name', 20),
    born_on: date(v.born_on, 'born_on'), email, phone_number, gender, ...(title ? {title} : {}),
    loyalty_accounts: accounts.map(a => ({airline_iata_code: airlineCode(a.airline_iata_code), account_number: text(a.account_number, 'account_number', 60)}))
  };
}
export function paymentTokenInput(v) {
  assert(v && typeof v === 'object' && !Array.isArray(v), 'Expected token reference');
  // Do not accept PAN, security codes, airline passwords, etc. This record is metadata only.
  assert(Object.keys(v).every(k => ['provider','token_reference','label','last4'].includes(k)), 'Only token references are accepted; never submit card numbers or CVV');
  const provider = text(v.provider, 'provider', 50);
  const token_reference = text(v.token_reference, 'token_reference', 300);
  assert(!/^\d{12,19}$/.test(token_reference.replace(/[ -]/g,'')), 'Raw payment cards are not accepted');
  return {provider, token_reference, label: text(v.label, 'label', 60), last4: v.last4 ? text(v.last4, 'last4', 4) : null};
}

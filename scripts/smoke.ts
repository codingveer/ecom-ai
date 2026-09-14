export {};
/** End-to-end smoke test across all four processes. Run after `npm run dev`. */
const APP = 'http://localhost:8100';
const post = async (p: string, b: unknown) =>
  (await fetch(APP + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json() as any;
const get = async (p: string) => (await fetch(APP + p)).json() as any;

const line = (s: string) => console.log('\n' + '='.repeat(70) + '\n' + s + '\n' + '='.repeat(70));
const summarise = (r: any) => {
  console.log(`intent=${r.intent} (${Math.round(r.intent_confidence * 100)}%)  agent=${r.agent}`);
  console.log('reply:', String(r.reply).split('\n').slice(0, 6).join('\n       '));
  const pol = r.trace.filter((t: any) => t.stage === 'policy');
  if (pol.length) console.log('policy:', pol.map((p: any) => p.label).join(', '));
  console.log(`trace steps: ${r.trace.length}  tools: ${r.trace.filter((t: any) => t.stage === 'tool').length}  llm: ${r.trace.filter((t: any) => t.stage === 'llm').length}`);
};

const health = await get('/health');
console.log('health:', JSON.stringify(health.dependencies));
if (Object.values(health.dependencies).some(v => v === false)) {
  console.error('\nSome services are down. Start them with `npm run dev` first.');
  process.exit(1);
}

line('BEAT 1 - affluent customer (C001 Priya), same query');
const a = await post('/session/demo-a/message', { customerId: 'C001', text: 'show me an occasion dress' });
summarise(a);
console.log('price tiers:', JSON.stringify(a.payload.price_tier_mix));

line('BEAT 2 - less affluent customer (C002 Aditi), IDENTICAL query');
const b = await post('/session/demo-b/message', { customerId: 'C002', text: 'show me an occasion dress' });
summarise(b);
console.log('price tiers:', JSON.stringify(b.payload.price_tier_mix));

line('BEAT 3 - fit check, known customer with history');
summarise(await post('/session/demo-a/message', { customerId: 'C001', text: 'what size should I get?' }));

line('BEAT 4 - fit check, no consent and no history -> ABSTAIN');
summarise(await post('/session/demo-b/message', { customerId: 'C002', text: 'what size should I get?' }));

line('BEAT 5 - upsell at the third free session (C003 Meera)');
summarise(await post('/session/demo-c/message', { customerId: 'C003', text: 'tell me about the styling advisory plan' }));

line('BEAT 6 - accept, then loyalty accrual reads the new entitlement');
summarise(await post('/session/demo-c/message', { customerId: 'C003', text: 'accept' }));
const loy = await post('/session/demo-c/message', { customerId: 'C003', text: 'how many points did I earn?' });
summarise(loy);
console.log('multiplier applied:', loy.payload.multiplier, 'entitlement:', loy.payload.entitlement);

line('BEAT 6b - fairness guardrail BLOCKS an excluding ranking (unsafe mode)');
const unsafe = await post('/session/demo-x/message', { customerId: 'C001', text: 'show me an occasion dress', unsafeRanking: true });
summarise(unsafe);
console.log('guardrail detail:', unsafe.trace.filter((t: any) => t.stage === 'policy').map((t: any) => t.detail).join(' | '));

line('BEAT 7 - permission enforcement: discovery agent tries a loyalty tool');
const denied = await (await fetch('http://localhost:8102/invoke', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ agent: 'discovery', tool: 'loyalty.accrue', args: { customer_id: 'C001', base_points: 999 } }),
})).json() as any;
console.log(JSON.stringify(denied, null, 2));

line('BEAT 7b - install a tool contract at runtime (KV write, no redeploy)');
const contract = {
  name:'catalogue.trending.get', version:'1.0.0',
  purpose:'Trending SKUs in a category, derived from order volume.',
  allowed_agents:['discovery'],
  input_schema:{ category:{type:'string',required:true}, days:{type:'integer',required:false,default:30} },
  output_schema:{ category:'string', trending:'array' },
  transport:{ service:'services', method:'GET', path:'/catalogue/trending/{category}' },
};
const installed = await (await fetch('http://localhost:8102/registry/install', {
  method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(contract) })).json() as any;
console.log(`registry ${installed.before} -> ${installed.after}`);
const used = await (await fetch('http://localhost:8102/invoke', {
  method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ agent:'discovery', tool:'catalogue.trending.get', args:{ category:'dresses' } }) })).json() as any;
console.log('new tool callable immediately:', used.ok, '-', used.data?.trending?.length, 'rows');
await fetch('http://localhost:8102/registry/reset', { method:'POST' });

line('BEAT 8 - modelled business outcome from the live corpus');
console.log(JSON.stringify(await get('/outcome'), null, 2));

line('TOKEN ACCOUNTING');
console.log(JSON.stringify(await (await fetch('http://localhost:8103/usage')).json(), null, 2));

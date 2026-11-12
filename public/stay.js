const $ = s => document.querySelector(s);
const money = n => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let current, config;
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await res.json(); if (!res.ok) throw Error(data.error || 'Request failed'); return data;
}
function fail(e){$('#error').textContent=e.message;$('#error').hidden=false;$('#error').scrollIntoView({behavior:'smooth',block:'nearest'});}
function payLink(url){const u=new URL(url);if(u.protocol!=='https:'||!['www.sandbox.paypal.com','sandbox.paypal.com'].includes(u.hostname))throw Error('Unexpected payment address');location.assign(url);}
async function busy(fn){$('#error').hidden=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn()}catch(e){fail(e)}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false)}}
const days = n => n===0 ? 'today' : n===1 ? '1 day' : `${n} days`;
const planText = (plan, o) => plan==='hold'
  ? `Check-in is within ${config.honorDays} days, so PayPal holds ${money(o.totalCents)} now and the hotel is paid at check-in.`
  : `Check-in is more than ${config.honorDays} days away, longer than PayPal guarantees a hold. So you pay ${money(o.totalCents)} at booking, and a cancellation in time refunds it.`;
const cancelText = p => !p ? '' : p.kind==='void' ? 'Cancelling now is free: the hold is released and nothing is charged.'
  : p.kind==='fee' ? `Cancelling now is late: the first night, ${money(p.chargedCents)}, is charged and the rest of the hold is released.`
  : p.kind==='refund_full' ? `Cancelling now is free: all ${money(p.refundCents)} is refunded.`
  : `Cancelling now is late: ${money(p.refundCents)} is refunded and the first night, ${money(p.chargedCents)}, is kept.`;

function board(t){
  if(!t.rounds.length) return '';
  const best = t.selectedOfferId;
  const hotels = config.hotels.filter(h=>t.rules.hotelIds.includes(h.id));
  const cell = o => { if(!o) return '<td class="cell none">no offer</td>';
    const cls = !o.qualifies ? 'out' : o.meetsTarget ? 'meets' : 'above';
    return `<td class="cell ${cls} ${o.id===best?'best':''}" title="${esc(o.reasons.join(' · '))}"><b>${money(o.totalCents)}</b><small>${money(o.nightCents)} a night${o.discountPct?` · −${o.discountPct}%`:''}</small><small>${!o.qualifies?esc(o.reasons[0]):o.meetsTarget?'meets your target':'above your target'}</small><small>total for ${o.nights} night${o.nights>1?'s':''} with taxes</small></td>`; };
  return `<div class="board-wrap"><table class="board"><thead><tr><th>Hotel<small>public rate</small></th>${t.rounds.map(r=>`<th>Round ${r.round}<small>${r.daysToCheckIn===0?'check-in day':days(r.daysToCheckIn)+' out'}</small></th>`).join('')}</tr></thead><tbody>${hotels.map(h=>`<tr><th>${esc(h.name)}<small>${money(h.listCents)} a night · ${h.connected?'payment connected':'quote only'}</small></th>${t.rounds.map(r=>cell(r.offers.find(o=>o.hotelId===h.id))).join('')}</tr>`).join('')}</tbody></table></div><p class="legend"><span class="key meets"></span>meets your ${money(t.rules.targetCents)} target <span class="key above"></span>under your ${money(t.rules.capCents)} maximum <span class="key out"></span>fails a rule · totals include taxes · your numbers are never sent to hotels</p>`;
}
function offerCard(t,o){
  return `<article class="quote selected"><div class="quote-head"><div><h3>${esc(o.hotelName)}</h3><p>Simulated hotel agent · ${o.connected?'connected test merchant':'quote only'} · round ${o.round}</p></div><strong>${money(o.totalCents)}</strong></div>
  <div class="money-row"><span>Public rate</span><span>${money(o.listNightCents)} a night</span></div><div class="money-row"><span>Private offer for this request</span><span><b>${money(o.nightCents)} a night</b>${o.discountPct?` (−${o.discountPct}%)`:''}</span></div><div class="money-row"><span>${o.nights} night${o.nights>1?'s':''}</span><span>${money(o.subtotalCents)}</span></div><div class="money-row"><span>Taxes and fees</span><span>${money(o.taxCents)}</span></div>
  <p>Cancellation: free until ${days(o.freeCancelDays)} before check-in. After that the first night, ${money(o.lateFeeCents)}, is charged.<br>Offer valid until ${new Date(o.expiresAt).toLocaleTimeString()}. No loyalty signup, no marketing consent.</p><span class="tag">${o.meetsTarget?'Meets your target and passes every check':'Passes every check; above your target'}</span></article>`;
}
function payment(t){
  if(!t.started) return '';
  const o=t.bookedOffer, tt=t.totals;
  let h=`<div class="pay"><p class="eyebrow">PAYMENT · ${esc(o.hotelName)} is the receiver</p><p class="hint">${t.plan==='hold'?'Hold now, pay at check-in.':'Pay at booking, refundable.'} ${esc(planText(t.plan,o))}</p>
  <div class="limits"><div><small>HELD</small><b>${money(tt.heldCents)}</b></div><div><small>CHARGED</small><b>${money(tt.chargedCents)}</b></div><div><small>REFUNDED</small><b>${money(tt.refundedCents)}</b></div><div><small>NET PAID</small><b>${money(tt.netPaidCents)}</b></div></div>`;
  if(t.ledger.length) h+=`<ol class="ledger">${t.ledger.map(e=>`<li class="${e.type.toLowerCase()}"><div><strong>${({AUTHORIZED:'Held',CAPTURED:'Charged',VOIDED:'Released',REFUNDED:'Refunded'})[e.type]} ${money(e.amountCents)}</strong><span class="verify ${e.verified?'ok':'no'}">${e.verified?'read back from PayPal ✓':'needs checking'}</span></div>${esc(e.note)}<br><code>${esc(e.paypalId)} · ${esc(e.paypalStatus)}</code> <time>${esc(e.at)}</time></li>`).join('')}</ol>`;
  return h+'</div>';
}
function render(t){current=t;window.history.replaceState({},'',`/stay.html?task=${t.id}`);
  const o=t.rounds.at(-1)?.offers.find(x=>x.id===t.selectedOfferId);
  const titles={open:!t.rounds.length?'Your request is set.':!o?'No offer fits yet.':o.meetsTarget?'An offer meets your target.':'Close, but above your target.',creating_payment:'Starting payment.',awaiting_approval:'Ready for your approval.',held:'Booked. Held, not charged.',paid:'Booked and paid.',completed:'Checked in. Booking complete.',voided:'Cancelled. Nothing charged.',fee_captured:'Cancelled late. First night charged.',refunded:'Cancelled and refunded.',cancelled:'Request cancelled.',needs_review:'Let’s check the payment.'};
  $('#task-heading').textContent=titles[t.status];
  let h=`<span class="status">${esc(t.status.replaceAll('_',' '))}</span><p class="summary">${esc(t.rules.request)}</p><div class="limits"><div><small>CHECK-IN · DEMO CLOCK</small><b>${t.daysToCheckIn===0?'Today':'In '+days(t.daysToCheckIn)}</b></div><div><small>STAY</small><b>${t.rules.nights} night${t.rules.nights>1?'s':''} · ${t.rules.guests} guest${t.rules.guests>1?'s':''}</b></div><div><small>TARGET</small><b>${money(t.rules.targetCents)}</b></div><div><small>MAXIMUM</small><b>${money(t.rules.capCents)}</b></div></div>`;
  if(t.problem)h+=`<p class="problem">${esc(t.problem)}</p>`;
  h+=board(t);
  const btn=(label,act,primary=false)=>`<button ${primary?'class="primary"':''} data-action="${act}">${label}</button>`;
  if(t.status==='open'){
    if(o)h+=offerCard(t,o);
    else if(t.rounds.length)h+='<p class="problem">No offer passed your rules this round. Nothing was booked. Waiting may help: these hotels lower their private rates as check-in approaches.</p>';
    const d=t.daysToCheckIn, suggest=d>10?d-10:d>5?d-5:d>3?d-3:1;
    const wait=d>0&&t.rounds.length?`<span class="waitbox"><button ${o&&o.meetsTarget?'':'class="primary"'} data-action="wait">Wait and ask again ↗</button><label>days to wait <input id="wait-days" type="number" min="1" max="${d}" value="${suggest}"></label></span>`:'';
    h+='<div class="actions">';
    if(!t.rounds.length)h+=btn('Ask the hotels for offers ↗','ask',true);
    else if(o&&o.connected&&o.meetsTarget)h+=btn(`Book ${money(o.totalCents)} in PayPal ↗`,'book',true)+wait;
    else if(o&&o.connected)h+=wait+btn(`Book ${money(o.totalCents)} anyway in PayPal ↗`,'book',!wait);
    else h+=wait;
    h+=btn('Cancel request','cancel')+'</div>';
    if(o&&!o.connected)h+=`<p class="hint">${esc(o.hotelName)} is quote-only in this demo, so it can't be booked. Only Casa Aurora has a PayPal test merchant.</p>`;
    if(o&&o.connected)h+=`<p class="hint"><b>If you book now:</b> ${esc(planText(t.planIfBookedNow,o))}</p>`;
    if(t.rounds.length&&d>0)h+='<p class="hint">Waiting moves the demo clock forward and asks again. Nothing is bought while you wait.</p>';
  }
  h+=payment(t);
  if(t.started){h+='<div class="actions">';
    if(t.status==='awaiting_approval'&&t.approveUrl)h+=btn('Approve in PayPal ↗','approve-link',true);
    if(['awaiting_approval','needs_review','creating_payment'].includes(t.status))h+=btn('Check PayPal status','check');
    if(['held','paid'].includes(t.status)){h+=btn(t.status==='held'?`Check in: charge ${money(t.bookedOffer.totalCents)} from the hold`:'Check in: already paid','checkin',true);
      if(t.daysToCheckIn>0)h+=`<span class="waitbox"><button data-action="advance">Move the clock forward</button><label>days <input id="adv-days" type="number" min="1" max="${t.daysToCheckIn}" value="${Math.min(2,t.daysToCheckIn)}"></label></span>`;
      h+=btn('Cancel booking','cancel');}
    if(t.status==='awaiting_approval')h+=btn('Cancel','cancel');
    h+='</div>';
    if(t.cancelPreview)h+=`<p class="hint">${esc(cancelText(t.cancelPreview))}</p>`;}
  if(t.rounds.length)h+=`<details><summary>What each hotel received</summary><p class="hint">Every hotel gets the same request each round. It has no name, no email, no target and no maximum.</p><pre class="exchange-pre">${esc(JSON.stringify(t.request,null,1))}</pre></details>`;
  h+=`<details><summary>Activity log</summary><ol class="trace">${t.trace.map(e=>`<li><strong>${esc(e.actor)}</strong>${esc(e.text)}<br><time>${esc(e.at)}</time></li>`).join('')}</ol></details>`;
  $('#task').innerHTML=h;
  $('#task').querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{const a=b.dataset.action;
    if(a==='approve-link')return payLink(t.approveUrl);
    busy(async()=>{const body=a==='wait'?{waitDays:Number($('#wait-days').value)}:a==='advance'?{days:Number($('#adv-days').value)}:{};
      const path=a==='wait'?'ask':a; current=await api(`/api/stays/${t.id}/${path}`,body);render(current);await loadHistory();
      if(a==='book'&&current.approveUrl)payLink(current.approveUrl);});});
}
async function loadHistory(){const list=await api('/api/stays');$('#history-panel').hidden=!list.length;$('#history').innerHTML=list.reverse().slice(0,8).map(t=>`<button class="history-item" data-id="${t.id}">${esc(t.status.replaceAll('_',' '))} · ${t.rules.nights} nights · target ${money(t.rules.targetCents)} · round ${t.round}</button>`).join('');$('#history').querySelectorAll('button').forEach(b=>b.onclick=()=>busy(async()=>render(await api('/api/stays/'+b.dataset.id))));}
$('#plan-form').onsubmit=e=>{e.preventDefault();busy(async()=>{const cents=s=>{if(!/^\d+(\.\d{1,2})?$/.test(s))throw Error('Enter money with at most two decimal places.');return Math.round(Number(s)*100)};
  const rules={request:$('#request').value,hotelIds:[...document.querySelectorAll('[name=hotel]:checked')].map(x=>x.value),nights:Number($('#nights').value),guests:Number($('#guests').value),mustHaves:[...document.querySelectorAll('[name=must]:checked')].map(x=>x.value),targetCents:cents($('#target').value),capCents:cents($('#cap').value),startDays:Number($('#start').value)};
  render(await api('/api/stays',{confirmed:$('#confirmed').checked,rules}));await loadHistory();$('#task-heading').scrollIntoView({behavior:'smooth',block:'center'});});};
$('#interpret').onclick=()=>busy(async()=>{const s=await api('/api/stay-interpret',{request:$('#request').value});
  $('#nights').value=s.nights;$('#guests').value=s.guests;$('#start').value=s.startDays;document.querySelectorAll('[name=must]').forEach(x=>x.checked=s.mustHaves.includes(x.value));perNight();
  $('#ai-result').innerHTML=`<b>Suggested by AI. Please check and confirm below.</b><p>${esc(s.understood)}</p><ul>${s.reasoning.map(r=>`<li>${esc(r)}</li>`).join('')}${s.unsure.map(r=>`<li>Not sure: ${esc(r)}</li>`).join('')}</ul>`;$('#ai-result').hidden=false;});
function perNight(){const n=Number($('#nights').value)||1;for(const k of ['target','cap']){const v=Number($('#'+k).value);$('#'+k+'-night').textContent=v>0?`For ${n} night${n>1?'s':''} that is about ${money(Math.round(v*100/n/1.1))} a night before 10% taxes.`:'';}}
['nights','target','cap'].forEach(k=>$('#'+k).addEventListener('input',perNight));
async function init(){config=await api('/api/stay-config');perNight();const c=await api('/api/config');$('#connection').textContent=c.connected?'● Sandbox connected':'Sandbox offline';
  $('#interpret').hidden=!config.modelConnected;if(config.modelConnected){$('#ai-note').textContent='AI (Claude) reads your request and suggests the details; code sets every amount and checks every rule.';$('#ai-hint').textContent='The AI suggests nights, guests, timing and must-haves. It never sets a price. You confirm everything below.';}
  $('#musts').innerHTML=Object.entries(config.amenities).map(([k,v])=>`<label class="chip"><input type="checkbox" name="must" value="${esc(k)}" ${k==='breakfast'?'checked':''}> ${esc(v)}</label>`).join('');
  $('#hotels').innerHTML=config.hotels.map(h=>`<label class="choice product"><input type="checkbox" name="hotel" value="${esc(h.id)}" checked><span><b>${esc(h.name)}</b><i>${h.connected?'Payment connected':'Quote only'}</i><small>${'★'.repeat(h.stars)} · fictional hotel in ${esc(config.city)} · public rate ${money(h.listCents)} a night<br>${h.amenities.map(a=>esc(config.amenities[a])).join(' · ')}</small></span></label>`).join('');
  const q=new URLSearchParams(location.search);if(q.get('task'))render(await api('/api/stays/'+encodeURIComponent(q.get('task'))));if(q.has('notice'))fail(Error('The PayPal return needs checking. Press "Check PayPal status".'));await loadHistory();}
init().catch(fail);

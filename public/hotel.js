const $ = s => document.querySelector(s);
const money = n => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await res.json(); if (!res.ok) throw Error(data.error || 'Request failed'); return data;
}
function fail(e){$('#error').textContent=e.message;$('#error').hidden=false;$('#error').scrollIntoView({behavior:'smooth',block:'nearest'});}
const cents = s => { if(!/^\d+(\.\d{1,2})?$/.test(s)) throw Error('Enter money with at most two decimal places.'); return Math.round(Number(s)*100); };
const label = {held:'Held, not charged',paid:'Paid at booking',completed:'Checked in and paid',voided:'Cancelled, hold released',fee_captured:'Cancelled late, first night charged',refunded:'Cancelled and refunded',needs_review:'Payment needs checking'};
function render(list){
  $('#hotels').innerHTML = list.map(h => { const vals=h.preview.map(p=>p.nightCents), max=Math.max(...vals), min=Math.min(...vals);
    return `<section class="panel"><p class="eyebrow">${h.connected?'PAYPAL TEST MERCHANT CONNECTED':'QUOTE ONLY · NO PAYMENT CONNECTION'}</p><h2>${esc(h.name)}</h2>
  <p class="hint">${'★'.repeat(h.stars)} · public rate ${money(h.listCents)} a night · taxes ${h.taxBps/100}% · ${h.amenities.map(esc).join(' · ')}</p>
  <form data-id="${esc(h.id)}"><div class="form-grid">
   <div><label>Lowest private rate · USD a night</label><input name="floor" type="number" step="0.01" min="50" max="${(h.listCents/100).toFixed(2)}" value="${(h.rule.floorCents/100).toFixed(2)}" required></div>
   <div><label>Start discounting · days before check-in</label><input name="window" type="number" step="1" min="1" max="60" value="${h.rule.windowDays}" required></div>
   <div><label>Demand for these dates</label><select name="demand"><option value="soft" ${h.rule.demand==='soft'?'selected':''}>Soft: rooms still empty, rate falls</option><option value="strong" ${h.rule.demand==='strong'?'selected':''}>Strong: filling up, rate rises</option></select></div>
   <div><label>Free cancellation until · days before</label><input name="cancel" type="number" step="1" min="0" max="30" value="${h.rule.freeCancelDays}" required></div>
   <div><label class="choice"><input name="active" type="checkbox" ${h.rule.active?'checked':''}><span><b>Answer booking requests</b><small>Untick to stop sending offers.</small></span></label></div>
  </div><button type="submit" class="primary">Save offer rule <span>↗</span></button></form>
  <p class="eyebrow" style="margin-top:22px">WHAT YOUR AGENT OFFERS, BY DAYS BEFORE CHECK-IN</p>
  <div class="curve">${h.preview.map(p=>`<div class="bar"><i style="height:${Math.round(18+62*(max===min?1:(p.nightCents-min)/(max-min)))}px" class="${p.nightCents<h.listCents?'cut':p.nightCents>h.listCents?'rise':''}"></i><b>${money(p.nightCents).replace('.00','')}</b><small>${p.days===0?'day of':p.days+'d'}</small></div>`).join('')}</div>
  <p class="hint">${h.rule.demand==='strong'?'Rooms are filling for these dates, so your agent raises the rate toward check-in, up to 15% above your public rate.':'An empty room earns nothing, so with soft demand the private rate slides from your public rate to your lowest rate as the date approaches.'} Guests never see this rule, only each offer.</p>
  <details ${h.bookings.length?'open':''}><summary>Bookings and payments (${h.bookings.length})</summary>${h.bookings.length?h.bookings.map(b=>`<div class="exchange"><h3>${esc(label[b.status]||b.status)} · ${money(b.totalCents)} · ${b.nights} night${b.nights>1?'s':''}</h3><p>Check-in ${b.daysToCheckIn===0?'today':'in '+b.daysToCheckIn+' day(s)'} · ${b.plan==='hold'?'hold now, pay at check-in':'paid at booking, refundable'}<br>Held ${money(b.totals.heldCents)} · charged ${money(b.totals.chargedCents)} · refunded ${money(b.totals.refundedCents)} · <b>you keep ${money(b.totals.netPaidCents)}</b></p>${b.ledger.map(e=>`<small>${esc(e.type)} ${money(e.amountCents)} · ${esc(e.paypalId)} · ${esc(e.paypalStatus)}</small><br>`).join('')}${['held','paid'].includes(b.status)?`<div class="actions"><button data-hotel="${esc(h.id)}" data-task="${esc(b.taskId)}" data-act="checkin">Guest checked in</button><button data-hotel="${esc(h.id)}" data-task="${esc(b.taskId)}" data-act="cancel">We can't honour it: ${b.hotelCancel?.kind==='void'?'release the hold':'refund in full'}</button></div>`:''}</div>`).join(''):'<p class="empty">No bookings yet.</p>'}</details>
  <details><summary>Requests your agent received (${h.inbox.length})</summary>${h.inbox.length?`<ol class="trace">${h.inbox.map(m=>`<li><strong>${esc(m.outcome)}</strong>Round ${m.round} · ${m.daysToCheckIn} day(s) before check-in · ${m.request.nights} night(s), ${m.request.guests} guest(s)${m.request.mustHaves.length?' · needs '+m.request.mustHaves.map(esc).join(', '):''}<br>Your agent offered ${money(m.nightCents)} a night, ${money(m.totalCents)} with taxes. The request excluded the guest's name, email, target and maximum.<br><time>${esc(m.at)}</time></li>`).join('')}</ol>`:'<p class="empty">No requests yet. Create one in the Stays view.</p>'}</details></section>`; }).join('');
  document.querySelectorAll('form[data-id]').forEach(f => f.onsubmit = async e => { e.preventDefault(); $('#error').hidden = true;
    try { render(await api('/api/hotels/'+f.dataset.id, { floorCents: cents(f.floor.value), windowDays: Number(f.window.value), freeCancelDays: Number(f.cancel.value), active: f.active.checked, demand: f.demand.value })); } catch (err) { fail(err); } });
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => { $('#error').hidden = true; b.disabled = true;
    try { render(await api(`/api/hotels/${b.dataset.hotel}/bookings/${b.dataset.task}/${b.dataset.act}`, {})); } catch (err) { fail(err); b.disabled = false; } });
}
$('#reset').onclick = async () => { try { render(await api('/api/hotels/reset', {})); } catch (e) { fail(e); } };
api('/api/hotels').then(render).catch(fail);

const $ = s => document.querySelector(s);
const money = n => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await res.json(); if (!res.ok) throw Error(data.error || 'Request failed'); return data;
}
function fail(e){$('#error').textContent=e.message;$('#error').hidden=false;}
const cents = s => { if(!/^\d+(\.\d{1,2})?$/.test(s)) throw Error('Enter money with at most two decimal places.'); return Math.round(Number(s)*100); };
function render(list){
  $('#roasters').innerHTML = list.map(r => `<section class="panel"><div class="section-top"><div><p class="eyebrow">${r.connected?'PAYPAL TEST MERCHANT CONNECTED':'QUOTE ONLY · NO PAYMENT CONNECTION'}</p><h2>${esc(r.name)}</h2></div></div>
  <p class="hint">${r.products.map(esc).join(' · ')} · list price ${money(r.listCents)} per 250 g bag · tax ${money(r.taxCentsPerBag)} per bag</p>
  <form data-id="${esc(r.id)}"><div class="form-grid">
   <div><label>One-time offer price per bag · USD</label><input name="floor" type="number" step="0.01" min="5" max="${(r.listCents/100).toFixed(2)}" value="${(r.rule.floorCents/100).toFixed(2)}" required><p class="hint">Private. Shown only inside quotes your agent sends.</p></div>
   <div><label>Shipping · USD</label><input name="shipping" type="number" step="0.01" min="0" max="20" value="${(r.rule.shippingCents/100).toFixed(2)}" required></div>
   <div><label>Ships within · days</label><input name="days" type="number" step="1" min="1" max="30" value="${r.rule.deliveryDays}" required></div>
   <div><label class="choice"><input name="active" type="checkbox" ${r.rule.active?'checked':''}><span><b>Answer buyer requests</b><small>Untick to stop sending quotes.</small></span></label></div>
  </div><button type="submit" class="primary">Save offer rule <span>↗</span></button></form>
  <details open><summary>Requests your agent received (${r.inbox.length})</summary>${r.inbox.length?`<ol class="trace">${r.inbox.map(m=>`<li><strong>${esc(m.outcome)}</strong>Round ${m.round} · wants ${m.request.quantity} × ${m.request.productIds.map(esc).join(' or ')} within ${m.request.deliverWithinDays} days · one-time, no subscription, no marketing consent<br>Your agent answered ${money(m.answeredTotalCents)} all-in (${money(m.unitCents)} per bag, ${m.deliveryDays} days). Buyer: anonymous. Budget: not shared.<br><time>${esc(m.receivedAt)}</time></li>`).join('')}</ol>`:'<p class="empty">No requests yet. Create a task in the buyer view.</p>'}</details></section>`).join('');
  document.querySelectorAll('form[data-id]').forEach(f => f.onsubmit = async e => { e.preventDefault(); $('#error').hidden = true;
    try { render(await api('/api/roasters/'+f.dataset.id, { floorCents: cents(f.floor.value), shippingCents: cents(f.shipping.value), deliveryDays: Number(f.days.value), active: f.active.checked })); } catch (err) { fail(err); } });
}
$('#reset').onclick = async () => { try { render(await api('/api/roasters/reset', {})); } catch (e) { fail(e); } };
api('/api/roasters').then(render).catch(fail);

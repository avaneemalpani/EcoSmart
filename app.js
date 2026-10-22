const API = '/api';
let selectedFiles = [];

const itemOptions = `
  <option value="">Select device</option>
  <option value="laptop">Laptop / Desktop</option>
  <option value="mobile">Mobile Phone</option>
  <option value="tablet">Tablet</option>
  <option value="charger">Charger / Adapter</option>
  <option value="battery">Battery</option>
  <option value="other">Other e-waste</option>`;

const conditionOptions = `
  <option value="">Select condition</option>
  <option>Working</option>
  <option>Damaged but partly working</option>
  <option>Screen broken</option>
  <option>Not switching on / dead</option>
  <option>Battery damaged or swollen</option>
  <option>Other issue</option>`;

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
const token = () => localStorage.getItem('ecosmartToken') || '';

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(API + path, { ...options, headers });
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function setMessage(id, text, type = 'notice') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `notice ${type}`;
  el.classList.remove('hidden');
}

function trackingIdFrom(pickup) { return pickup?.tracking_id || pickup?.trackingId || 'Pending'; }

function addItemRow() {
  const container = document.getElementById('itemsContainer');
  if (!container) return;
  const itemNumber = container.children.length + 1;
  const item = document.createElement('div');
  item.className = 'item-row card';
  item.innerHTML = `
    <div class="item-row-head"><b>Item ${itemNumber}</b>${itemNumber > 1 ? '<button type="button" class="icon-button remove-item">×</button>' : ''}</div>
    <div class="form-grid">
      <div class="field">
        <label>E-waste type</label>
        <select class="item-type" required>${itemOptions}</select>
      </div>
      <div class="field">
        <label>Condition / issue</label>
        <select class="item-condition" required>${conditionOptions}</select>
      </div>
      <div class="field full issue-wrap hidden">
        <label>Describe the exact issue</label>
        <textarea class="item-issue" placeholder="Write the exact issue with this device..."></textarea>
      </div>
    </div>`;
  container.appendChild(item);
  item.querySelector('.item-condition').addEventListener('change', e => {
    item.querySelector('.issue-wrap').classList.toggle('hidden', e.target.value !== 'Other issue');
  });
  item.querySelector('.remove-item')?.addEventListener('click', () => {
    item.remove();
    [...container.children].forEach((row, index) => row.querySelector('.item-row-head b').textContent = `Item ${index + 1}`);
    validatePhotos();
  });
}

function collectItems() {
  return [...document.querySelectorAll('#itemsContainer .item-row')].map(row => ({
    type: row.querySelector('.item-type')?.value,
    condition: row.querySelector('.item-condition')?.value,
    issueDetails: row.querySelector('.item-issue')?.value || ''
  }));
}

function validatePhotos() {
  const input = document.getElementById('photo');
  const items = document.querySelectorAll('#itemsContainer .item-row').length;
  if (!input) return true;
  if (selectedFiles.length < items) {
    input.setCustomValidity(`Please upload at least ${items} photo(s).`);
    return false;
  }
  input.setCustomValidity('');
  return true;
}

function previewPhotos() {
  const input = document.getElementById('photo');
  if (!input) return;
  selectedFiles = [...selectedFiles, ...input.files].filter((file, index, all) => index === all.findIndex(f => f.name === file.name && f.size === file.size));
  displayPreviews();
}

function displayPreviews() {
  const container = document.getElementById('previewContainer');
  if (!container) return;
  container.innerHTML = selectedFiles.map((file, index) => `
    <div class="photo-preview">
      <img src="${URL.createObjectURL(file)}" alt="Selected e-waste photo">
      <button type="button" class="remove-photo" onclick="removePhoto(${index})">×</button>
      <small>${escapeHtml(file.name)}</small>
    </div>`).join('');
  updateFileInput();
  validatePhotos();
}

window.removePhoto = index => { selectedFiles.splice(index, 1); displayPreviews(); };

function updateFileInput() {
  const input = document.getElementById('photo');
  if (!input || typeof DataTransfer === 'undefined') return;
  const dt = new DataTransfer();
  selectedFiles.forEach(file => dt.items.add(file));
  input.files = dt.files;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadSlots() {
  const area = document.getElementById('area');
  const slot = document.getElementById('slot');
  if (!area || !slot) return;
  slot.innerHTML = '<option value="">Select a pickup slot</option>';
  if (!area.value) return;
  try {
    const data = await api('/areas');
    (data.slots[area.value] || []).forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      slot.appendChild(option);
    });
  } catch (error) { setMessage('formMessage', error.message, 'error'); }
}

function goToStep(step) {
  document.querySelectorAll('.pickup-step').forEach(el => el.classList.remove('active'));
  document.querySelector(`.pickup-step[data-step="${step}"]`)?.classList.add('active');
  document.querySelectorAll('.wizard-dot').forEach(el => el.classList.toggle('active', Number(el.dataset.step) <= step));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function validateStep(step) {
  if (step === 1) {
    const items = collectItems();
    if (!items.length || items.some(item => !item.type || !item.condition)) {
      setMessage('formMessage', 'Please complete every e-waste item before continuing.', 'error');
      return false;
    }
  }
  if (step === 2) {
    if (!validatePhotos()) { setMessage('formMessage', 'Please upload at least one clear photo for each item.', 'error'); return false; }
    if (selectedFiles.some(file => file.size > 5 * 1024 * 1024)) { setMessage('formMessage', 'Each image must be smaller than 5 MB.', 'error'); return false; }
  }
  if (step === 3) {
    for (const id of ['name','contact','area','address','slot','handover']) {
      const el = document.getElementById(id);
      if (!el?.value.trim()) { el?.focus(); setMessage('formMessage', 'Please complete all pickup details.', 'error'); return false; }
    }
  }
  return true;
}

async function submitPickup(event) {
  event.preventDefault();
  if (!token()) { location.href = 'login.html?next=pickup.html'; return; }
  if (![1,2,3].every(validateStep)) return;
  const button = event.submitter || event.target.querySelector('button[type="submit"]');
  if (button) { button.disabled = true; button.textContent = 'Submitting…'; }
  try {
    const photos = await Promise.all(selectedFiles.map(fileToDataUrl));
    const items = collectItems();
    const payload = {
      area: document.getElementById('area').value,
      address: document.getElementById('address').value,
      slot: document.getElementById('slot').value,
      handover: document.getElementById('handover').value,
      description: document.getElementById('description').value,
      items,
      photos
    };
    const data = await api('/pickups', { method: 'POST', body: JSON.stringify(payload) });
    sessionStorage.setItem('ecosmartLastPickup', JSON.stringify(data.pickup));
    setMessage('formMessage', `🎉 Pickup ${data.pickup.tracking_id} has been submitted. Your request is waiting for admin verification.`, 'success');
    document.getElementById('packingModal')?.classList.remove('hidden');
    event.target.reset();
    selectedFiles = [];
    document.getElementById('previewContainer').innerHTML = '';
    document.getElementById('itemsContainer').innerHTML = '';
    addItemRow();
    document.getElementById('slot').innerHTML = '<option value="">Select area first</option>';
    goToStep(1);
    document.getElementById('successCard')?.classList.remove('hidden');
  } catch (error) { setMessage('formMessage', error.message, 'error'); }
  finally { if (button) { button.disabled = false; button.textContent = 'Confirm Pickup →'; } }
}

function statusIndex(status) { return ({ pending:0, assigned:2, collected:3, recycled:5, rejected:-1 }[status] ?? 0); }

function renderTimeline(pickup) {
  const timeline = document.getElementById('timeline');
  if (!timeline) return;
  if (!pickup) {
    timeline.innerHTML = '<div class="empty-state"><span>♻️</span><b>No pickup scheduled yet</b><small>Schedule your first pickup to start your EcoSmart journey.</small><a class="btn primary" href="pickup.html">Schedule pickup</a></div>';
    return;
  }
  if (pickup.status === 'rejected') {
    timeline.innerHTML = `<div class="notice error"><b>Request needs attention</b><br>${escapeHtml(pickup.notification || 'Your request was rejected.')}</div>`;
    return;
  }
  const stages = [
    ['Request submitted','Your request has been received.'],
    ['Admin verification','Our team reviews the request and photos.'],
    ['Agent assigned','A collection agent is assigned to your pickup.'],
    ['Collected','Your e-waste has been safely handed over.'],
    ['Processing','Your items are being routed for responsible processing.'],
    ['Recycled + points','Your recycling impact and EcoPoints are confirmed.']
  ];
  const current = statusIndex(pickup.status);
  timeline.innerHTML = stages.map((stage,index) => {
    const done = index <= current;
    return `<div class="step ${done ? 'done' : ''}"><div class="dot">${done ? '✓' : index+1}</div><div><p>${stage[0]}</p><small>${index === 0 ? new Date(pickup.created_at).toLocaleString() : stage[1]}</small></div></div>`;
  }).join('');
}

function renderTracking(pickup) {
  const panel = document.getElementById('gpsTracking');
  if (!panel) return;
  if (!pickup || !['assigned','collected','recycled'].includes(pickup.status)) {
    panel.innerHTML = `<div class="tracking-empty"><span>🚚</span><div><h3>Collection tracking</h3><p>Your collection agent will appear here after admin assignment.</p></div></div>`;
    return;
  }
  const gps = pickup.gps;
  const distance = pickup.status === 'assigned' ? '1.8 km away' : pickup.status === 'collected' ? 'Pickup completed' : 'Recycling completed';
  panel.innerHTML = `
    <div class="tracking-head"><div><span class="eyebrow">Live pickup</span><h3>🚚 ${escapeHtml(pickup.agent_name || 'EcoSmart Agent')}</h3></div><span class="tag">${escapeHtml(pickup.status)}</span></div>
    <div class="map-box">
      <div class="map-grid"></div><div class="map-user">🏠</div><div class="map-route"></div><div class="map-agent">🚚</div>
      <div class="map-label">${distance}</div>
    </div>
    <div class="tracking-meta"><div><b>Tracking ID</b><span>${escapeHtml(pickup.tracking_id)}</span></div><div><b>ETA</b><span>${pickup.status === 'assigned' ? '12–20 min' : 'Completed'}</span></div><div><b>Location</b><span>${gps ? `${Number(gps.latitude).toFixed(4)}, ${Number(gps.longitude).toFixed(4)}` : 'Updating…'}</span></div></div>`;
}

async function renderDashboard() {
  const timeline = document.getElementById('timeline');
  if (!timeline) return;
  if (!token()) { timeline.innerHTML = '<div class="empty-state"><span>🔐</span><b>Login to view your dashboard</b><a class="btn primary" href="login.html?next=dashboard.html">Login</a></div>'; return; }
  try {
    const [dashboard, latest, notifications, certificate, pickupData] = await Promise.all([api('/dashboard'), api('/pickups/latest'), api('/notifications'), api('/certificate/latest'), api('/pickups')]);
    const p = latest.pickup;
    document.getElementById('points').textContent = dashboard.user.ecoPoints;
    document.getElementById('progress').style.width = `${dashboard.level.progress}%`;
    document.getElementById('progressText').textContent = dashboard.level.next ? `${dashboard.user.ecoPoints} / ${dashboard.level.next} points to the next level` : 'Maximum Eco level reached 🌎';
    document.getElementById('ecoLevel').textContent = dashboard.level.name;
    document.getElementById('ecoLevelProgress').style.width = `${dashboard.level.progress}%`;
    document.getElementById('impactWeight').textContent = dashboard.stats.weight;
    document.getElementById('devicesRecycled').textContent = dashboard.stats.devices;
    document.getElementById('pickupsCompleted').textContent = dashboard.stats.completedPickups;
    document.getElementById('impactCo2').textContent = dashboard.stats.impactScore;
    document.getElementById('ecoLevelText').textContent = dashboard.level.next ? `${dashboard.user.ecoPoints} / ${dashboard.level.next} points` : 'You reached the highest level.';
    const achievements = document.getElementById('achievements');
    if (achievements) achievements.innerHTML = dashboard.achievements.map(a => `<div class="achievement ${a.earned ? 'earned' : ''}"><span>${a.icon}</span><b>${a.name}</b><small>${a.desc}</small>${a.earned ? '<em>Unlocked ✓</em>' : '<em>Locked</em>'}</div>`).join('');
    renderTimeline(p); renderTracking(p);
    renderPickupHistory(pickupData.pickups || []);
    document.querySelectorAll('[data-cost]').forEach(button => button.disabled = dashboard.user.ecoPoints < Number(button.dataset.cost));
    const notificationBox = document.getElementById('notificationBox');
    if (notificationBox) {
      const unread = notifications.notifications.filter(n => !n.read);
      notificationBox.innerHTML = unread.length ? `<b>🔔 ${unread.length} new update${unread.length > 1 ? 's' : ''}</b><p>${escapeHtml(unread[0].message)}</p>` : '<span>No new notifications.</span>';
    }
    const certBox = document.getElementById('certificateBox');
    if (certBox) {
      certBox.classList.toggle('hidden', !certificate.certificate);
      if (certificate.certificate) {
        certBox.innerHTML = `<div class="certificate"><span>🌿</span><p class="eyebrow">EcoSmart verified</p><h2>Recycling Certificate</h2><p>This certifies that your e-waste was responsibly processed through EcoSmart.</p><div class="certificate-code">${certificate.certificate.certificate_code}</div><div class="certificate-grid"><div><b>${certificate.certificate.points}</b><small>EcoPoints</small></div><div><b>${certificate.certificate.estimated_weight} kg</b><small>E-waste diverted</small></div><div><b>${certificate.certificate.tracking_id}</b><small>Tracking ID</small></div></div><button class="btn primary" onclick="window.print()">Print / Save Certificate</button></div>`;
      }
    }
  } catch (error) {
    if (/log in/i.test(error.message)) { localStorage.removeItem('ecosmartToken'); location.href = 'login.html?next=dashboard.html'; return; }
    setMessage('dashboardMessage', error.message, 'error');
  }
}

let pickupHistoryCache = [];
function renderPickupHistory(pickups) {
  pickupHistoryCache = pickups;
  const box = document.getElementById('pickupHistory'); if (!box) return;
  const draw = () => {
    const query = (document.getElementById('pickupSearch')?.value || '').toLowerCase();
    const status = document.getElementById('pickupStatusFilter')?.value || 'all';
    const rows = pickupHistoryCache.filter(p => (status === 'all' || p.status === status) && `${p.tracking_id} ${p.area} ${p.status}`.toLowerCase().includes(query));
    box.innerHTML = rows.length ? rows.map(p => `<article class="history-row"><div><b>${escapeHtml(p.tracking_id)}</b><p>${escapeHtml(p.area)} · ${escapeHtml(p.slot)}</p><span class="tag">${escapeHtml(p.status)}</span></div><div class="history-actions"><b>${p.points} EcoPoints possible</b>${p.status === 'pending' ? `<button class="btn secondary" onclick="reschedulePickup(${p.id},'${escapeHtml(p.area)}')">Reschedule</button><button class="btn danger" onclick="cancelPickup(${p.id})">Cancel</button>` : ''}</div></article>`).join('') : '<div class="empty-state"><span>♻️</span><b>No pickups match your filters.</b><small>Try another search or schedule your first pickup.</small></div>';
  };
  if (document.getElementById('pickupSearch')) document.getElementById('pickupSearch').oninput = draw;
  if (document.getElementById('pickupStatusFilter')) document.getElementById('pickupStatusFilter').onchange = draw;
  draw();
}
window.cancelPickup = async id => {
  if (!confirm('Cancel this pending pickup request?')) return;
  try { await api(`/pickups/${id}/cancel`, {method:'POST', body:JSON.stringify({})}); setMessage('dashboardMessage','Pickup cancelled.','success'); await renderDashboard(); }
  catch(e) { setMessage('dashboardMessage',e.message,'error'); }
};
window.reschedulePickup = async (id, currentArea) => {
  try {
    const data = await api('/areas');
    const area = prompt(`Enter service area (${Object.keys(data.slots).join(', ')}):`, currentArea);
    if (!area) return;
    const slots = data.slots[area];
    if (!slots?.length) { setMessage('dashboardMessage','Please enter an exact supported area from the list.','error'); return; }
    const slot = prompt(`Available slots for ${area}:\n${slots.join('\n')}\n\nEnter one slot exactly:`, slots[0]);
    if (!slot) return;
    const result = await api(`/pickups/${id}/reschedule`, {method:'POST',body:JSON.stringify({area,slot})});
    setMessage('dashboardMessage',`Pickup ${result.pickup.tracking_id} rescheduled.`, 'success'); await renderDashboard();
  } catch(e) { setMessage('dashboardMessage',e.message,'error'); }
};

async function redeemReward(id) {
  const message = document.getElementById('rewardMessage');
  try {
    const data = await api(`/rewards/${id}/redeem`, { method:'POST', body: JSON.stringify({}) });
    setMessage('rewardMessage', `🎁 ${data.reward} redeemed successfully. Your voucher code is ${data.code}.`, 'success');
    renderDashboard();
  } catch (error) { setMessage('rewardMessage', error.message, 'error'); }
}
window.redeemReward = redeemReward;

function renderRewards(rewards) {
  const box = document.getElementById('rewardsList');
  if (!box) return;
  box.innerHTML = rewards.map(r => `<div class="reward"><div><b>${escapeHtml(r.name)}</b><br><small>${escapeHtml(r.description)} · ${r.cost} points</small></div><button data-cost="${r.cost}" onclick="redeemReward(${r.id})">Redeem</button></div>`).join('');
}

async function loadRewards() { if (!document.getElementById('rewardsList') || !token()) return; try { const data=await api('/rewards'); renderRewards(data.rewards); } catch(e){} }

async function renderAdmin() {
  const list = document.getElementById('adminList');
  if (!list) return;
  if (!token()) { location.href='login.html?next=admin.html'; return; }
  try {
    const me = await api('/auth/me');
    if (me.user.role !== 'admin') { setMessage('adminMessage','Admin access required.','error'); list.innerHTML=''; return; }
    const data = await api('/admin/pickups');
    const empty = document.getElementById('adminEmpty');
    empty?.classList.toggle('hidden', data.pickups.length !== 0);
    list.innerHTML = data.pickups.map(p => `
      <article class="admin-request card panel">
        <div class="admin-request-head"><div><span class="eyebrow">${escapeHtml(p.tracking_id)}</span><h3>${escapeHtml(p.user_name)}</h3><p>${escapeHtml(p.user_email)} · ${escapeHtml(p.user_mobile)} · ${escapeHtml(p.area)}</p></div><span class="tag">${escapeHtml(p.status)}</span></div>
        <div class="request-meta"><span>📅 ${escapeHtml(p.slot)}</span><span>📍 ${escapeHtml(p.address)}</span><span>🌱 ${p.points} points</span><span>⚖️ ${p.estimated_weight} kg est.</span></div>
        <div class="admin-items"><b>Items</b>${p.items.map(i=>`<div>${escapeHtml(i.type_label)} · ${escapeHtml(i.condition)} · ${i.points} pts</div>`).join('')}</div>
        ${p.description ? `<p><b>Description:</b> ${escapeHtml(p.description)}</p>` : ''}
        ${p.photos?.length ? `<div class="photo-gallery">${p.photos.map(photo=>`<a href="${photo.file_url}" target="_blank"><img src="${photo.file_url}" alt="Uploaded e-waste photo"></a>`).join('')}</div>` : '<p class="muted">No photos uploaded.</p>'}
        <div class="admin-actions">
          ${p.status === 'pending' ? `<button class="btn primary" onclick="adminAction(${p.id},'approve')">✓ Approve & Assign Agent</button><button class="btn danger" onclick="adminReject(${p.id})">Reject</button>` : ''}
          ${p.status === 'assigned' ? `<button class="btn primary" onclick="adminAction(${p.id},'collect')">🚚 Mark Collected</button>` : ''}
          ${p.status === 'collected' ? `<button class="btn primary" onclick="adminAction(${p.id},'recycle')">♻️ Mark Recycled & Credit Points</button>` : ''}
          ${p.status === 'recycled' ? `<span class="success-pill">✓ Completed · ${p.points} points credited</span>` : ''}
        </div>
      </article>`).join('');
  } catch(error) { setMessage('adminMessage', error.message, 'error'); }
}

async function adminAction(id, action) {
  try { const data=await api(`/admin/pickups/${id}/${action}`,{method:'POST',body:JSON.stringify({})}); setMessage('adminMessage',`Request ${data.pickup.tracking_id} updated successfully.`,'success'); renderAdmin(); } catch(e){setMessage('adminMessage',e.message,'error');}
}
window.adminAction = adminAction;
async function adminReject(id){ const reason=prompt('Why is this request being rejected?'); if(reason===null)return; try{await api(`/admin/pickups/${id}/reject`,{method:'POST',body:JSON.stringify({reason})});renderAdmin();}catch(e){setMessage('adminMessage',e.message,'error');} }
window.adminReject=adminReject;


async function submitBusinessEnquiry(event){
  event.preventDefault();
  const form=document.getElementById('businessForm'); if(!form)return;
  const button=document.getElementById('businessSubmit'); if(button){button.disabled=true;button.textContent='Submitting…';}
  const data={organisation:document.getElementById('organisation').value,contactName:document.getElementById('contactName').value,email:document.getElementById('businessEmail').value,phone:document.getElementById('businessPhone').value,organisationType:document.getElementById('organisationType').value,area:document.getElementById('businessArea').value,estimatedVolume:document.getElementById('estimatedVolume').value,serviceNeeded:document.getElementById('serviceNeeded').value,notes:document.getElementById('businessNotes').value};
  try{const result=await api('/business-enquiries',{method:'POST',body:JSON.stringify(data)}); const success=document.getElementById('businessSuccess'); document.getElementById('businessSuccessText').textContent=`Enquiry #${result.enquiryId} has been saved. This is a request for follow-up, not a confirmed pickup.`; success?.classList.remove('hidden'); form.reset(); setMessage('businessMessage','Thank you. Your organisation enquiry is now saved in the EcoSmart database.','success'); success?.scrollIntoView({behavior:'smooth',block:'center'});}catch(error){setMessage('businessMessage',error.message,'error');}finally{if(button){button.disabled=false;button.textContent='Submit business enquiry →';}}
}

async function renderBusinessEnquiries(){
 const list=document.getElementById('businessLeadList'); if(!list)return;
 try{const data=await api('/admin/business-enquiries'); const empty=document.getElementById('businessLeadEmpty'); empty?.classList.toggle('hidden',data.enquiries.length!==0); list.innerHTML=data.enquiries.map(e=>`<article class="admin-request card panel"><div class="admin-request-head"><div><span class="eyebrow">Enquiry #${e.id} · ${escapeHtml(e.created_at)}</span><h3>${escapeHtml(e.organisation)}</h3><p>${escapeHtml(e.contact_name)} · ${escapeHtml(e.organisation_type)}</p></div><span class="tag">${escapeHtml(e.status)}</span></div><div class="request-meta"><span>✉️ ${escapeHtml(e.email)}</span><span>☎️ ${escapeHtml(e.phone)}</span><span>📍 ${escapeHtml(e.area)}</span><span>📦 ${escapeHtml(e.estimated_volume)}</span></div><p><b>Service requested:</b> ${escapeHtml(e.service_needed)}</p>${e.notes?`<p><b>Details:</b> ${escapeHtml(e.notes)}</p>`:''}</article>`).join('');}catch(error){setMessage('adminMessage',error.message,'error');}
}

async function renderPublicImpact(){
  const weight=document.getElementById('publicWeight'); if(!weight)return;
  try{const data=await api('/public/impact'); weight.textContent=data.weight; document.getElementById('publicDevices').textContent=data.devices; document.getElementById('publicUsers').textContent=data.users;}catch(e){}
}

async function handleLogin(event) {
  event.preventDefault();
  const button=event.submitter; if(button){button.disabled=true;button.textContent='Signing in…';}
  try { const data=await api('/auth/login',{method:'POST',body:JSON.stringify({identifier:document.getElementById('loginEmail').value,password:document.getElementById('loginPassword').value})}); localStorage.setItem('ecosmartToken',data.token); localStorage.setItem('ecosmartUser',JSON.stringify(data.user)); const next=new URLSearchParams(location.search).get('next'); location.href=next || (data.user.role==='admin'?'admin.html':'dashboard.html'); } catch(e){setMessage('loginMessage',e.message,'error');} finally{if(button){button.disabled=false;button.textContent='Login';}}
}

async function handleRegister(event){
  event.preventDefault();
  try { const data=await api('/auth/register',{method:'POST',body:JSON.stringify({name:document.getElementById('regName').value,email:document.getElementById('regEmail').value,mobile:document.getElementById('regMobile').value,area:document.getElementById('regArea').value,password:document.getElementById('regPassword').value})}); localStorage.setItem('ecosmartToken',data.token); localStorage.setItem('ecosmartUser',JSON.stringify(data.user)); location.href='dashboard.html'; } catch(e){setMessage('registerMessage',e.message,'error');}
}

function setupUserNav(){
  const nav=document.querySelector('.links');
  if(!nav || !token()) return;
  const login=nav.querySelector('a[href=\"login.html\"]');
  const register=nav.querySelector('a[href=\"register.html\"]');
  login?.remove(); register?.remove();
  if(!nav.querySelector('.logout-link')){ const button=document.createElement('a'); button.href='#'; button.className='logout-link'; button.textContent='Log out'; button.addEventListener('click',e=>{e.preventDefault();localStorage.removeItem('ecosmartToken');localStorage.removeItem('ecosmartUser');location.href='index.html';}); nav.appendChild(button); }
}

function setupAuthGuard(){
  const protectedPage=['dashboard.html','pickup.html','admin.html'].some(name=>location.pathname.endsWith(name));
  if(!protectedPage)return;
  if(!token() && !location.pathname.endsWith('admin.html')) { /* pickup/dashboard show friendly prompt rather than hard redirect */ }
}

function setupMenu(){ document.querySelector('.menu')?.addEventListener('click',()=>document.querySelector('.links')?.classList.toggle('open')); }
function setupNav(){ document.querySelectorAll('[data-nav]').forEach(link=>{if(location.pathname.endsWith(link.getAttribute('href')))link.classList.add('active');}); }

function setupPickup(){
  const closePacking = () => document.getElementById('packingModal')?.classList.add('hidden');
  document.getElementById('closePacking')?.addEventListener('click', closePacking);
  document.getElementById('packingDone')?.addEventListener('click', closePacking);
  document.getElementById('packingModal')?.addEventListener('click', e => { if (e.target.id === 'packingModal') closePacking(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePacking(); });
  const form=document.getElementById('pickupForm'); if(!form)return;
  if(!token()){ setMessage('formMessage','Please log in before scheduling a pickup. Your account keeps your requests, points and certificates together.','error'); } else { api('/auth/me').then(({user})=>{ const name=document.getElementById('name'); const contact=document.getElementById('contact'); const area=document.getElementById('area'); if(name && !name.value) name.value=user.name||''; if(contact && !contact.value) contact.value=user.mobile||user.email||''; if(area && !area.value && user.area){ area.value=user.area; loadSlots(); } }).catch(()=>{}); }
  document.getElementById('area')?.addEventListener('change',loadSlots);
  document.getElementById('photo')?.addEventListener('change',previewPhotos);
  document.getElementById('addItemBtn')?.addEventListener('click',addItemRow);
  form.addEventListener('submit',submitPickup);
  document.querySelectorAll('[data-next]').forEach(btn=>btn.addEventListener('click',()=>{const step=Number(btn.dataset.next);if(validateStep(step-1))goToStep(step);}));
  document.querySelectorAll('[data-prev]').forEach(btn=>btn.addEventListener('click',()=>goToStep(Number(btn.dataset.prev))));
  if(!document.querySelector('#itemsContainer .item-row'))addItemRow();
}

function setupLogin(){document.getElementById('loginForm')?.addEventListener('submit',handleLogin);document.getElementById('registerForm')?.addEventListener('submit',handleRegister);}

function addMobileNav(){
  if(document.querySelector('.mobile-nav'))return;
  const nav=document.createElement('nav'); nav.className='mobile-nav'; nav.innerHTML='<a href="index.html">⌂<span>Home</span></a><a href="pickup.html">♻️<span>Recycle</span></a><a href="dashboard.html">📍<span>Track</span></a><a href="dashboard.html#impact">🌱<span>Impact</span></a>';
  document.body.appendChild(nav);
}

document.addEventListener('DOMContentLoaded',async()=>{
  document.getElementById('businessForm')?.addEventListener('submit',submitBusinessEnquiry);
  setupMenu();setupNav();setupUserNav();setupPickup();setupLogin();setupAuthGuard();addMobileNav();
  await renderPublicImpact();
  await renderDashboard();
  await loadRewards();
  await renderAdmin();
  await renderBusinessEnquiries();
});

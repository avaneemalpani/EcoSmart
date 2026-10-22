const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'ecosmart.db'));
db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  mobile TEXT NOT NULL,
  area TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  eco_points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  latitude REAL,
  longitude REAL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS pickups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area TEXT NOT NULL,
  address TEXT NOT NULL,
  slot TEXT NOT NULL,
  handover TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  agent_id INTEGER REFERENCES agents(id),
  points INTEGER NOT NULL DEFAULT 0,
  estimated_weight REAL NOT NULL DEFAULT 0,
  notification TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS pickup_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_id INTEGER NOT NULL REFERENCES pickups(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  type_label TEXT NOT NULL,
  condition TEXT NOT NULL,
  issue_details TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  estimated_weight REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pickup_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_id INTEGER NOT NULL REFERENCES pickups(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_id INTEGER NOT NULL REFERENCES pickups(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS eco_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pickup_id INTEGER REFERENCES pickups(id),
  points INTEGER NOT NULL,
  type TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  cost INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_id INTEGER NOT NULL REFERENCES rewards(id),
  code TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pickup_id INTEGER NOT NULL UNIQUE REFERENCES pickups(id) ON DELETE CASCADE,
  certificate_code TEXT UNIQUE NOT NULL,
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS business_enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  organisation_type TEXT NOT NULL,
  area TEXT NOT NULL,
  estimated_volume TEXT NOT NULL,
  service_needed TEXT NOT NULL,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const pointsByType = { laptop: 100, mobile: 50, tablet: 50, charger: 10, battery: 20, other: 5 };
const weightByType = { laptop: 2.2, mobile: 0.2, tablet: 0.5, charger: 0.25, battery: 0.4, other: 0.5 };
const typeLabels = { laptop: 'Laptop / Desktop', mobile: 'Mobile Phone', tablet: 'Tablet', charger: 'Charger / Adapter', battery: 'Battery', other: 'Other e-waste' };
const areas = ['Shivajinagar','Deccan','Camp','Swargate','Kothrud','Aundh','Baner','Pashan','Hinjewadi','Wakad','Koregaon Park','Kalyani Nagar','Kharadi','Katraj','Bibwewadi','Undri','Akurdi'];
const scheduleDays = { Shivajinagar:'Monday', Deccan:'Monday', Camp:'Monday', Swargate:'Monday', Kothrud:'Tuesday', Aundh:'Tuesday', Baner:'Tuesday', Pashan:'Tuesday', Hinjewadi:'Tuesday', Wakad:'Tuesday', 'Koregaon Park':'Wednesday', 'Kalyani Nagar':'Wednesday', Kharadi:'Wednesday', Katraj:'Thursday', Bibwewadi:'Thursday', Undri:'Thursday', Akurdi:'Friday' };

function nowIso() { return new Date().toISOString(); }
function randomCode(prefix='ES') { return `${prefix}-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(hash, 'hex'));
}
const TOKEN_SECRET = process.env.ECOSMART_TOKEN_SECRET || 'change-this-ecosmart-secret-before-production';
function createToken(user) {
  const payload = Buffer.from(JSON.stringify({ id:user.id, role:user.role, exp:Date.now()+1000*60*60*24*7 })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
    if (!payload || !sig || sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
function userFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const data = readToken(token);
  if (!data) return null;
  return db.prepare('SELECT id,name,email,mobile,area,role,eco_points,created_at FROM users WHERE id=?').get(data.id) || null;
}
function requireUser(req, res) { const user=userFromRequest(req); if(!user) { sendJson(res,401,{error:'Please log in first.'}); return null; } return user; }
function requireAdmin(req,res) { const user=requireUser(req,res); if(!user) return null; if(user.role!=='admin'){ sendJson(res,403,{error:'Admin access required.'}); return null; } return user; }
function sendJson(res,status,data) { const body=JSON.stringify(data); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(body); }
function parseBody(req) { return new Promise((resolve,reject)=>{ let raw=''; req.on('data',c=>{raw+=c; if(raw.length>20*1024*1024){req.destroy();reject(new Error('Request too large'));}}); req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{});}catch(e){reject(e);}}); req.on('error',reject); }); }
function sendError(res, err) { console.error(err); sendJson(res,500,{error:'Something went wrong on the server.'}); }
function publicUser(user) { return {id:user.id,name:user.name,email:user.email,mobile:user.mobile,area:user.area,role:user.role,ecoPoints:user.eco_points}; }
function addNotification(userId,title,message){ db.prepare('INSERT INTO notifications(user_id,title,message) VALUES(?,?,?)').run(userId,title,message); }
function addHistory(pickupId,status,note=''){ db.prepare('INSERT INTO status_history(pickup_id,status,note) VALUES(?,?,?)').run(pickupId,status,note); }
function getPickup(id, userId=null){
  const where=userId ? 'WHERE p.id=? AND p.user_id=?' : 'WHERE p.id=?';
  const args=userId ? [id,userId] : [id];
  const p=db.prepare(`SELECT p.*, u.name AS user_name,u.email AS user_email,u.mobile AS user_mobile,a.name AS agent_name,a.phone AS agent_phone,a.latitude AS agent_latitude,a.longitude AS agent_longitude,a.updated_at AS agent_location_updated FROM pickups p JOIN users u ON u.id=p.user_id LEFT JOIN agents a ON a.id=p.agent_id ${where}`).get(...args);
  if(!p) return null;
  p.items=db.prepare('SELECT * FROM pickup_items WHERE pickup_id=? ORDER BY id').all(p.id);
  p.photos=db.prepare('SELECT id,file_name,file_url FROM pickup_photos WHERE pickup_id=? ORDER BY id').all(p.id);
  p.history=db.prepare('SELECT status,note,created_at FROM status_history WHERE pickup_id=? ORDER BY id').all(p.id);
  if(p.agent_latitude!=null) p.gps={latitude:p.agent_latitude,longitude:p.agent_longitude,lastUpdated:p.agent_location_updated}; else p.gps=null;
  delete p.agent_latitude; delete p.agent_longitude; delete p.agent_location_updated;
  return p;
}
function ensureSeeds(){
  const agentCount=db.prepare('SELECT COUNT(*) AS c FROM agents').get().c;
  if(!agentCount) db.prepare('INSERT INTO agents(name,phone,status,latitude,longitude,updated_at) VALUES(?,?,?,?,?,?)').run('Rahul Sharma','+91 90000 10001','available',18.5204,73.8567,nowIso());
  const rewardCount=db.prepare('SELECT COUNT(*) AS c FROM rewards').get().c;
  if(!rewardCount){
    const ins=db.prepare('INSERT INTO rewards(name,description,cost) VALUES(?,?,?)');
    ins.run('₹50 Eco Clothing Voucher','Sustainable clothing partner reward.',200);
    ins.run('10% Sustainable Food Discount','Organic and eco-food partner reward.',350);
    ins.run('₹150 Green Lifestyle Voucher','Eco home, refill and lifestyle reward.',500);
  }
  const admin=db.prepare('SELECT id FROM users WHERE email=?').get('admin@ecosmart.local');
  if(!admin) db.prepare('INSERT INTO users(name,email,mobile,area,password_hash,role) VALUES(?,?,?,?,?,?)').run('EcoSmart Admin','admin@ecosmart.local','9000000000','Pune',hashPassword('Admin@123'),'admin');
}
ensureSeeds();

function nextSlots(area){
  const day=scheduleDays[area] || 'Saturday';
  const dayNums={Sunday:0,Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6};
  const today=new Date(); const d=(dayNums[day]-today.getDay()+7)%7 || 7;
  const date=new Date(today); date.setDate(today.getDate()+d);
  const date2=new Date(date); date2.setDate(date.getDate()+7);
  const fmt=x=>x.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  return [`${day} · ${fmt(date)} · 10:00 AM – 2:00 PM`,`${day} · ${fmt(date)} · 2:00 PM – 5:00 PM`,`${day} · ${fmt(date2)} · 10:00 AM – 2:00 PM`,`${day} · ${fmt(date2)} · 2:00 PM – 5:00 PM`];
}
function serveStatic(req,res){
  let pathname=decodeURIComponent(new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname);
  if(pathname==='/'||pathname==='/index.html') pathname='/index.html';
  const safe=path.normalize(pathname).replace(/^([.][.][\\/])+/, '');
  let filePath=path.join(ROOT,safe);
  if(pathname.startsWith('/uploads/')) filePath=path.join(UPLOAD_DIR,path.basename(pathname));
  if(!filePath.startsWith(ROOT) && !filePath.startsWith(UPLOAD_DIR)) return sendJson(res,403,{error:'Forbidden'});
  fs.stat(filePath,(err,stat)=>{
    if(err||!stat.isFile()) return sendJson(res,404,{error:'Not found'});
    const ext=path.extname(filePath).toLowerCase();
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'}); fs.createReadStream(filePath).pipe(res);
  });
}

async function api(req,res){
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`); const pathname=url.pathname;
  if(req.method==='GET' && pathname==='/api/health') return sendJson(res,200,{ok:true,service:'EcoSmart',time:nowIso()});
  if(req.method==='POST' && pathname==='/api/business-enquiries'){
    const b=await parseBody(req);
    const required=['organisation','contactName','email','phone','organisationType','area','estimatedVolume','serviceNeeded'];
    if(required.some(k=>!String(b[k]||'').trim())) return sendJson(res,400,{error:'Please complete all required organisation details.'});
    const email=String(b.email).trim(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res,400,{error:'Please enter a valid email address.'});
    const result=db.prepare('INSERT INTO business_enquiries(organisation,contact_name,email,phone,organisation_type,area,estimated_volume,service_needed,notes) VALUES(?,?,?,?,?,?,?,?,?)').run(String(b.organisation).trim(),String(b.contactName).trim(),email,String(b.phone).trim(),String(b.organisationType),String(b.area),String(b.estimatedVolume),String(b.serviceNeeded),String(b.notes||'').trim());
    return sendJson(res,201,{ok:true,enquiryId:Number(result.lastInsertRowid),message:'Your enquiry has been saved. EcoSmart will review it and contact you to discuss a suitable collection plan.'});
  }
  if(req.method==='GET' && pathname==='/api/admin/business-enquiries'){ const u=requireAdmin(req,res); if(!u)return; const rows=db.prepare('SELECT * FROM business_enquiries ORDER BY id DESC').all(); return sendJson(res,200,{enquiries:rows}); }
  if(req.method==='GET' && pathname==='/api/areas') return sendJson(res,200,{areas,slots:Object.fromEntries(areas.map(a=>[a,nextSlots(a)]))});
  if(req.method==='POST' && pathname==='/api/auth/register'){
    const b=await parseBody(req); if(!b.name||!b.email||!b.mobile||!b.area||!b.password) return sendJson(res,400,{error:'Please complete all required fields.'});
    if(!areas.includes(b.area)) return sendJson(res,400,{error:'Please select a valid service area.'});
    if(String(b.password).length<6) return sendJson(res,400,{error:'Password must be at least 6 characters.'});
    const email=String(b.email).trim().toLowerCase();
    try{ const result=db.prepare('INSERT INTO users(name,email,mobile,area,password_hash) VALUES(?,?,?,?,?)').run(String(b.name).trim(),email,String(b.mobile).trim(),b.area,hashPassword(b.password)); const user=db.prepare('SELECT * FROM users WHERE id=?').get(Number(result.lastInsertRowid)); return sendJson(res,201,{token:createToken(user),user:publicUser(user)}); }catch(e){ if(String(e.message).includes('UNIQUE')) return sendJson(res,409,{error:'An account with that email already exists.'}); throw e; }
  }
  if(req.method==='POST' && pathname==='/api/auth/login'){
    const b=await parseBody(req); const identifier=String(b.identifier||'').trim().toLowerCase(); const user=db.prepare('SELECT * FROM users WHERE lower(email)=? OR mobile=?').get(identifier,String(b.identifier||'').trim());
    if(!user||!verifyPassword(String(b.password||''),user.password_hash)) return sendJson(res,401,{error:'Incorrect email/mobile or password.'});
    return sendJson(res,200,{token:createToken(user),user:publicUser(user)});
  }
  if(req.method==='GET' && pathname==='/api/auth/me'){ const u=requireUser(req,res); if(!u)return; return sendJson(res,200,{user:publicUser(u)}); }
  if(req.method==='GET' && pathname==='/api/pickups'){
    const u=requireUser(req,res); if(!u)return; const rows=db.prepare('SELECT * FROM pickups WHERE user_id=? ORDER BY id DESC').all(u.id); return sendJson(res,200,{pickups:rows.map(x=>getPickup(x.id,u.id))});
  }
  if(req.method==='POST' && pathname.match(/^\/api\/pickups\/\d+\/(cancel|reschedule)$/)){
    const u=requireUser(req,res); if(!u)return; const parts=pathname.split('/'); const id=Number(parts[3]); const action=parts[4]; const pickup=db.prepare('SELECT * FROM pickups WHERE id=? AND user_id=?').get(id,u.id);
    if(!pickup)return sendJson(res,404,{error:'Pickup not found.'});
    if(pickup.status!=='pending')return sendJson(res,400,{error:'Only pending requests can be changed here. Please contact support for an assigned pickup.'});
    if(action==='cancel'){
      db.prepare("UPDATE pickups SET status='rejected',notification=? WHERE id=?").run('Pickup cancelled by user.',id); addHistory(id,'rejected','Cancelled by user before assignment.'); addNotification(u.id,'Pickup cancelled',`Your pickup ${pickup.tracking_id} was cancelled.`); return sendJson(res,200,{ok:true,pickup:getPickup(id,u.id)});
    }
    const b=await parseBody(req); if(!b.area||!b.slot||!areas.includes(b.area))return sendJson(res,400,{error:'Choose a valid area and pickup slot.'});
    if(!(nextSlots(b.area)||[]).includes(b.slot))return sendJson(res,400,{error:'That slot is no longer available. Please choose another slot.'});
    db.prepare('UPDATE pickups SET area=?,slot=?,notification=? WHERE id=?').run(b.area,b.slot,'Your pickup has been rescheduled and is awaiting verification.',id); addHistory(id,'pending',`Rescheduled to ${b.area}, ${b.slot}.`); addNotification(u.id,'Pickup rescheduled',`Pickup ${pickup.tracking_id} is now scheduled for ${b.slot} in ${b.area}.`); return sendJson(res,200,{ok:true,pickup:getPickup(id,u.id)});
  }
  if(req.method==='GET' && pathname==='/api/pickups/latest'){
    const u=requireUser(req,res); if(!u)return; const row=db.prepare('SELECT id FROM pickups WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id); return sendJson(res,200,{pickup:row?getPickup(row.id,u.id):null});
  }
  if(req.method==='POST' && pathname==='/api/pickups'){
    const u=requireUser(req,res); if(!u)return; const b=await parseBody(req);
    if(!b.area||!b.address||!b.slot||!b.handover||!Array.isArray(b.items)||!b.items.length) return sendJson(res,400,{error:'Please complete the pickup details.'});
    if(!areas.includes(b.area)) return sendJson(res,400,{error:'Invalid service area.'});
    const items=b.items.map(x=>({type:x.type,typeLabel:typeLabels[x.type]||x.type,condition:x.condition,issueDetails:x.issueDetails||'',points:pointsByType[x.type]||5,estimatedWeight:weightByType[x.type]||0.5}));
    const totalPoints=items.reduce((s,x)=>s+x.points,0); const totalWeight=items.reduce((s,x)=>s+x.estimatedWeight,0); const tracking=randomCode();
    const tx=db.prepare('BEGIN'); tx.run();
    try{
      const result=db.prepare('INSERT INTO pickups(tracking_id,user_id,area,address,slot,handover,description,status,points,estimated_weight,notification) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(tracking,u.id,b.area,b.address,b.slot,b.handover,String(b.description||''),'pending',totalPoints,totalWeight,'Your request is awaiting admin verification.');
      const pid=Number(result.lastInsertRowid); const itemStmt=db.prepare('INSERT INTO pickup_items(pickup_id,type,type_label,condition,issue_details,points,estimated_weight) VALUES(?,?,?,?,?,?,?)'); items.forEach(x=>itemStmt.run(pid,x.type,x.typeLabel,x.condition,x.issueDetails,x.points,x.estimatedWeight));
      const photos=Array.isArray(b.photos)?b.photos.slice(0,8):[]; const photoStmt=db.prepare('INSERT INTO pickup_photos(pickup_id,file_name,file_url) VALUES(?,?,?)');
      photos.forEach((dataUrl,i)=>{ const match=String(dataUrl).match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i); if(!match)return; const ext=match[1].toLowerCase().replace('jpeg','jpg'); const fileName=`${tracking}-${i+1}.${ext}`; fs.writeFileSync(path.join(UPLOAD_DIR,fileName),Buffer.from(match[2],'base64')); photoStmt.run(pid,fileName,`/uploads/${fileName}`); });
      addHistory(pid,'pending','Request submitted by user.'); addNotification(u.id,'Pickup request submitted',`Request ${tracking} is waiting for verification.`); db.prepare('COMMIT').run();
      return sendJson(res,201,{pickup:getPickup(pid,u.id)});
    }catch(e){db.prepare('ROLLBACK').run(); throw e;}
  }
  if(req.method==='GET' && pathname==='/api/rewards') { const u=requireUser(req,res); if(!u)return; return sendJson(res,200,{rewards:db.prepare('SELECT id,name,description,cost FROM rewards WHERE active=1 ORDER BY cost').all()}); }
  if(req.method==='POST' && pathname.match(/^\/api\/rewards\/\d+\/redeem$/)){
    const u=requireUser(req,res); if(!u)return; const id=Number(pathname.split('/')[3]); const reward=db.prepare('SELECT * FROM rewards WHERE id=? AND active=1').get(id); if(!reward)return sendJson(res,404,{error:'Reward not found.'}); if(u.eco_points<reward.cost)return sendJson(res,400,{error:'Not enough EcoPoints yet.'}); const code=`ECO-${crypto.randomBytes(5).toString('hex').toUpperCase()}`; db.prepare('UPDATE users SET eco_points=eco_points-? WHERE id=?').run(reward.cost,u.id); db.prepare('INSERT INTO redemptions(user_id,reward_id,code) VALUES(?,?,?)').run(u.id,id,code); db.prepare('INSERT INTO eco_transactions(user_id,points,type,note) VALUES(?,?,?,?)').run(u.id,-reward.cost,'reward_redemption',reward.name); addNotification(u.id,'Reward redeemed',`${reward.name} is ready. Voucher code: ${code}`); return sendJson(res,200,{code,reward:reward.name,newBalance:u.eco_points-reward.cost}); }
  if(req.method==='GET' && pathname==='/api/notifications'){ const u=requireUser(req,res); if(!u)return; return sendJson(res,200,{notifications:db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30').all(u.id)}); }
  if(req.method==='POST' && pathname==='/api/notifications/read'){ const u=requireUser(req,res); if(!u)return; db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(u.id); return sendJson(res,200,{ok:true}); }
  if(req.method==='GET' && pathname==='/api/dashboard'){
    const u=requireUser(req,res); if(!u)return; const pickups=db.prepare('SELECT * FROM pickups WHERE user_id=? ORDER BY id DESC').all(u.id); const completed=pickups.filter(p=>p.status==='recycled'); const weight=completed.reduce((s,p)=>s+p.estimated_weight,0); const devices=completed.reduce((s,p)=>s+db.prepare('SELECT COUNT(*) AS c FROM pickup_items WHERE pickup_id=?').get(p.id).c,0); const laptopDone=completed.some(p=>db.prepare("SELECT 1 FROM pickup_items WHERE pickup_id=? AND type='laptop' LIMIT 1").get(p.id)); const impact=Math.round(weight*42); const points=u.eco_points; let level='🌱 Seedling',next=200,base=0; if(points>=1000){level='🌎 Planet Protector';next=null;base=1000;} else if(points>=500){level='🌳 Eco Champion';next=1000;base=500;} else if(points>=200){level='🌿 Green Starter';next=500;base=200;} const progress=next===null?100:Math.max(0,Math.min(100,((points-base)/(next-base))*100)); const achievements=[{icon:'♻️',name:'First Recycler',desc:'Complete your first pickup',earned:completed.length>=1},{icon:'💻',name:'Tech Recycler',desc:'Recycle a device',earned:laptopDone},{icon:'🌍',name:'Planet Protector',desc:'Recycle 10 kg',earned:weight>=10},{icon:'🏆',name:'Eco Regular',desc:'Complete 5 pickups',earned:completed.length>=5}]; return sendJson(res,200,{user:publicUser(u),stats:{weight:Number(weight.toFixed(1)),devices,completedPickups:completed.length,impactScore:impact},level:{name:level,next,progress},achievements});
  }
  if(req.method==='GET' && pathname==='/api/admin/pickups'){
    const u=requireAdmin(req,res); if(!u)return; const rows=db.prepare("SELECT id FROM pickups ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC").all(); return sendJson(res,200,{pickups:rows.map(x=>getPickup(x.id))});
  }
  if(req.method==='POST' && pathname.match(/^\/api\/admin\/pickups\/\d+\/approve$/)){
    const u=requireAdmin(req,res); if(!u)return; const id=Number(pathname.split('/')[4]); const p=getPickup(id); if(!p)return sendJson(res,404,{error:'Pickup not found.'}); const agent=db.prepare("SELECT * FROM agents WHERE status='available' ORDER BY id LIMIT 1").get() || db.prepare('SELECT * FROM agents ORDER BY id LIMIT 1').get(); if(!agent)return sendJson(res,500,{error:'No collection agent is configured.'}); db.prepare("UPDATE pickups SET status='assigned',agent_id=?,notification=? WHERE id=?").run(agent.id,`Agent ${agent.name} has been assigned. Tracking ID: ${p.tracking_id}.`,id); db.prepare("UPDATE agents SET status='assigned',updated_at=? WHERE id=?").run(nowIso(),agent.id); addHistory(id,'assigned',`Assigned to ${agent.name}.`); addNotification(p.user_id,'Agent assigned',`Agent ${agent.name} has been assigned to pickup ${p.tracking_id}.`); return sendJson(res,200,{pickup:getPickup(id)}); }
  if(req.method==='POST' && pathname.match(/^\/api\/admin\/pickups\/\d+\/collect$/)){
    const u=requireAdmin(req,res); if(!u)return; const id=Number(pathname.split('/')[4]); const p=getPickup(id); if(!p)return sendJson(res,404,{error:'Pickup not found.'}); db.prepare("UPDATE pickups SET status='collected',notification=? WHERE id=?").run(`Your e-waste has been collected by ${p.agent_name||'the EcoSmart agent'}.`,id); addHistory(id,'collected','Items handed over to collection agent.'); addNotification(p.user_id,'Pickup collected','Your e-waste has been collected successfully.'); return sendJson(res,200,{pickup:getPickup(id)}); }
  if(req.method==='POST' && pathname.match(/^\/api\/admin\/pickups\/\d+\/recycle$/)){
    const u=requireAdmin(req,res); if(!u)return; const id=Number(pathname.split('/')[4]); const p=getPickup(id); if(!p)return sendJson(res,404,{error:'Pickup not found.'}); if(p.status==='recycled')return sendJson(res,200,{pickup:p}); db.prepare("UPDATE pickups SET status='recycled',completed_at=?,notification=? WHERE id=?").run(nowIso(),`Your e-waste has been responsibly processed. You earned ${p.points} EcoPoints.`,id); db.prepare('UPDATE users SET eco_points=eco_points+? WHERE id=?').run(p.points,p.user_id); db.prepare('INSERT INTO eco_transactions(user_id,pickup_id,points,type,note) VALUES(?,?,?,?,?)').run(p.user_id,id,p.points,'recycling_reward',`Points for ${p.tracking_id}`); addHistory(id,'recycled',`Recycling completed. ${p.points} points credited.`); addNotification(p.user_id,'♻️ Recycling completed',`You earned ${p.points} EcoPoints for pickup ${p.tracking_id}.`); const cert=randomCode('CERT'); db.prepare('INSERT INTO certificates(user_id,pickup_id,certificate_code) VALUES(?,?,?)').run(p.user_id,id,cert); if(p.agent_id)db.prepare("UPDATE agents SET status='available',updated_at=? WHERE id=?").run(nowIso(),p.agent_id); return sendJson(res,200,{pickup:getPickup(id),certificate:cert}); }
  if(req.method==='POST' && pathname.match(/^\/api\/admin\/pickups\/\d+\/reject$/)){
    const u=requireAdmin(req,res); if(!u)return; const id=Number(pathname.split('/')[4]); const b=await parseBody(req); const p=getPickup(id); if(!p)return sendJson(res,404,{error:'Pickup not found.'}); db.prepare("UPDATE pickups SET status='rejected',notification=? WHERE id=?").run(`Request rejected: ${b.reason||'Please contact EcoSmart support.'}`,id); addHistory(id,'rejected',b.reason||'Request rejected by admin.'); addNotification(p.user_id,'Pickup request needs attention',`Request ${p.tracking_id} was rejected. ${b.reason||''}`); return sendJson(res,200,{pickup:getPickup(id)}); }
  if(req.method==='POST' && pathname==='/api/admin/agent/location'){
    const u=requireAdmin(req,res); if(!u)return; const b=await parseBody(req); const id=Number(b.agentId); db.prepare('UPDATE agents SET latitude=?,longitude=?,updated_at=? WHERE id=?').run(Number(b.latitude),Number(b.longitude),nowIso(),id); return sendJson(res,200,{ok:true}); }
  if(req.method==='GET' && pathname==='/api/certificate/latest'){ const u=requireUser(req,res); if(!u)return; const row=db.prepare('SELECT c.*,p.tracking_id,p.points,p.estimated_weight FROM certificates c JOIN pickups p ON p.id=c.pickup_id WHERE c.user_id=? ORDER BY c.id DESC LIMIT 1').get(u.id); return sendJson(res,200,{certificate:row||null}); }
  if(req.method==='GET' && pathname==='/api/public/impact'){ const weight=db.prepare("SELECT COALESCE(SUM(estimated_weight),0) AS w FROM pickups WHERE status='recycled'").get().w; const devices=db.prepare("SELECT COUNT(*) AS c FROM pickup_items pi JOIN pickups p ON p.id=pi.pickup_id WHERE p.status='recycled'").get().c; const users=db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='user'").get().c; return sendJson(res,200,{weight:Number(weight.toFixed(1)),devices,users}); }
  return sendJson(res,404,{error:'API endpoint not found.'});
}

const server=http.createServer(async (req,res)=>{
  try {
    if(req.url.startsWith('/api/')) return await api(req,res);
    return serveStatic(req,res);
  } catch(e) { return sendError(res,e); }
});
server.listen(PORT,()=>console.log(`EcoSmart running at http://localhost:${PORT}`));

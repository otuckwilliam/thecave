(function(){
const CATS=["Beer","Spirits","Wine","Champagne & sparkling","Soft drinks","Other"];
const METHODS=["Cash","M-Pesa","Mixx by Yas","Airtel Money","HaloPesa","Card"];
const PAYS=[...METHODS,"Open"];
const EXP=["Rent","Wages","Electricity (LUKU)","Water","Transport & delivery","Licences & TRA","Ice & supplies","Security","Repairs","Marketing","Other"];

const $=s=>document.querySelector(s);
const pad=n=>String(n).padStart(2,"0");
const ymd=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const today=()=>ymd(new Date());
const uid=()=>Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-5);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=n=>"TSh "+Math.round(n||0).toLocaleString("en-US");
const short=n=>{n=Math.round(n||0);const a=Math.abs(n);if(a>=1e6)return (n/1e6).toFixed(a>=1e7?0:1).replace(/\.0$/,"")+"M";if(a>=1e3)return Math.round(n/1e3)+"k";return String(n)};
const num=v=>{const n=parseFloat(String(v).replace(/,/g,""));return isFinite(n)?n:0};
const time=ts=>{const d=new Date(ts);return pad(d.getHours())+":"+pad(d.getMinutes())};
const niceDate=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})};
function ls(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}}

let DEV=ls("cave_dev"); if(!DEV){DEV="d"+uid();ls("cave_dev",DEV)}

const S={client:null,adminClient:null,device:null,status:"loading",products:{},days:{},tab:ls("cave_tab")||"sell",cart:[],pay:"Cash",customer:"",cat:"All",q:"",period:"week",stockFilter:"All",sr:"today",sfrom:"",sto:"",spay:"All",sby:"All",sq:"",showVoid:false,orders:{},ordMode:null,draft:{},gsup:{},oq:"",ordFilter:"Open",countMode:false,counts:{},ccat:"All",name:"",uid:null,role:null,access:null,accessLoaded:false,isOwner:null,lock:{step:"pick"},confirm:null,readOnly:false};

/* ---------- derived ---------- */
function prodList(){return Object.values(S.products).filter(p=>p.active!==false).sort((a,b)=>(CATS.indexOf(a.cat)-CATS.indexOf(b.cat))||a.name.localeCompare(b.name))}
function stockMap(){
  const m={};for(const p of Object.values(S.products))m[p.id]=num(p.open);
  for(const d of Object.values(S.days)){
    for(const s of d.sales||[])if(!s.voidedAt)for(const it of s.items||[]){const p=S.products[it.pid];if(p&&s.ts>(p.countedAt||0))m[it.pid]-=num(it.qty)}
    for(const r of d.restocks||[]){const p=S.products[r.pid];if(p&&r.ts>(p.countedAt||0))m[r.pid]+=num(r.qty)}
  }
  return m;
}
function status(p,q){if(q<=0)return["out","Out"];if(q<=num(p.reorder))return["low","Low"];return["ok","OK"]}
function collect(key,from,to,withVoid){const out=[];for(const d of Object.values(S.days))if(d.date>=from&&d.date<=to)for(const x of d[key]||[])if(withVoid||!x.voidedAt)out.push({...x,date:d.date,_doc:d._id});return out.sort((a,b)=>b.ts-a.ts)}
const saleTotal=s=>(s.items||[]).reduce((t,i)=>t+num(i.qty)*num(i.price),0);
const saleCost=s=>(s.items||[]).reduce((t,i)=>t+num(i.qty)*num(i.cost),0);
function periodRange(p){
  const n=new Date(),t=ymd(n);
  if(p==="today")return[t,t,"Today"];
  if(p==="week"){const d=new Date(n);const dow=(d.getDay()+6)%7;d.setDate(d.getDate()-dow);return[ymd(d),t,"This week"]}
  if(p==="month")return[ymd(new Date(n.getFullYear(),n.getMonth(),1)),t,"This month"];
  const a=new Date(n.getFullYear(),n.getMonth()-1,1),b=new Date(n.getFullYear(),n.getMonth(),0);return[ymd(a),ymd(b),"Last month"];
}

/* ---------- data: Supabase + offline queue ---------- */
const CFG=window.CAVE_CONFIG||{};
const COLS={
  sales:{id:"id",date:"date",ts:"ts",items:"items",pay:"pay",status:"status",label:"label",customer:"customer",sessionId:"session_id",by:"by_name",byId:"by_id",device:"device",paidAt:"paid_at",paidVia:"paid_via",paidBy:"paid_by",voidedAt:"voided_at",voidedBy:"voided_by",voidReason:"void_reason",editedAt:"edited_at",editedBy:"edited_by"},
  expenses:{id:"id",date:"date",ts:"ts",cat:"cat",amount:"amount",note:"note",by:"by_name",byId:"by_id"},
  restocks:{id:"id",date:"date",ts:"ts",pid:"pid",name:"name",qty:"qty",unitCost:"unit_cost",supplier:"supplier",orderId:"order_id",orderNo:"order_no",by:"by_name"},
  products:{id:"id",name:"name",size:"size",cat:"cat",cost:"cost",price:"price",reorder:"reorder",open:"open",countedAt:"counted_at",needsCount:"needs_count",countSource:"count_source",supplier:"supplier",rank:"rank",active:"active"},
  orders:{id:"id",no:"no",createdAt:"created_ms",by:"by_name",byId:"by_id",supplier:"supplier",status:"status",expectedDate:"expected_date",sentAt:"sent_at",receivedAt:"received_at",cancelledAt:"cancelled_at",closedAt:"closed_at",closeNote:"close_note",items:"items",deliveries:"deliveries",note:"note"},
  staff:{id:"id",name:"name",role:"role",pinHash:"pin_hash",active:"active",createdAt:"created_at",createdBy:"created_by"},
  settings:{key:"key",value:"value"},
  counter_sessions:{id:"id",date:"date",status:"status",openedAt:"opened_at",openedBy:"opened_by",openedById:"opened_by_id",device:"device",closedAt:"closed_at",closedBy:"closed_by",closedById:"closed_by_id",totalSales:"total_sales",cash:"cash",paidOut:"paid_out",mobile:"mobile",creditTotal:"credit_total",collectedTotal:"collected_total",difference:"difference",note:"note",report:"report"},
  credits:{id:"id",sessionId:"session_id",date:"date",name:"name",amount:"amount",paidAmount:"paid_amount",payments:"payments",paidAt:"paid_at",createdAt:"created_at",createdBy:"created_by",note:"note"}
};
const NUMC=new Set(["ts","amount","qty","unit_cost","cost","price","open","counted_at","reorder","rank","created_ms","sent_at","received_at","cancelled_at","closed_at","paid_at","voided_at","edited_at","created_at","opened_at","total_sales","cash","paid_out","credit_total","collected_total","difference","paid_amount"]);
const REV={};for(const t in COLS){REV[t]={};for(const k in COLS[t])REV[t][COLS[t][k]]=k}
const toRow=(t,o)=>{const r={};for(const k in o){const c=COLS[t][k];if(c)r[c]=o[k]===undefined?null:o[k]}return r};
const fromRow=(t,r)=>{const o={};for(const c in r){const k=REV[t][c];if(k&&r[c]!==null&&r[c]!==undefined)o[k]=NUMC.has(c)&&typeof r[c]==="string"?Number(r[c]):r[c]}return o};
const keyOf=t=>t==="settings"?"key":"id";
const DAYT=["sales","expenses","restocks"];
S.srv={sales:{},expenses:{},restocks:{},products:{},orders:{},staff:{},settings:{},counter_sessions:{},credits:{}};
S.queue=[];try{S.queue=JSON.parse(ls("cave_queue")||"[]")||[]}catch(_){S.queue=[]}
S.online=navigator.onLine;S.syncing=false;S.lastSync=0;S.failed=0;

/* tiny IndexedDB cache */
const idb=(()=>{let p;const open=()=>p=p||new Promise((res,rej)=>{try{const r=indexedDB.open("cave-ledger",1);r.onupgradeneeded=()=>r.result.createObjectStore("kv");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}catch(e){rej(e)}});
  return{get:k=>open().then(db=>new Promise(res=>{const q=db.transaction("kv").objectStore("kv").get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>res(null)})).catch(()=>null),
         set:(k,v)=>open().then(db=>new Promise(res=>{const tx=db.transaction("kv","readwrite");tx.objectStore("kv").put(v,k);tx.oncomplete=()=>res(true);tx.onerror=()=>res(false)})).catch(()=>false)}})();
let cacheT;function saveCache(){clearTimeout(cacheT);cacheT=setTimeout(()=>idb.set("cache",{srv:S.srv,loadedFrom:S.loadedFrom,savedAt:Date.now()}),1500)}

/* local application of an operation (optimistic state) */
function applyOp(rows,op){
  const t=op.t;
  if(op.k==="rpc"){(op.local||[]).forEach(o=>applyOp(rows,o));return}
  if(!rows[t])return;
  const id=op.k==="del"?op.id:op.k==="upd"?op.id:op.row[keyOf(t)];
  if(op.k==="del"){delete rows[t][id];return}
  const cur=rows[t][id]||{};
  const patch=fromRow(t,op.row||op.patch);
  const next={...(op.k==="upd"||op.k==="ins"?cur:{}),...patch};
  for(const c in (op.row||op.patch)){if((op.row||op.patch)[c]===null){const k=REV[t][c];if(k)delete next[k]}}
  if(op.k==="ins"&&rows[t][id])return; // insert of an existing row = no change
  rows[t][id]=next;
}
function rebuild(){
  const rows={};for(const t in S.srv)rows[t]={...S.srv[t]};
  for(const op of S.queue)applyOp(rows,op);
  S.products=rows.products;S.orders=rows.orders;S.sessions=rows.counter_sessions;S.credits=rows.credits;S.staffRows=rows.staff;S.settingsRows=rows.settings;
  const days={};
  for(const t of DAYT)for(const x of Object.values(rows[t])){const d=x.date;if(!d)continue;(days[d]=days[d]||{date:d,_id:d,sales:[],expenses:[],restocks:[]})[t].push(x)}
  S.days=days;
}
function pendingCount(){return S.queue.filter(o=>o.t==="sales"||o.fn==="void_sale").length}
function saveQueue(){ls("cave_queue",JSON.stringify(S.queue))}
function enqueue(op){op.qid=uid();op.at=Date.now();S.queue.push(op);saveQueue();rebuild();render();flushSoon()}
const api=()=>S.adminClient||S.client;
const isNetErr=e=>!e||!e.code&&/fetch|network|Failed|timeout|Load failed|NetworkError/i.test(e.message||String(e))||e.status===0;
async function execOp(op){
  const c=api(),t=op.t;let r;
  if(op.k==="ins")r=await c.from(t).upsert(op.row,{onConflict:keyOf(t),ignoreDuplicates:true});
  else if(op.k==="ups")r=await c.from(t).upsert(op.row,{onConflict:keyOf(t)}).select(keyOf(t));
  else if(op.k==="upd")r=await c.from(t).update(op.patch).eq(keyOf(t),op.id).select(keyOf(t));
  else if(op.k==="del")r=await c.from(t).delete().eq(keyOf(t),op.id).select(keyOf(t));
  else if(op.k==="rpc")r=await c.rpc(op.fn,op.args);
  if(r.error)throw r.error;
  if((op.k==="upd"||op.k==="del"||op.k==="ups")&&Array.isArray(r.data)&&r.data.length===0&&op.k!=="del")throw{code:"42501",message:"Only the Admin can change that"};
  return r.data;
}
let flushT;function flushSoon(ms){clearTimeout(flushT);flushT=setTimeout(flush,ms||50)}
async function flush(){
  if(S.syncing||!S.client||!S.queue.length)return;S.syncing=true;
  try{
    while(S.queue.length){
      const op=S.queue[0];
      try{const res=await execOp(op);if(op.fn==="receive_delivery"&&op.onDone)op.onDone(res)}
      catch(e){
        if(isNetErr(e)){S.online=false;renderStatus();flushSoon(15000);break}
        if(/JWT|jwt|401|refresh/i.test((e&&(e.message||e.code))||"")){try{await S.client.auth.refreshSession()}catch(_){}flushSoon(20000);break}
        S.queue.shift();saveQueue();S.failed++;
        toast(((e&&e.message)||"A change couldn't be saved")+" — change undone");
        refreshSoon();continue;
      }
      S.queue.shift();saveQueue();
      // mirror into server state so the UI doesn't flicker before realtime arrives
      if(op.k!=="rpc")applyOp(S.srv,op);else (op.local||[]).forEach(o=>applyOp(S.srv,o));
      S.online=true;
    }
  }finally{S.syncing=false;rebuild();render();renderStatus();saveCache()}
}

/* reading from the server */
async function fetchAll(t,build){
  const out=[];let from=0;
  for(;;){let q=S.client.from(t).select("*").range(from,from+999);if(build)q=build(q);const {data,error}=await q;if(error)throw error;out.push(...data);if(data.length<1000)break;from+=1000}
  return out;
}
function daysAgo(n){const d=new Date();d.setDate(d.getDate()-n);return ymd(d)}
async function loadAll(){
  if(!S.client)return;
  try{
    const [products,orders,settings]=await Promise.all(["products","orders","settings"].map(t=>fetchAll(t)));
    const srv={...S.srv};
    srv.products={};products.forEach(r=>{const o=fromRow("products",r);srv.products[o.id]=o});
    srv.orders={};orders.forEach(r=>{const o=fromRow("orders",r);srv.orders[o.id]=o});
    srv.settings={};settings.forEach(r=>{srv.settings[r.key]={key:r.key,value:r.value}});
    const minCount=Object.values(srv.products).filter(p=>p.active!==false).reduce((m,p)=>Math.min(m,num(p.countedAt)||Date.now()),Date.now());
    let from=ymd(new Date(minCount-864e5));const floor=daysAgo(400),min=daysAgo(120);if(from>min)from=min;if(from<floor)from=floor;
    const [sales,expenses,restocks]=await Promise.all(DAYT.map(t=>fetchAll(t,q=>q.gte("date",from))));
    for(const [t,list] of [["sales",sales],["expenses",expenses],["restocks",restocks]]){srv[t]={};list.forEach(r=>{const o=fromRow(t,r);srv[t][o.id]=o})}
    try{const [cs,cr]=await Promise.all([fetchAll("counter_sessions",q=>q.gte("date",daysAgo(400))),fetchAll("credits")]);
      srv.counter_sessions={};cs.forEach(r=>{const o=fromRow("counter_sessions",r);srv.counter_sessions[o.id]=o});
      srv.credits={};cr.forEach(r=>{const o=fromRow("credits",r);srv.credits[o.id]=o});S.sessErr=false}
    catch(e){if(isNetErr(e))throw e;S.sessErr=true;srv.counter_sessions=srv.counter_sessions||{};srv.credits=srv.credits||{}}
    S.srv=srv;S.loadedFrom=from;S.online=true;S.lastSync=Date.now();S.status="ok";
    rebuild();onAccess();render();renderStatus();saveCache();flushSoon();
  }catch(e){if(isNetErr(e)){S.online=false;renderStatus()}else toast("Couldn't load: "+(e.message||e))}
}
async function ensureFrom(date){ // load older days for reports
  if(!S.client||!S.loadedFrom||date>=S.loadedFrom)return;
  const to=S.loadedFrom;
  try{for(const t of DAYT){const list=await fetchAll(t,q=>q.gte("date",date).lt("date",to));list.forEach(r=>{const o=fromRow(t,r);S.srv[t][o.id]=o})}S.loadedFrom=date;rebuild();render()}catch(e){toast("Couldn't load older days — check the internet")}
}
let refT;function refreshSoon(){clearTimeout(refT);refT=setTimeout(loadAll,800)}
function startRealtime(){
  if(!S.client||S.channel)return;
  S.channel=S.client.channel("cave-live").on("postgres_changes",{event:"*",schema:"public"},p=>{
    const t=p.table;if(!S.srv[t])return;const k=keyOf(t);
    if(p.eventType==="DELETE"){const id=p.old&&p.old[k];if(id)delete S.srv[t][id]}
    else{const o=t==="settings"?{key:p.new.key,value:p.new.value}:fromRow(t,p.new);if(DAYT.includes(t)&&S.loadedFrom&&o.date<S.loadedFrom)return;S.srv[t][o[t==="settings"?"key":"id"]]=o}
    clearTimeout(S.rtT);S.rtT=setTimeout(()=>{rebuild();if(t==="staff"||t==="settings")onAccess();render();saveCache()},150);
  }).subscribe(st=>{if(st==="SUBSCRIBED"){S.online=true;renderStatus()}});
}
window.addEventListener("online",()=>{S.online=true;renderStatus();flushSoon();refreshSoon()});
window.addEventListener("offline",()=>{S.online=false;renderStatus()});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&Date.now()-S.lastSync>60000)refreshSoon()});
setInterval(()=>{if(S.queue.length)flushSoon();if(!document.hidden&&Date.now()-S.lastSync>180000)refreshSoon()},30000);
function renderStatus(){
  const el=$("#net");if(!el)return;const n=pendingCount(),q=S.queue.length;
  el.className="net "+(S.online?(q?"wait":"ok"):"off");
  el.textContent=S.online?(q?"Uploading "+q+"…":"Online"):("Offline"+(q?" · "+(n||q)+" waiting to upload":" · sales still save here"));
  el.title=S.online?"Connected to The Cave's database":"No internet. Sales are kept on this computer and upload automatically when the connection returns.";
}

/* the app's write helpers, translated into database operations */
function diffTable(t,before,after){
  const b={},a={};(before||[]).forEach(x=>b[x.id]=x);(after||[]).forEach(x=>a[x.id]=x);
  for(const id in a){const x={...a[id]};delete x._doc;const y=b[id];
    if(!y){enqueue({k:"ins",t,row:toRow(t,x)});continue}
    if(JSON.stringify(y)===JSON.stringify(a[id]))continue;
    if(t==="sales"&&!y.voidedAt&&x.voidedAt){enqueue({k:"rpc",fn:"void_sale",args:{p_id:id,p_by:x.voidedBy||S.name||"",p_reason:x.voidReason||""},local:[{k:"upd",t,id,patch:{voided_at:x.voidedAt,voided_by:x.voidedBy||"",void_reason:x.voidReason||""}}]});continue}
    if(t==="sales"&&!y.paidAt&&x.paidAt&&JSON.stringify({...y,paidAt:0,paidVia:0})===JSON.stringify({...x,paidAt:0,paidVia:0})){enqueue({k:"rpc",fn:"mark_credit_paid",args:{p_id:id,p_via:x.paidVia||"Cash",p_by:S.name||""},local:[{k:"upd",t,id,patch:{paid_at:x.paidAt,paid_via:x.paidVia||"Cash",paid_by:S.name||""}}]});continue}
    const patch={};const all=new Set([...Object.keys(x),...Object.keys(y)]);
    all.forEach(k=>{if(k==="id"||k==="date"||!COLS[t][k])return;if(JSON.stringify(x[k])!==JSON.stringify(y[k]))patch[COLS[t][k]]=x[k]===undefined?null:x[k]});
    if(Object.keys(patch).length)enqueue({k:"upd",t,id,patch});
  }
  for(const id in b)if(!a[id])enqueue({k:"del",t,id});
}
function mutateDay(docId,date,fn){
  if(!S.client){toast("Not connected yet");return Promise.resolve()}
  const cur=S.days[date]||{date,sales:[],expenses:[],restocks:[]};
  const clone=JSON.parse(JSON.stringify({date,sales:cur.sales,expenses:cur.expenses,restocks:cur.restocks}));
  const next=fn(clone);
  for(const t of DAYT){(next[t]||[]).forEach(x=>{x.date=date});diffTable(t,cur[t],next[t])}
  return Promise.resolve();
}
const myDoc=date=>date;
async function writeProduct(id,data,merge){
  if(merge){const patch=toRow("products",data);delete patch.id;enqueue({k:"upd",t:"products",id,patch})}
  else enqueue({k:"ups",t:"products",row:toRow("products",{...data,id})});
  return true;
}
async function writeDoc(path,data,merge){
  const [t,id]=path.split("/");
  if(t==="products")return writeProduct(id,data,merge);
  if(merge){const patch=toRow(t,data);delete patch.id;enqueue({k:"upd",t,id,patch})}else enqueue({k:"ups",t,row:toRow(t,{...data,id})});
  return true;
}
function writeErr(e){toast(isNetErr(e)?"No internet — saved on this computer":"Couldn't save: "+((e&&e.message)||e))}
function saveFile(filename,blob){const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},4000)}

/* ---------- UI helpers ---------- */
let toastT;
function toast(msg){$("#toastRoot").innerHTML='<div class="toast" role="status">'+esc(msg)+"</div>";clearTimeout(toastT);toastT=setTimeout(()=>$("#toastRoot").innerHTML="",2600)}
function openModal(html){$("#modalRoot").innerHTML='<div class="modalBack" data-act="closeBack"><div class="modal" role="dialog" aria-modal="true">'+html+"</div></div>";const f=$("#modalRoot input:not([type=hidden]),#modalRoot select");if(f)f.focus()}
function closeModal(){$("#modalRoot").innerHTML=""}
const opt=(arr,sel)=>arr.map(v=>'<option'+(v===sel?" selected":"")+">"+esc(v)+"</option>").join("");

/* ---------- render ---------- */
function render(){
  if(S.uid&&!tabOk(S.tab))S.tab="sell";
  document.querySelectorAll("#tabs button").forEach(b=>{b.setAttribute("aria-selected",b.dataset.tab===S.tab);b.hidden=!S.uid||!tabOk(b.dataset.tab)});
  const lb=$("#lockBtn");if(lb)lb.hidden=!S.uid;
  const meta=$("#meta");
  if(S.status==="ok")meta.textContent=niceDate(today())+(S.name?" · "+S.name+" ("+(S.role==="admin"?"Admin":"Seller")+")":"")+(S.readOnly?" · view only":"");
  
  const a=document.activeElement,keep=a&&a.id&&$("#main").contains(a)?{id:a.id,s:a.selectionStart,e:a.selectionEnd}:null;
  const m=$("#main");
  if(S.status==="loading"){m.innerHTML='<div class="empty">Loading your ledger…</div>';return}
  if(!S.uid){m.innerHTML="";return}
  m.innerHTML=({reports:vReports,team:vTeam,sell:vSell,sales:vSales,stock:vStock,orders:vOrders,expenses:vExpenses,summary:vSummary,history:vHistory,products:vProducts}[S.tab]||vSell)();
  if(keep){const el=document.getElementById(keep.id);if(el){el.focus();try{el.setSelectionRange(keep.s,keep.e)}catch(e){}}}
}

/* ---------- Sell: counter sessions (open counter → sell → close counter with a report) ---------- */
const AT_CLOSE="At close"; // sales on a counter session: payment is counted at close, not per sale
const isOpenSale=s=>!s.voidedAt&&(s.status==="open"||(s.pay==="Credit"&&!s.paidAt));
const paidDay=s=>s.paidAt?ymd(new Date(s.paidAt)):s.date;
const payLabel=s=>isOpenSale(s)?"Open":s.pay;
const itemsText=s=>(s.items||[]).map(i=>i.qty+"× "+i.name).join(", ");
const since=ts=>{const m=Math.round((Date.now()-ts)/6e4);if(m<1)return"just now";if(m<60)return m+" min";if(m<1440)return Math.floor(m/60)+" h "+(m%60)+" min";return Math.floor(m/1440)+" days"};
const whenTxt=ts=>ts?niceDate(ymd(new Date(ts)))+", "+time(ts):"—";
const diffTxt=d=>Math.round(d||0)===0?"Matches":d<0?"Short "+money(-d):"Over "+money(d);
const diffCls=d=>Math.round(d||0)===0?"ok":d<0?"out":"low";
const OTHER_PAY=METHODS.filter(m=>m!=="Cash");
function openSessions(){return Object.values(S.sessions||{}).filter(x=>x.status==="open").sort((a,b)=>a.openedAt-b.openedAt)}
function curSession(){const o=openSessions();return o.length?o[o.length-1]:null}
function lastClosed(){return Object.values(S.sessions||{}).filter(x=>x.status==="closed").sort((a,b)=>(b.closedAt||0)-(a.closedAt||0))[0]||null}
function sessSales(id,withVoid){return collect("sales","0000-00-00","9999-99-99",withVoid).filter(s=>s.sessionId===id)}
function sessTotal(id){return sessSales(id).reduce((a,s)=>a+saleTotal(s),0)}
const creditLeft=c=>num(c.amount)-num(c.paidAmount);
const openCredits=()=>Object.values(S.credits||{}).filter(c=>!c.paidAt&&creditLeft(c)>0).sort((a,b)=>a.createdAt-b.createdAt);
function newTicket(){S.ticket={items:[]}}
if(!S.ticket)newTicket();
function ticketTotal(){return S.ticket.items.reduce((a,i)=>a+num(i.qty)*num(i.price),0)}
function addToTicket(p){if(!p)return;const ex=S.ticket.items.find(i=>i.pid===p.id);if(ex)ex.qty++;else S.ticket.items.push({pid:p.id,name:p.name,size:p.size||"",qty:1,price:num(p.price),cost:num(p.cost)});S.flash=p.id}
function sellMatches(){
  const q=(S.q||"").trim().toLowerCase();if(!q)return[];
  const sm=stockMap(),words=q.split(/\s+/);
  return prodList().filter(p=>{const h=(p.name+" "+(p.size||"")+" "+p.cat).toLowerCase();return words.every(w=>h.includes(w))})
    .sort((a,b)=>((sm[b.id]>0)-(sm[a.id]>0))||((a.rank||999)-(b.rank||999))||a.name.localeCompare(b.name)).slice(0,10);
}
function prow(p,sm,first){const q=sm[p.id];return`<button class="prow${q<=0?" out":""}${first?" first":""}${S.flash===p.id?" flash":""}" data-act="add" data-id="${p.id}"><span class="pn"><b>${esc(p.name)}</b> <span class="muted small">${esc(p.size||"")}</span></span><span class="num pp">${money(p.price)}</span><span class="num ps${q<=0?" bad":q<=num(p.reorder)?" warn":""}">${q} left</span><span class="plus" aria-hidden="true">+</span></button>`}
const FINE=window.matchMedia&&matchMedia("(pointer:fine)").matches; // mouse/keyboard counter vs phone
function revealTicket(){const tk=document.querySelector(".ticket .savebtn")||document.querySelector(".ticket .total");if(!tk)return;const r=tk.getBoundingClientRect();if(r.bottom>innerHeight-8)tk.scrollIntoView({block:"end",behavior:"smooth"})}

function vSell(){
  if(S.sessErr)return`<div class="banner">The counter needs a database update first. Ask the Admin to run <b>9-counter-sessions.sql</b> in Supabase.</div>`;
  if(S.close){const x=(S.sessions||{})[S.close.id];if(x&&x.status==="open")return vClose(x);S.close=null}
  if(S.justClosed){const x=(S.sessions||{})[S.justClosed];if(x)return vClosed(x);S.justClosed=null}
  const cur=curSession();
  if(!cur)return vOpenCounter();
  const others=openSessions().filter(x=>x.id!==cur.id);
  const sm=stockMap(),matches=sellMatches(),T=S.ticket,tot=ticketTotal();
  const list=sessSales(cur.id,true),live=list.filter(s=>!s.voidedAt),sTot=live.reduce((a,s)=>a+saleTotal(s),0);
  const old=Date.now()-cur.openedAt>12*36e5,nItems=T.items.reduce((a,i)=>a+num(i.qty),0);
  return `
  ${others.map(x=>`<div class="banner warnb row between"><span><b>${niceDate(x.date)}</b> was never closed · opened ${whenTxt(x.openedAt)} · ${money(sessTotal(x.id))}</span>${S.readOnly?"":`<button class="btn primary" data-act="startClose" data-id="${x.id}">Close ${niceDate(x.date)}</button>`}</div>`).join("")}
  ${old?`<div class="banner warnb row between"><span>This counter was opened on <b>${whenTxt(cur.openedAt)}</b>. If today is a new day, close it first.</span>${S.readOnly?"":`<button class="btn primary" data-act="startClose" data-id="${cur.id}">Close ${niceDate(cur.date)}</button>`}</div>`:""}
  <section class="panel counterbar">
    <div class="row between">
      <div><span class="pill ok">Counter open</span> <b class="tlabel">${niceDate(cur.date)}</b> <span class="muted small">since ${time(cur.openedAt)}${cur.openedBy?" · "+esc(cur.openedBy):""}</span></div>
      <div class="row"><span><b class="num">${money(sTot)}</b> <span class="muted small">· ${live.length} sale${live.length===1?"":"s"}</span></span>${S.readOnly?"":`<button class="btn" data-act="startClose" data-id="${cur.id}">Close counter</button>`}</div>
    </div>
  </section>
  <div class="pos">
    <section class="panel addp">
      <div class="searchwrap"><input type="search" id="q" placeholder="Type a drink name…" value="${esc(S.q)}" autocomplete="off" aria-label="Search drinks"></div>
      ${S.q?`<div class="plist">${matches.length?matches.map((p,i)=>prow(p,sm,i===0)).join(""):'<div class="empty">No drink matches “'+esc(S.q)+'”.</div>'}</div>`
        :`<div class="empty bigempty">Type the first letters of the drink, then tap it to add it to the sale.</div>`}
    </section>
    <section class="panel ticket">
      <div class="row between"><h3>New sale${nItems?` <span class="pill n num">${nItems} item${nItems===1?"":"s"}</span>`:""}</h3>${T.items.length?`<button class="btn ghost small" data-act="clearTicket">Clear</button>`:""}</div>
      <div class="tlines">${T.items.length?T.items.map((i,ix)=>`<div class="tline${S.flash===i.pid?" flash":""}">
          <div class="tn"><b>${esc(i.name)}</b> <span class="muted small">${esc(i.size||"")}</span>
            <div class="muted small">@ <input class="pin num" type="text" inputmode="numeric" id="pr${ix}" data-act="price" data-ix="${ix}" value="${i.price}" aria-label="Price each"></div></div>
          <div class="qty"><button data-act="qty" data-ix="${ix}" data-d="-1" aria-label="One less">−</button><span class="num">${i.qty}</span><button data-act="qty" data-ix="${ix}" data-d="1" aria-label="One more">+</button></div>
          <div class="num lt">${money(i.qty*i.price)}</div></div>`).join(""):`<div class="empty">Nothing yet. Search for a drink to add it.</div>`}</div>
      <div class="total"><span>Total</span><span class="num">${money(tot)}</span></div>
      ${S.readOnly?"":`<button class="btn primary big savebtn" data-act="saveSale" ${T.items.length?"":"disabled"}>Save sale</button>`}
    </section>
  </div>
  <section class="panel">
    <div class="row between"><h3>Sales on this counter · ${niceDate(cur.date)}</h3><b class="num">${money(sTot)}</b></div>
    ${list.length?`<div class="tbl"><table><tbody>${list.map(s=>{const v=!!s.voidedAt;return`<tr${v?' class="voided"':""}><td class="num" style="width:56px">${time(s.ts)}</td><td>${esc(itemsText(s))}${v?`<div class="small" style="color:var(--bad)">Voided${s.voidReason?" — "+esc(s.voidReason):""}</div>`:""}</td><td class="muted small">${esc(s.by||"")}</td><td class="r num">${v?`<s>${money(saleTotal(s))}</s>`:money(saleTotal(s))}</td><td class="r">${!v&&canVoid(s)?`<button class="btn ghost small" data-act="voidSale" data-id="${s.id}" data-doc="${s._doc}">Void</button>`:""}</td></tr>`}).join("")}</tbody></table></div>
    <p class="muted small" style="margin:0">Made a mistake? Tap <b>Void</b> within 10 minutes. After that, ask the Admin.</p>`:'<div class="empty">No sales yet on this counter.</div>'}
  </section>`;
}
function vOpenCounter(){
  const last=lastClosed();
  return `<section class="panel counter-start">
    <h2>The counter is closed</h2>
    <p class="muted" style="margin:0">Open the counter to start recording sales.</p>
    ${S.readOnly?"":`<button class="btn primary huge" data-act="openCounter">Open counter</button>`}
    ${last?`<div class="muted small">Last closed: <b>${niceDate(last.date)}</b> · ${money(last.totalSales)} · ${whenTxt(last.closedAt)}${last.closedBy?" by "+esc(last.closedBy):""}</div><button class="btn" data-act="pdfReport" data-id="${last.id}">Download that report (PDF)</button>`:""}
  </section>`;
}
function openCounter(){
  if(curSession()){render();return}
  const ts=Date.now(),x={id:"cs"+uid(),date:today(),status:"open",openedAt:ts,openedBy:S.name||"",openedById:S.uid||"",device:DEV};
  enqueue({k:"ins",t:"counter_sessions",row:toRow("counter_sessions",x)});
  S.justClosed=null;newTicket();toast("Counter open · "+niceDate(x.date));
  setTimeout(()=>{const q=$("#q");q&&q.focus()},0);
}

/* ---------- Close counter ---------- */
function startClose(id){
  const x=(S.sessions||{})[id];if(!x)return;
  const exp=collect("expenses",x.date,x.date).filter(e=>!["Rent","Wages"].includes(e.cat)).reduce((a,e)=>a+num(e.amount),0);
  S.close={id,cash:"",paidOut:exp?String(exp):"",mobile:{},credits:[{id:"cr"+uid(),name:"",amount:""}],collected:{},note:"",expHint:exp};
  S.q="";S.confirm=null;S.tab="sell";ls("cave_tab","sell");window.scrollTo(0,0);
}
function closeCalc(x){
  const C=S.close,total=sessTotal(x.id);
  const mob=OTHER_PAY.reduce((a,m)=>a+num(C.mobile[m]),0);
  const cred=C.credits.reduce((a,c)=>a+(c.name.trim()?num(c.amount):0),0);
  const col=Object.entries(C.collected).reduce((a,[id,c])=>{const cr=(S.credits||{})[id];return a+Math.min(num(c.amount),cr?creditLeft(cr):num(c.amount))},0);
  const acc=num(C.cash)+num(C.paidOut)+mob+cred-col;
  return{total,mob,cred,col,acc,diff:acc-total};
}
const mIn=(id,val,key,ph)=>`<input type="text" inputmode="numeric" class="moneyin num" id="${id}" data-cl="${key}" value="${esc(val)}" placeholder="${ph||""}" autocomplete="off">`;
function closeSumHtml(x){
  const k=closeCalc(x),d=Math.round(k.diff);
  return `<div class="sumrow"><span>Total sales on this counter</span><b class="num">${money(k.total)}</b></div>
    <div class="sumrow"><span>Money you have accounted for</span><b class="num">${money(k.acc)}</b></div>
    <div class="sumrow big ${d===0?"good":d<0?"bad":"warn"}"><span>${d===0?"Everything matches ✓":d<0?"Short by":"Over by"}</span><b class="num">${d===0?"":money(Math.abs(d))}</b></div>`;
}
function closeBtnHtml(x){
  const d=Math.round(closeCalc(x).diff),armed=S.confirm==="close"+x.id;
  return `<button class="btn primary big" data-act="doClose" id="closeBtn"${armed?' style="background:var(--bad);border-color:var(--bad)"':""}>${armed?(d<0?"Short by "+money(-d):"Over by "+money(d))+" — tap again to close anyway":"Close "+niceDate(x.date)+" & make report"}</button>`;
}
function vClose(x){
  const C=S.close,sales=sessSales(x.id),oc=openCredits();
  return `<div class="row between"><h2>Close counter · ${niceDate(x.date)}</h2><button class="btn" data-act="cancelClose">Back</button></div>
  <section class="panel closeform">
    <div class="muted small">Opened ${whenTxt(x.openedAt)}${x.openedBy?" by "+esc(x.openedBy):""} · ${sales.length} sale${sales.length===1?"":"s"} · ${bottles(sales)} bottles</div>
    <div class="cstep"><h3><span class="n">1</span>Cash in the drawer</h3><p class="muted small">Count all the notes and coins.</p>${mIn("cl_cash",C.cash,"cash","Type the cash counted")}</div>
    <div class="cstep"><h3><span class="n">2</span>Mobile money and card</h3><p class="muted small">Check each phone or statement for this counter's total. Leave empty if none.</p>
      <div class="grid2">${OTHER_PAY.map((m,ix)=>`<label class="f">${esc(m)}${mIn("cl_m"+ix,C.mobile[m]??"","m:"+m)}</label>`).join("")}</div></div>
    <div class="cstep"><h3><span class="n">3</span>Credit (deni) — who didn't pay</h3><p class="muted small">One line per person. Leave empty if everyone paid.</p>
      ${C.credits.map((c,i)=>`<div class="credrow"><input type="text" id="cl_cn${i}" data-cl="cn:${i}" value="${esc(c.name)}" placeholder="Name" autocomplete="off">${mIn("cl_ca"+i,c.amount,"ca:"+i,"Amount")}${C.credits.length>1?`<button class="btn ghost small" data-act="clDelCredit" data-ix="${i}" aria-label="Remove line">✕</button>`:""}</div>`).join("")}
      <div><button class="btn small" data-act="clAddCredit">+ Add another person</button></div></div>
    ${oc.length?`<div class="cstep"><h3><span class="n">4</span>Old credit paid back on this counter</h3><p class="muted small">Only fill in people who paid. This money is in the cash or mobile totals above, so it's taken off.</p>
      ${oc.map(c=>{const v=C.collected[c.id]||{};return`<div class="credrow col"><div><b>${esc(c.name)}</b><div class="muted small">Owes ${money(creditLeft(c))} · since ${niceDate(c.date)}</div></div>${mIn("cl_ka_"+c.id,v.amount??"","ka:"+c.id,"Paid")}<select id="cl_kv_${c.id}" data-clv="${c.id}" aria-label="Paid with">${opt(METHODS,v.via||"Cash")}</select></div>`}).join("")}</div>`:""}
    <div class="cstep"><h3><span class="n">${oc.length?5:4}</span>Taken from the drawer for expenses (matumizi)</h3><p class="muted small">${C.expHint?"Expenses recorded for "+niceDate(x.date)+": "+money(C.expHint)+". Change it if some weren't paid from the drawer.":"Money paid out of the drawer, e.g. ice, transport. Record each one in Expenses too."}</p>${mIn("cl_out",C.paidOut,"out")}</div>
    <div class="cstep"><label class="f">Note (optional)<input type="text" id="cl_note" data-cl="note" value="${esc(C.note)}" placeholder="e.g. power cut from 21:00" autocomplete="off"></label></div>
    <div class="sumbox" id="closeSum">${closeSumHtml(x)}</div>
    <div id="closeBtnWrap">${S.readOnly?"":closeBtnHtml(x)}</div>
  </section>`;
}
function updateCloseSum(){const x=S.close&&(S.sessions||{})[S.close.id];if(!x)return;const a=$("#closeSum");if(a)a.innerHTML=closeSumHtml(x);const b=$("#closeBtnWrap");if(b&&!S.readOnly){if(S.confirm==="close"+x.id)S.confirm=null;b.innerHTML=closeBtnHtml(x)}}
function closeInput(t){
  const C=S.close;if(!C)return;const k=t.dataset.cl,v=t.value;
  const clean=s=>s.replace(/[^0-9.,]/g,"");
  if(k==="cash")C.cash=clean(v);else if(k==="out")C.paidOut=clean(v);else if(k==="note")C.note=v;
  else if(k.startsWith("m:"))C.mobile[k.slice(2)]=clean(v);
  else if(k.startsWith("cn:"))C.credits[+k.slice(3)].name=v;
  else if(k.startsWith("ca:"))C.credits[+k.slice(3)].amount=clean(v);
  else if(k.startsWith("ka:")){const id=k.slice(3);C.collected[id]={...(C.collected[id]||{via:"Cash"}),amount:clean(v)}}
  updateCloseSum();
}
function doClose(){
  const C=S.close,x=C&&(S.sessions||{})[C.id];if(!x)return;
  if(String(C.cash).trim()===""){toast("Type the cash in the drawer first (0 if there is none)");const c=$("#cl_cash");c&&c.focus();return}
  if(C.credits.some(c=>(c.name.trim()&&!num(c.amount))||(!c.name.trim()&&num(c.amount)))){toast("Each credit line needs a name and an amount");return}
  const k=closeCalc(x);
  if(Math.round(k.diff)!==0&&S.confirm!=="close"+x.id){S.confirm="close"+x.id;const b=$("#closeBtnWrap");if(b)b.innerHTML=closeBtnHtml(x);return}
  S.confirm=null;
  const ts=Date.now(),live=sessSales(x.id),voided=sessSales(x.id,true).filter(s=>s.voidedAt);
  const lines={};live.forEach(s=>(s.items||[]).forEach(i=>{const l=lines[i.pid]=lines[i.pid]||{name:i.name,size:i.size||"",qty:0,amount:0};l.qty+=num(i.qty);l.amount+=num(i.qty)*num(i.price)}));
  const credits=C.credits.filter(c=>c.name.trim()&&num(c.amount)>0).map(c=>({id:c.id,name:c.name.trim(),amount:num(c.amount)}));
  const collected=Object.entries(C.collected).map(([id,v])=>{const cr=(S.credits||{})[id];const amt=Math.min(num(v.amount),cr?creditLeft(cr):0);return{credit_id:id,name:cr?cr.name:"",from:cr?cr.date:"",amount:amt,via:v.via||"Cash"}}).filter(c=>c.amount>0);
  const mobile={};OTHER_PAY.forEach(m=>mobile[m]=num(C.mobile[m]));
  const sellers={};live.forEach(s=>{const n=s.by||"—";sellers[n]=(sellers[n]||0)+saleTotal(s)});
  const report={v:1,date:x.date,openedAt:x.openedAt,openedBy:x.openedBy||"",closedAt:ts,closedBy:S.name||"",count:live.length,bottles:bottles(live),
    total:k.total,cash:num(C.cash),paidOut:num(C.paidOut),mobile,credits:credits.map(({name,amount})=>({name,amount})),collected,
    creditTotal:k.cred,collectedTotal:k.col,accounted:k.acc,diff:k.diff,
    lines:Object.values(lines).sort((a,b)=>b.amount-a.amount),voided:voided.length,voidedTotal:voided.reduce((a,s)=>a+saleTotal(s),0),sellers,note:C.note.trim()};
  const p={closed_at:ts,closed_by:S.name||"",closed_by_id:S.uid||"",cash:report.cash,paid_out:report.paidOut,mobile,note:report.note,report,credits,collected:collected.map(c=>({credit_id:c.credit_id,amount:c.amount,via:c.via}))};
  const local=[{k:"upd",t:"counter_sessions",id:x.id,patch:{status:"closed",closed_at:ts,closed_by:S.name||"",closed_by_id:S.uid||"",total_sales:k.total,cash:report.cash,paid_out:report.paidOut,mobile,credit_total:k.cred,collected_total:k.col,difference:k.diff,note:report.note||null,report}}];
  credits.forEach(c=>local.push({k:"ins",t:"credits",row:{id:c.id,session_id:x.id,date:x.date,name:c.name,amount:c.amount,paid_amount:0,payments:[],created_at:ts,created_by:S.name||""}}));
  collected.forEach(c=>{const cr=S.credits[c.credit_id];if(!cr)return;const pa=num(cr.paidAmount)+c.amount;local.push({k:"upd",t:"credits",id:c.credit_id,patch:{paid_amount:pa,payments:[...(cr.payments||[]),{session_id:x.id,amount:c.amount,via:c.via,ts,by:S.name||""}],paid_at:pa>=num(cr.amount)?ts:null}})});
  enqueue({k:"rpc",fn:"close_session",args:{p_id:x.id,p},local});
  S.close=null;S.justClosed=x.id;render();window.scrollTo(0,0);toast(niceDate(x.date)+" closed · report saved");
}
function vClosed(x){
  const r=x.report||{},cur=curSession();
  return `<section class="panel counter-start">
    <div class="bigtick" aria-hidden="true">✓</div>
    <h2>${niceDate(x.date)} is closed</h2>
    <div class="sumbox" style="width:100%;max-width:420px;text-align:left">
      <div class="sumrow"><span>Total sales</span><b class="num">${money(r.total??x.totalSales)}</b></div>
      <div class="sumrow"><span>Cash</span><b class="num">${money(r.cash)}</b></div>
      <div class="sumrow"><span>Mobile money & card</span><b class="num">${money(Object.values(r.mobile||{}).reduce((a,v)=>a+num(v),0))}</b></div>
      <div class="sumrow"><span>Credit (deni)</span><b class="num">${money(r.creditTotal)}</b></div>
      <div class="sumrow big ${Math.round(r.diff||0)===0?"good":r.diff<0?"bad":"warn"}"><span>${diffTxt(r.diff)}</span><b></b></div>
    </div>
    <button class="btn huge" data-act="pdfReport" data-id="${x.id}">Download report (PDF)</button>
    ${cur?`<button class="btn primary big" data-act="doneClosed">Back to the counter</button>`:`<button class="btn primary huge" data-act="openCounter">Open counter for a new day</button><button class="btn ghost" data-act="doneClosed">Not now</button>`}
    <p class="muted small" style="margin:0">The report is also saved for the Admin.</p>
  </section>`;
}

/* ---------- report PDF (A4) ---------- */
function pdfReport(x){
  if(!window.jspdf){toast("PDF tool is still loading — try again in a moment");return}
  const r=x.report;if(!r){toast("This counter has no report yet");return}
  const {jsPDF}=window.jspdf,doc=new jsPDF({unit:"mm",format:"a4"}),W=210,L=16,R=W-16,mny=n=>Math.round(n||0).toLocaleString("en-US");
  let y=18;
  const need=h=>{if(y+h>280){doc.addPage();y=20}};
  doc.setFont("helvetica","bold");doc.setFontSize(18);doc.text("THE CAVE LIQUOR HOUSE",L,y);
  doc.setFont("helvetica","normal");doc.setFontSize(10);doc.text("Sinza, Dar es Salaam",L,y+6);
  doc.setFont("helvetica","bold");doc.setFontSize(13);doc.text("DAILY SALES REPORT",R,y,{align:"right"});
  doc.setFont("helvetica","normal");doc.setFontSize(11);doc.text(niceDate(r.date)+" "+r.date.slice(0,4),R,y+6,{align:"right"});
  y+=14;doc.setDrawColor(40);doc.setLineWidth(.5);doc.line(L,y,R,y);y+=7;
  const meta=[["Opened",whenTxt(r.openedAt)+(r.openedBy?" · "+r.openedBy:"")],["Closed",whenTxt(r.closedAt)+(r.closedBy?" · "+r.closedBy:"")],["Sales",r.count+" sales · "+r.bottles+" bottles"],["Voided",r.voided?r.voided+" (TSh "+mny(r.voidedTotal)+")":"None"]];
  doc.setFontSize(10);meta.forEach(([k,v],ix)=>{const xx=ix%2?W/2+4:L,yy=y+Math.floor(ix/2)*6;doc.setFont("helvetica","bold");doc.text(k+":",xx,yy);doc.setFont("helvetica","normal");doc.text(String(v),xx+18,yy)});
  y+=16;
  const section=t=>{need(16);doc.setFillColor(235,230,222);doc.rect(L,y-5,R-L,8,"F");doc.setFont("helvetica","bold");doc.setFontSize(10);doc.text(t,L+2,y);y+=8;doc.setFont("helvetica","normal")};
  const row=(a,b,bold,indent)=>{need(7);doc.setFont("helvetica",bold?"bold":"normal");doc.setFontSize(10);doc.text(a,L+2+(indent||0),y);doc.text(b,R-2,y,{align:"right"});doc.setDrawColor(215);doc.setLineWidth(.2);doc.line(L,y+2.3,R,y+2.3);y+=7};
  section("MONEY");
  row("Total sales","TSh "+mny(r.total),true);
  row("Cash in the drawer","TSh "+mny(r.cash));
  if(r.paidOut)row("Taken from the drawer for expenses","TSh "+mny(r.paidOut));
  OTHER_PAY.forEach(m=>{if(num((r.mobile||{})[m]))row(m,"TSh "+mny(r.mobile[m]))});
  row("Credit (deni) given","TSh "+mny(r.creditTotal));
  if(r.collectedTotal)row("Less: old credit paid back","− TSh "+mny(r.collectedTotal));
  row("Money accounted for","TSh "+mny(r.accounted),true);
  row("Difference",Math.round(r.diff||0)===0?"Matches":(r.diff<0?"SHORT TSh ":"OVER TSh ")+mny(Math.abs(r.diff)),true);
  y+=3;
  if((r.credits||[]).length){section("CREDIT GIVEN (WHO DIDN'T PAY)");r.credits.forEach(c=>row(c.name,"TSh "+mny(c.amount)));y+=3}
  if((r.collected||[]).length){section("OLD CREDIT PAID BACK");r.collected.forEach(c=>row(c.name+(c.from?"  (from "+niceDate(c.from)+")":"")+" · "+c.via,"TSh "+mny(c.amount)));y+=3}
  const sel=Object.entries(r.sellers||{});if(sel.length>1){section("BY SELLER");sel.forEach(([n,v])=>row(n,"TSh "+mny(v)));y+=3}
  section("ITEMS SOLD");
  need(7);doc.setFont("helvetica","bold");doc.setFontSize(9);doc.text("Item",L+2,y);doc.text("Qty",150,y,{align:"right"});doc.text("Amount (TSh)",R-2,y,{align:"right"});y+=6;
  doc.setFont("helvetica","normal");doc.setFontSize(10);
  (r.lines||[]).forEach(l=>{need(6.5);doc.text((l.name+(l.size?" "+l.size:"")).slice(0,70),L+2,y);doc.text(String(l.qty),150,y,{align:"right"});doc.text(mny(l.amount),R-2,y,{align:"right"});doc.setDrawColor(225);doc.setLineWidth(.15);doc.line(L,y+2,R,y+2);y+=6.5});
  if(!(r.lines||[]).length)row("No sales","");
  if(r.note){y+=3;need(10);doc.setFont("helvetica","bold");doc.text("Note:",L,y);doc.setFont("helvetica","normal");doc.text(doc.splitTextToSize(r.note,R-L-16),L+14,y);y+=8}
  need(26);y=Math.max(y+14,y);doc.setDrawColor(60);doc.setLineWidth(.3);
  doc.line(L,y,L+70,y);doc.line(R-70,y,R,y);doc.setFontSize(9);doc.text("Seller: "+(r.closedBy||""),L,y+5);doc.text("Checked by",R-70,y+5);
  doc.save("The Cave report "+r.date+".pdf");
}

function sellAct(a,b){
  const T=S.ticket,P=S.products[b.dataset.id];
  switch(a){
    case"add":if(P){addToTicket(P);S.q="";render();
      if(!FINE)revealTicket();
      setTimeout(()=>{S.flash=null;if(FINE){const q=$("#q");q&&q.focus({preventScroll:true})}},250)}return true;
    case"qty":{const i=T.items[+b.dataset.ix];if(!i)return true;i.qty+=+b.dataset.d;if(i.qty<=0)T.items.splice(+b.dataset.ix,1);render();return true}
    case"clearTicket":newTicket();render();return true;
    case"saveSale":{
      const cur=curSession();if(!cur){toast("Open the counter first");render();return true}
      if(!T.items.length)return true;const ts=Date.now(),tot=ticketTotal();
      const sale={id:uid(),date:cur.date,ts,items:T.items.map(i=>({...i})),pay:AT_CLOSE,status:"paid",sessionId:cur.id,by:S.name||"",byId:S.uid||""};
      enqueue({k:"ins",t:"sales",row:toRow("sales",sale)});toast("Sale saved · "+money(tot));
      newTicket();render();setTimeout(()=>{const q=$("#q");q&&q.focus({preventScroll:true})},0);return true}
    case"openCounter":openCounter();render();return true;
    case"startClose":startClose(b.dataset.id);render();setTimeout(()=>{const c=$("#cl_cash");c&&c.focus()},0);return true;
    case"cancelClose":S.close=null;S.confirm=null;render();return true;
    case"clAddCredit":S.close.credits.push({id:"cr"+uid(),name:"",amount:""});render();setTimeout(()=>{const c=$("#cl_cn"+(S.close.credits.length-1));c&&c.focus()},0);return true;
    case"clDelCredit":S.close.credits.splice(+b.dataset.ix,1);render();return true;
    case"doClose":doClose();return true;
    case"doneClosed":S.justClosed=null;render();return true;
    case"pdfReport":{const x=(S.sessions||{})[b.dataset.id];if(x)pdfReport(x);return true}
  }
  return false;
}
function changePay(id,m){
  const s=collect("sales","0000-00-00","9999-99-99").find(x=>x.id===id);if(!s||s.pay===m)return;
  enqueue({k:"rpc",fn:"set_sale_payment",args:{p_id:id,p_pay:m,p_by:S.name},local:[{k:"upd",t:"sales",id,patch:{pay:m,paid_via:m,edited_at:Date.now(),edited_by:S.name}}]});
  toast("Payment changed to "+m);
}

/* ---------- Reports (Admin): every counter session + credit list ---------- */
function sessPay(x){ // how a closed counter's sales were paid, adding up to its total sales
  const r=x.report||{},out={};const add=(k,v)=>{v=num(v);if(v)out[k]=(out[k]||0)+v};
  add("Cash",num(x.cash)+num(x.paidOut));
  Object.entries(x.mobile||{}).forEach(([k,v])=>add(k,v));
  (r.collected||[]).forEach(c=>add(c.via,-num(c.amount)));
  add("Credit (deni)",x.creditTotal);
  const d=Math.round(num(x.difference));if(d<0)add("Short (missing)",-d);if(d>0)add("Cash",-d);
  return out;
}
function vReports(){
  if(S.sessErr)return`<h2>Daily reports</h2><div class="banner">Run <b>supabase/9-counter-sessions.sql</b> in the Supabase SQL editor to switch on counter sessions and reports.</div>`;
  const all=Object.values(S.sessions||{}).sort((a,b)=>b.openedAt-a.openedAt);
  const oc=openCredits(),owed=oc.reduce((a,c)=>a+creditLeft(c),0);
  const mobOf=x=>Object.values(x.mobile||{}).reduce((a,v)=>a+num(v),0);
  return `<div class="row between"><h2>Daily reports</h2></div>
  <section class="panel">
    ${all.length?`<div class="tbl"><table><thead><tr><th>Day</th><th>Counter</th><th class="r">Sales</th><th class="r">Cash</th><th class="r">Mobile & card</th><th class="r">Credit</th><th class="r">Difference</th></tr></thead><tbody>
    ${all.map(x=>x.status==="open"?`<tr class="click" data-act="openReport" data-id="${x.id}"><td><b>${niceDate(x.date)}</b></td><td><span class="pill low">Still open</span><div class="muted small">since ${whenTxt(x.openedAt)}</div></td><td class="r num">${money(sessTotal(x.id))}</td><td colspan="4" class="muted small">Not closed yet</td></tr>`
      :`<tr class="click" data-act="openReport" data-id="${x.id}"><td><b>${niceDate(x.date)}</b></td><td class="small">${time(x.openedAt)}–${time(x.closedAt)}<div class="muted small">${esc(x.closedBy||"")}</div></td><td class="r num"><b>${money(x.totalSales)}</b></td><td class="r num">${money(num(x.cash)+num(x.paidOut))}</td><td class="r num">${money(mobOf(x))}</td><td class="r num">${money(x.creditTotal)}</td><td class="r"><span class="pill ${diffCls(x.difference)}">${diffTxt(x.difference)}</span></td></tr>`).join("")}
    </tbody></table></div><p class="muted small" style="margin:0">Tap a day to see its report. Cash includes money taken from the drawer for expenses.</p>`:'<div class="empty">No counters yet. Reports appear here each time a seller closes the counter.</div>'}
  </section>
  <section class="panel"><div class="row between"><h3>Credit not paid yet (deni)</h3><b class="num">${money(owed)}</b></div>
    ${oc.length?`<div class="tbl"><table><thead><tr><th>Name</th><th>Since</th><th class="r">Credit</th><th class="r">Paid back</th><th class="r">Still owes</th></tr></thead><tbody>${oc.map(c=>`<tr><td><b>${esc(c.name)}</b>${c.note?`<div class="muted small">${esc(c.note)}</div>`:""}</td><td class="small">${niceDate(c.date)}</td><td class="r num">${money(c.amount)}</td><td class="r num">${num(c.paidAmount)?money(c.paidAmount):"—"}</td><td class="r num"><b>${money(creditLeft(c))}</b></td></tr>`).join("")}</tbody></table></div>
    <p class="muted small" style="margin:0">When someone pays back, the seller enters it when closing the counter. It shows as “Old credit paid back” in that day's report.</p>`:'<div class="empty">Nobody owes the shop right now.</div>'}
  </section>`;
}
function reportModal(x){
  const r=x.report;
  if(x.status==="open"){const n=sessSales(x.id).length;openModal(`<div style="display:grid;gap:12px"><div class="row between"><h2>${niceDate(x.date)} · still open</h2><button class="btn ghost" data-act="close" aria-label="Close">✕</button></div>
    <p class="muted small" style="margin:0">Opened ${whenTxt(x.openedAt)}${x.openedBy?" by "+esc(x.openedBy):""} · ${n} sale${n===1?"":"s"} · ${money(sessTotal(x.id))} so far.</p>
    ${S.readOnly?"":`<div class="row" style="justify-content:flex-end"><button class="btn primary" data-act="adminClose" data-id="${x.id}">Close this counter</button></div>`}</div>`);return}
  if(!r){openModal(`<h2>${niceDate(x.date)}</h2><p class="muted">No report saved.</p><div class="row" style="justify-content:flex-end"><button class="btn" data-act="close">Close</button></div>`);return}
  const armed=S.confirm==="reopen"+x.id;
  openModal(`<div style="display:grid;gap:12px">
    <div class="row between"><h2>Report · ${niceDate(r.date)}</h2><button class="btn ghost" data-act="close" aria-label="Close">✕</button></div>
    <p class="muted small" style="margin:0">Opened ${whenTxt(r.openedAt)}${r.openedBy?" by "+esc(r.openedBy):""} · closed ${whenTxt(r.closedAt)}${r.closedBy?" by "+esc(r.closedBy):""} · ${r.count} sales · ${r.bottles} bottles${r.voided?" · "+r.voided+" voided":""}</p>
    <div class="tbl"><table><tbody>
      <tr><td><b>Total sales</b></td><td class="r num"><b>${money(r.total)}</b></td></tr>
      <tr><td>Cash in the drawer</td><td class="r num">${money(r.cash)}</td></tr>
      ${r.paidOut?`<tr><td>Taken from drawer for expenses</td><td class="r num">${money(r.paidOut)}</td></tr>`:""}
      ${OTHER_PAY.filter(m=>num((r.mobile||{})[m])).map(m=>`<tr><td>${esc(m)}</td><td class="r num">${money(r.mobile[m])}</td></tr>`).join("")}
      <tr><td>Credit (deni) given</td><td class="r num">${money(r.creditTotal)}</td></tr>
      ${r.collectedTotal?`<tr><td>Less: old credit paid back</td><td class="r num">− ${money(r.collectedTotal)}</td></tr>`:""}
      <tr><td><b>Difference</b></td><td class="r"><span class="pill ${diffCls(r.diff)}">${diffTxt(r.diff)}</span></td></tr>
    </tbody></table></div>
    ${(r.credits||[]).length?`<h3>Credit given</h3><div class="tbl"><table><tbody>${r.credits.map(c=>`<tr><td>${esc(c.name)}</td><td class="r num">${money(c.amount)}</td></tr>`).join("")}</tbody></table></div>`:""}
    ${(r.collected||[]).length?`<h3>Old credit paid back</h3><div class="tbl"><table><tbody>${r.collected.map(c=>`<tr><td>${esc(c.name)} <span class="muted small">${c.from?"from "+niceDate(c.from)+" · ":""}${esc(c.via)}</span></td><td class="r num">${money(c.amount)}</td></tr>`).join("")}</tbody></table></div>`:""}
    ${r.note?`<div class="banner">${esc(r.note)}</div>`:""}
    <h3>Items sold</h3><div class="tbl" style="max-height:260px;overflow:auto"><table><tbody>${(r.lines||[]).map(l=>`<tr><td>${esc(l.name)} <span class="muted small">${esc(l.size||"")}</span></td><td class="r num">${l.qty}</td><td class="r num">${money(l.amount)}</td></tr>`).join("")||'<tr><td class="muted">No sales</td></tr>'}</tbody></table></div>
    <div class="row between">${ADM()?`<button class="btn ghost${armed?" danger":""}" data-act="reopenSession" data-id="${x.id}">${armed?"Tap again to reopen":"Reopen counter"}</button>`:"<span></span>"}<button class="btn primary" data-act="pdfReport" data-id="${x.id}">Download PDF</button></div>
  </div>`);
}
function reopenSession(x){
  const local=[{k:"upd",t:"counter_sessions",id:x.id,patch:{status:"open",closed_at:null,closed_by:null,closed_by_id:null,total_sales:null,cash:null,paid_out:null,mobile:null,credit_total:null,collected_total:null,difference:null,report:null}}];
  Object.values(S.credits||{}).filter(c=>c.sessionId===x.id&&!num(c.paidAmount)).forEach(c=>local.push({k:"del",t:"credits",id:c.id}));
  enqueue({k:"rpc",fn:"reopen_session",args:{p_id:x.id},local});
  closeModal();toast(niceDate(x.date)+" reopened — close it again from the Sell screen");refreshSoon();
}

function vCountAll(){
  const sm=stockMap(),all=prodList(),cats=["All",...CATS.filter(c=>all.some(p=>p.cat===c))];
  const list=all.filter(p=>S.ccat==="All"||p.cat===S.ccat);
  const done=Object.keys(S.counts).filter(k=>S.counts[k]!=="").length;
  return `
  <div class="row between"><h2>Stock count</h2><div class="row"><button class="btn" data-act="cancelCount">Cancel</button><button class="btn primary" data-act="saveCounts" ${done?"":"disabled"}>Save ${done||""} count${done===1?"":"s"}</button></div></div>
  <div class="banner">Type the number of bottles you can see for each product. Leave a box empty to keep the current figure. Nothing is saved until you press <b>Save</b>.</div>
  <section class="panel">
    <div class="chips">${cats.map(c=>`<button class="chip" data-act="ccat" data-v="${esc(c)}" aria-pressed="${S.ccat===c}">${esc(c)}</button>`).join("")}</div>
    <div class="tbl"><table><thead><tr><th>Product</th><th class="r">Ledger says</th><th class="r">Counted</th></tr></thead><tbody>
    ${list.map(p=>`<tr><td><b>${esc(p.name)}</b> <span class="muted small">${esc(p.size||"")}</span></td><td class="r num muted">${sm[p.id]}</td><td class="r"><input type="text" inputmode="numeric" class="priceIn num" style="width:80px!important" id="cnt_${p.id}" data-cnt="${p.id}" value="${esc(S.counts[p.id]??"")}" aria-label="Count for ${esc(p.name)}"></td></tr>`).join("")}
    </tbody></table></div>
  </section>`;
}
function vStock(){
  if(S.countMode)return vCountAll();
  const sm=stockMap(),all=prodList(),oo=onOrderMap();
  const counts={Low:0,Out:0};let value=0;
  all.forEach(p=>{const q=sm[p.id],st=status(p,q)[1];if(st==="Low")counts.Low++;if(st==="Out")counts.Out++;value+=Math.max(0,q)*num(p.cost)});
  const q=(S.stq||"").trim().toLowerCase(),words=q.split(/\s+/).filter(Boolean);
  const hit=p=>{const h=(p.name+" "+(p.size||"")+" "+(p.cat||"")+" "+(p.supplier||"")).toLowerCase();return words.every(w=>h.includes(w))};
  const list=all.filter(p=>(S.stockFilter==="All"||status(p,sm[p.id])[1]===S.stockFilter)&&hit(p));
  const neverCounted=all.filter(p=>p.needsCount).length;
  return `
  <div class="row between"><h2>Stock</h2><div class="row"><span class="muted small">On hand at cost: <b class="num">${money(value)}</b></span>${!ADM()?"":`<button class="btn" data-act="countAll">Count all</button><button class="btn primary" data-act="startOrder">Order low stock${needsOrder().length?" ("+needsOrder().length+")":""}</button>`}</div></div>
  ${neverCounted?`<div class="banner">${neverCounted} product${neverCounted>1?"s":""} still need${neverCounted>1?"":"s"} a fresh count. Figures shown come from the paper stock take of 17 July, so they don't include anything sold since. Use <b>Count all</b> to enter what's on the shelf and in the store room — from then on, sales and restocks update the numbers automatically.</div>`:""}
  <section class="panel">
    <div class="searchwrap"><input type="search" id="stq" placeholder="Search stock… name, size, type or supplier" value="${esc(S.stq||"")}" autocomplete="off" aria-label="Search stock"></div>
    ${q?`<div class="muted small">${list.length} product${list.length===1?"":"s"} match “${esc(S.stq.trim())}”${S.stockFilter==="All"?"":" in "+S.stockFilter}</div>`:""}
    <div class="chips">${["All","Low","Out","OK"].map(c=>`<button class="chip" data-act="sf" data-v="${c}" aria-pressed="${S.stockFilter===c}">${c}${c==="Low"&&counts.Low?" ("+counts.Low+")":""}${c==="Out"&&counts.Out?" ("+counts.Out+")":""}</button>`).join("")}</div>
    ${list.length?`<div class="tbl"><table><thead><tr><th>Product</th><th class="r">On hand</th><th>Status</th><th class="r">Reorder at</th><th class="r">On order</th><th></th></tr></thead><tbody>
    ${list.map(p=>{const q=sm[p.id],[c,l]=status(p,q);return`<tr><td><b>${esc(p.name)}</b> <span class="muted small">${esc(p.size||"")}</span><div class="muted small">${p.countedAt&&!p.needsCount?"Counted "+niceDate(ymd(new Date(p.countedAt))):p.countSource?"From paper stock take, 17 Jul — please recount":"Not counted yet"}</div></td><td class="r num"><b>${q}</b></td><td><span class="pill ${c}">${l}</span></td><td class="r num muted">${num(p.reorder)}</td><td class="r num">${oo[p.id]||""}</td>
    <td class="r"><div class="row" style="justify-content:flex-end;flex-wrap:nowrap">${!ADM()?"":`<button class="btn small" data-act="restock" data-id="${p.id}">Restock</button><button class="btn ghost small" data-act="count" data-id="${p.id}">Count</button>`}</div></td></tr>`}).join("")}
    </tbody></table></div>`:(q?`<div class="empty">No products match “${esc(S.stq.trim())}”.</div>`:'<div class="empty">Nothing here.</div>')}
  </section>
  ${recentRestocks()}`;
}
function recentRestocks(){
  const t=today(),d=new Date();d.setDate(d.getDate()-30);
  const r=collect("restocks",ymd(d),t).slice(0,15);
  if(!r.length)return"";
  return `<section class="panel"><h3>Recent restocks · last 30 days</h3><div class="tbl"><table><thead><tr><th>Date</th><th>Product</th><th class="r">Qty</th><th class="r">Cost</th><th>Supplier</th></tr></thead><tbody>
  ${r.map(x=>`<tr><td class="num">${niceDate(x.date)}</td><td>${esc(x.name)}</td><td class="r num">${x.qty}</td><td class="r num">${money(x.qty*x.unitCost)}</td><td class="muted">${esc(x.supplier||"—")}${x.orderNo?` <span class="small">· ${esc(x.orderNo)}</span>`:""}</td></tr>`).join("")}</tbody></table></div></section>`;
}

function expRange(){
  const cur=ymd(new Date()).slice(0,7),m=S.expMonth&&S.expMonth<cur?S.expMonth:cur;
  const [y,mo]=m.split("-").map(Number),last=ymd(new Date(y,mo,0));
  const label=new Date(y,mo-1,1).toLocaleDateString("en-GB",{month:"long",year:"numeric"});
  return [m+"-01",m===cur?ymd(new Date()):last,label,m===cur];
}
function vExpenses(){
  const [from,to,label,isCur]=expRange();
  const ex=collect("expenses",from,to);
  const tot=ex.reduce((a,e)=>a+num(e.amount),0);
  const byCat={};ex.forEach(e=>byCat[e.cat]=(byCat[e.cat]||0)+num(e.amount));
  const cats=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  return `
  <div class="row between"><h2>Expenses</h2>${S.readOnly?"":'<button class="btn primary" data-act="addExp">Add expense</button>'}</div>
  <div class="row" style="gap:8px;align-items:center"><button class="btn ghost small" data-act="expMonth" data-v="-1" aria-label="Previous month">‹ Previous</button><b style="min-width:9em;text-align:center">${esc(label)}</b><button class="btn ghost small" data-act="expMonth" data-v="1" aria-label="Next month"${isCur?" disabled":""}>Next ›</button>${isCur?"":'<button class="btn ghost small" data-act="expMonth" data-v="0">This month</button>'}</div>
  <div class="two">
    <section class="panel">
      <div class="row between"><h3>${isCur?"This month":esc(label)}</h3><b class="num">${money(tot)}</b></div>
      ${cats.length?cats.map(([c,v])=>`<div style="display:grid;gap:4px"><div class="row between small"><span>${esc(c)}</span><span class="num">${money(v)}</span></div><div class="bar"><i style="width:${(v/cats[0][1]*100).toFixed(1)}%"></i></div></div>`).join(""):'<div class="empty">No expenses '+(isCur?"this month":"in "+esc(label))+'.</div>'}
      <p class="muted small" style="margin:0">Stock you buy is recorded under <b>Stock → Restock</b>, not here, so it isn't counted twice in profit.</p>
    </section>
    <section class="panel">
      <h3>Entries · ${isCur?"this month":esc(label)}</h3>
      ${ex.length?`<div class="tbl"><table><tbody>${ex.map(e=>`<tr><td class="num small">${niceDate(e.date)}</td><td>${esc(e.cat)}<div class="muted small">${esc(e.note||"")}</div></td><td class="r num">${money(e.amount)}</td><td class="r">${!ADM()?"":`<button class="btn ghost small${S.confirm==="e"+e.id?" danger":""}" data-act="delExp" data-id="${e.id}" data-doc="${e._doc}">${S.confirm==="e"+e.id?"Confirm":"Delete"}</button>`}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">Add rent, wages, LUKU, transport and other running costs as you pay them.</div>'}
    </section>
  </div>`;
}

function vSummary(){
  const [from,to,label]=periodRange(S.period);
  const sales=collect("sales",from,to),ex=collect("expenses",from,to),rs=collect("restocks",from,to);
  const rev=sales.reduce((a,s)=>a+saleTotal(s),0),cogs=sales.reduce((a,s)=>a+saleCost(s),0);
  const gross=rev-cogs,opex=ex.reduce((a,e)=>a+num(e.amount),0),net=gross-opex;
  const bought=rs.reduce((a,r)=>a+num(r.qty)*num(r.unitCost),0);
  const byPay={};sales.forEach(s=>{if(s.sessionId&&s.pay===AT_CLOSE){const x=(S.sessions||{})[s.sessionId];if(x&&x.status==="closed")return;byPay["Counter not closed yet"]=(byPay["Counter not closed yet"]||0)+saleTotal(s);return}byPay[s.pay]=(byPay[s.pay]||0)+saleTotal(s)});
  Object.values(S.sessions||{}).filter(x=>x.status==="closed"&&x.date>=from&&x.date<=to).forEach(x=>{const sp=sessPay(x);for(const k in sp)byPay[k]=(byPay[k]||0)+sp[k]});
  for(const k in byPay)if(byPay[k]<=0)delete byPay[k];
  const pays=Object.entries(byPay).sort((a,b)=>b[1]-a[1]);
  const prod={};sales.forEach(s=>s.items.forEach(i=>{const k=i.pid;prod[k]=prod[k]||{name:i.name,size:i.size,qty:0,rev:0,gp:0};prod[k].qty+=num(i.qty);prod[k].rev+=num(i.qty)*num(i.price);prod[k].gp+=num(i.qty)*(num(i.price)-num(i.cost))}));
  const top=Object.values(prod).sort((a,b)=>b.rev-a.rev).slice(0,8);
  const owing=collect("sales","0000-00-00","9999-99-99").filter(isOpenSale),oc=openCredits();
  const owed=owing.reduce((a,s)=>a+saleTotal(s),0)+oc.reduce((a,c)=>a+creditLeft(c),0);
  const pct=rev?Math.round(gross/rev*100):0;
  return `
  <div class="row between"><h2>Profit · ${label}</h2>
    <div class="chips">${[["today","Today"],["week","This week"],["month","This month"],["last","Last month"]].map(([k,l])=>`<button class="chip" data-act="period" data-v="${k}" aria-pressed="${S.period===k}">${l}</button>`).join("")}</div></div>
  <div class="kpis">
    <div class="kpi"><span class="l">Sales</span><span class="v num">${money(rev)}</span><span class="d">${sales.length} sales</span></div>
    <div class="kpi"><span class="l">Gross profit</span><span class="v num">${money(gross)}</span><span class="d">${pct}% margin on drinks</span></div>
    <div class="kpi"><span class="l">Running costs</span><span class="v num">${money(opex)}</span><span class="d">${ex.length} expenses</span></div>
    <div class="kpi hero"><span class="l">Net profit</span><span class="v num">${money(net)}</span><span class="d">Gross profit − running costs</span></div>
  </div>
  ${S.period!=="today"?`<section class="panel"><h3>Sales by day</h3>${chart(from,to,sales)}</section>`:""}
  <div class="two">
    <section class="panel"><h3>How customers paid</h3>
      ${pays.length?pays.map(([p,v])=>`<div style="display:grid;gap:4px"><div class="row between small"><span>${esc(p)}</span><span class="num">${money(v)} <span class="muted">· ${Math.round(v/rev*100)}%</span></span></div><div class="bar"><i style="width:${(v/pays[0][1]*100).toFixed(1)}%"></i></div></div>`).join(""):'<div class="empty">No sales in this period.</div>'}
      <div class="row between small" style="border-top:1px solid var(--line);padding-top:10px"><span>Spent on new stock</span><b class="num">${money(bought)}</b></div>
    </section>
    <section class="panel"><div class="row between"><h3>Unpaid credit (deni)</h3><b class="num">${money(owed)}</b></div>
      ${oc.length?`<div class="tbl"><table><tbody>${oc.map(c=>`<tr><td><b>${esc(c.name)}</b><div class="muted small">Since ${niceDate(c.date)}</div></td><td class="r num">${money(creditLeft(c))}</td><td></td></tr>`).join("")}</tbody></table></div><p class="muted small" style="margin:0">Collected when a seller closes the counter. Full list in <b>Reports</b>.</p>`:""}
      ${owing.length?`<div class="tbl"><table><tbody>${owing.map(s=>`<tr><td><b>${esc(s.customer||"Unnamed")}</b><div class="muted small">${niceDate(s.date)} · ${s.items.map(i=>esc(i.qty+"× "+i.name)).join(", ")}</div></td><td class="r num">${money(saleTotal(s))}</td><td class="r">${S.readOnly?"":`<button class="btn small" data-act="paid" data-id="${s.id}" data-doc="${s._doc}">Mark paid</button>`}</td></tr>`).join("")}</tbody></table></div>`:oc.length?"":'<div class="empty">Nobody owes the shop right now.</div>'}
    </section>
  </div>
  <section class="panel"><h3>Best sellers · ${label}</h3>
    ${top.length?`<div class="tbl"><table><thead><tr><th>Product</th><th class="r">Sold</th><th class="r">Sales</th><th class="r">Profit</th></tr></thead><tbody>${top.map(p=>`<tr><td>${esc(p.name)} <span class="muted small">${esc(p.size||"")}</span></td><td class="r num">${p.qty}</td><td class="r num">${money(p.rev)}</td><td class="r num">${money(p.gp)}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">Sales will show here once recorded.</div>'}
  </section>`;
}
function chart(from,to,sales){
  const days=[];const [y,m,d]=from.split("-").map(Number);const cur=new Date(y,m-1,d);
  while(ymd(cur)<=to&&days.length<40){days.push(ymd(cur));cur.setDate(cur.getDate()+1)}
  const v={};sales.forEach(s=>v[s.date]=(v[s.date]||0)+saleTotal(s));
  const vals=days.map(k=>v[k]||0),max=Math.max(...vals,1);
  const mag=Math.pow(10,Math.floor(Math.log10(max/4))),step=[1,2,2.5,5,10].map(x=>x*mag).find(s=>max/s<=4)||mag*10,top=Math.ceil(max/step)*step;
  const W=640,H=200,L=44,R=8,T=10,B=26,cw=(W-L-R)/days.length,bw=Math.max(4,cw*.64);
  let g="";for(let t=0;t<=top+1e-9;t+=step){const yy=T+(H-T-B)*(1-t/top);g+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/><text x="${L-6}" y="${yy+4}" text-anchor="end">${short(t)}</text>`}
  const every=days.length>14?Math.ceil(days.length/10):1;
  const bars=days.map((k,i)=>{const h=(H-T-B)*(vals[i]/top),x=L+i*cw+(cw-bw)/2;const isT=k===today();
    return `<rect x="${x.toFixed(1)}" y="${(H-B-h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0,h).toFixed(1)}" rx="3" fill="${isT?"var(--ink)":"var(--accent)"}"><title>${niceDate(k)}: ${money(vals[i])}</title></rect>`+(i%every===0?`<text x="${(L+i*cw+cw/2).toFixed(1)}" y="${H-8}" text-anchor="middle">${days.length>7?Number(k.slice(8)):niceDate(k).split(" ")[0]}</text>`:"")}).join("");
  return `<div class="tbl"><svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:420px;display:block" role="img" aria-label="Daily sales">${g}${bars}</svg></div>`;
}

/* ---------- History (Admin): DukaPro 2022–2026 + sales in this app ---------- */
const APP_START_TS=1790193856000; // 23 Sep 2026 20:04 — DukaPro stock count; app sales after this are "this app"
const dnum=s=>{const [y,m,d]=s.split("-").map(Number);return Date.UTC(y,m-1,d)/864e5};
const spanDays=(a,b)=>dnum(b)-dnum(a)+1;
const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monLabel=a=>MON[+a.slice(5,7)-1]+" "+a.slice(2,4);
const rangeLabel=(a,b)=>a===b?Number(a.slice(8))+" "+monLabel(a):(a.slice(0,7)===b.slice(0,7)?Number(a.slice(8))+"–"+Number(b.slice(8))+" "+monLabel(a):Number(a.slice(8))+" "+monLabel(a)+" – "+Number(b.slice(8))+" "+monLabel(b));
S.hist=null;S.histLoading=false;S.hy=null;
async function loadHistory(){
  if(S.histLoading||!S.client)return;S.histLoading=true;
  if(!S.hist){const c=await idb.get("hist");if(c&&c.sales){S.hist=c;render()}}
  try{
    const [sales,days]=await Promise.all([fetchAll("history_sales"),fetchAll("history_days")]);
    S.hist={sales:sales.map(r=>({...r,qty:num(r.qty),revenue:num(r.revenue),cost:num(r.cost)})),days:days.map(r=>({...r,revenue:num(r.revenue),cost:num(r.cost)})),at:Date.now()};
    idb.set("hist",S.hist);
  }catch(e){if(!S.hist)S.hist={sales:[],days:[],error:(e&&e.message)||String(e)}}
  S.histLoading=false;ensureFrom("2026-09-23");if(S.tab==="history")render();
}
function appSales(){return collect("sales","2026-09-23","9999-12-31").filter(s=>s.ts>APP_START_TS&&!isOpenSale(s))}
function histPeriods(){
  const H=S.hist,per={};
  for(const r of H.sales){const k=r.source==="dukapro"?"d"+r.d_from.slice(0,7):"r"+r.d_from;
    const p=per[k]=per[k]||{a:r.d_from,b:r.d_to,src:r.source,rev:0,cost:0};p.rev+=r.revenue;p.cost+=r.cost;if(r.d_from<p.a)p.a=r.d_from;if(r.d_to>p.b)p.b=r.d_to}
  for(const s of appSales()){const m=s.date.slice(0,7),k="a"+m;const p=per[k]=per[k]||{a:s.date,b:s.date,src:"app",rev:0,cost:0};p.rev+=saleTotal(s);p.cost+=saleCost(s);if(s.date<p.a)p.a=s.date;if(s.date>p.b)p.b=s.date}
  const recDays={};for(const d of H.days)recDays[d.date]=1;for(const s of appSales())recDays[s.date]=1;
  const list=Object.values(per).sort((x,y)=>x.a<y.a?-1:1);
  const t=today();list.forEach(p=>{if(p.src==="app"){const [y,m]=p.a.split("-").map(Number);const ms=p.a.slice(0,8)+"01";p.a=ms<"2026-09-23"?"2026-09-23":ms;const end=ymd(new Date(y,m,0));p.b=end<t?end:t}
    p.days=spanDays(p.a,p.b);p.perDay=p.rev/p.days;p.rec=Object.keys(recDays).filter(d=>d>=p.a&&d<=p.b).length});
  const out=[];list.forEach((p,i)=>{if(i){const prev=out[out.length-1];const gap=dnum(p.a)-dnum(prev.b)-1;if(gap>=5){out.push({gap:true,a:ymdU(dnum(prev.b)+1),b:ymdU(dnum(p.a)-1),days:gap})}}out.push(p)});
  return out;
}
const ymdU=n=>{const d=new Date(n*864e5);return d.getUTCFullYear()+"-"+pad(d.getUTCMonth()+1)+"-"+pad(d.getUTCDate())};
function histYears(){
  const y={};const add=(yr,rev,cost,est)=>{const o=y[yr]=y[yr]||{year:yr,rev:0,cost:0,est:false,days:0};o.rev+=rev;o.cost+=cost;if(est)o.est=true};
  for(const r of S.hist.sales)add(r.d_from.slice(0,4),r.revenue,r.cost,r.source!=="dukapro");
  for(const s of appSales())add(s.date.slice(0,4),saleTotal(s),saleCost(s),false);
  const rec={};for(const d of S.hist.days)rec[d.date]=1;for(const s of appSales())rec[s.date]=1;
  Object.keys(rec).forEach(d=>{const o=y[d.slice(0,4)];if(o)o.days++});
  return Object.values(y).sort((a,b)=>a.year<b.year?-1:1);
}
function histTop(yr){
  const m={};const add=(k,name,qty,rev,cost)=>{const o=m[k]=m[k]||{pid:k,name,qty:0,rev:0,gp:0};o.qty+=qty;o.rev+=rev;o.gp+=rev-cost};
  for(const r of S.hist.sales)if(r.d_from.slice(0,4)===yr)add(r.pid||r.name,(S.products[r.pid]?S.products[r.pid].name+" "+(S.products[r.pid].size||""):r.name).trim(),r.qty,r.revenue,r.cost);
  for(const s of appSales())if(s.date.slice(0,4)===yr)for(const i of s.items||[])add(i.pid,(i.name+" "+(i.size||"")).trim(),num(i.qty),num(i.qty)*num(i.price),num(i.qty)*num(i.cost));
  return Object.values(m).sort((a,b)=>b.rev-a.rev).slice(0,12);
}
function histChart(per){
  const vals=per.filter(p=>!p.gap).map(p=>p.perDay),max=Math.max(...vals,1);
  const mag=Math.pow(10,Math.floor(Math.log10(max/4))),step=[1,2,2.5,5,10].map(x=>x*mag).find(s=>max/s<=4)||mag*10,top=Math.ceil(max/step)*step;
  const W=760,H=230,L=44,R=8,T=12,B=30,cw=(W-L-R)/per.length,bw=Math.max(3,cw*.7);
  const col={dukapro:"var(--accent)",report:"var(--accent)",app:"var(--ink)"};
  let g="";for(let t=0;t<=top+1e-9;t+=step){const yy=T+(H-T-B)*(1-t/top);g+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="${L-6}" y="${yy+4}" text-anchor="end">${short(t)}</text>`}
  let lastY="";
  const bars=per.map((p,i)=>{const x=L+i*cw+(cw-bw)/2,cx=L+i*cw+cw/2;const y=p.a.slice(0,4);const lab=y!==lastY?`<text x="${cx.toFixed(1)}" y="${H-10}" text-anchor="middle">${y}</text>`:"";lastY=y;
    if(p.gap)return `<rect x="${x.toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H-T-B}" fill="var(--surface2)" opacity=".7"><title>${rangeLabel(p.a,p.b)}: no sales records (${p.days} days)</title></rect>`+lab;
    const h=(H-T-B)*(p.perDay/top);
    return `<rect x="${x.toFixed(1)}" y="${(H-B-h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1,h).toFixed(1)}" rx="2" fill="${col[p.src]}"${p.src==="report"?' opacity=".45"':""}><title>${rangeLabel(p.a,p.b)}: ${money(p.perDay)} a day · ${money(p.rev)} total${p.src==="report"?" (DukaPro report)":p.src==="app"?" (this app)":" · "+p.rec+" days with sales"}</title></rect>`+lab}).join("");
  return `<div class="tbl"><svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:560px;display:block;font-size:11px;fill:var(--muted)" role="img" aria-label="Average sales per day, 2022 to now">${g}${bars}</svg></div>
  <div class="row small muted" style="gap:14px;flex-wrap:wrap"><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--accent)"></i> DukaPro, every sale</span><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--accent);opacity:.45"></i> DukaPro report (2026)</span><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--ink)"></i> This app</span><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--surface2)"></i> No records</span></div>`;
}
async function importHistory(){
  if(!ADM()||S.histImporting)return;S.histImporting="Downloading…";render();
  try{
    const r=await fetch("data/dukapro-history.json",{cache:"no-store"});if(!r.ok)throw new Error("history file missing ("+r.status+")");const j=await r.json();
    const sales=j.sales.map(x=>({id:x[0],d_from:x[1],d_to:x[2],pid:x[3],name:x[4],cat:x[5],qty:x[6],revenue:x[7],cost:x[8],source:x[9]}));
    const days=j.days.map(x=>({date:x[0],revenue:x[1],cost:x[2],lines:x[3],receipts:x[4],cashier:x[5],source:x[6]}));
    for(const [t,rows,key] of [["history_sales",sales,"id"],["history_days",days,"date"]])for(let i=0;i<rows.length;i+=500){
      S.histImporting="Saving "+Math.min(100,Math.round((t==="history_days"?sales.length+i:i)/(sales.length+days.length)*100))+"%…";render();
      const {error}=await S.client.from(t).upsert(rows.slice(i,i+500),{onConflict:key});if(error)throw error}
    S.histImporting=null;S.hist=null;toast("DukaPro history loaded");loadHistory();
  }catch(e){S.histImporting=null;render();toast("Couldn't load history: "+((e&&e.message)||e))}
}
function vHistory(){
  if(!S.hist){loadHistory();return '<div class="empty">Loading history…</div>'}
  if(S.hist.error&&!S.hist.sales.length)return `<h2>History</h2><section class="panel"><div class="empty">History isn't set up yet. Run <b>supabase/5-dukapro-import.sql</b> in Supabase → SQL Editor, then open this tab again.<div class="small">${esc(S.hist.error)}</div></div></section>`;
  if(!S.hist.sales.length)return `<h2>History</h2><section class="panel"><h3>Bring in the DukaPro history</h3><p class="muted small" style="margin:0">One time only. Loads every DukaPro sale from June 2022 to September 2026 (about 3,000 monthly product totals and 870 daily totals). Needs internet; takes under a minute.</p><div><button class="btn primary" data-act="loadHist" ${S.histImporting?"disabled":""}>${S.histImporting?esc(S.histImporting):"Load DukaPro history"}</button></div></section>`;
  const per=histPeriods(),yrs=histYears(),real=per.filter(p=>!p.gap);
  const best=yrs.reduce((a,b)=>b.rev>a.rev?b:a,yrs[0]||{rev:0,year:"—"});
  const bestDay=best.rev/(best.year%4?365:366);
  const app=real.filter(p=>p.src==="app"),appDays=app.reduce((a,p)=>a+p.days,0);
  const now=appDays>=7?{v:app.reduce((a,p)=>a+p.rev,0)/appDays,l:"This app, since 23 Sep"}:(()=>{const p=[...real].reverse().find(x=>x.src!=="app");return{v:p?p.perDay:0,l:p?rangeLabel(p.a,p.b)+(p.src==="report"?" (DukaPro)":""):"—"}})();
  const exact=yrs.filter(y=>!y.est&&y.rev),lastExact=exact[exact.length-1];
  const mg=lastExact&&lastExact.rev?Math.round((lastExact.rev-lastExact.cost)/lastExact.rev*100):0;
  const yearsList=yrs.map(y=>y.year);if(!S.hy||!yearsList.includes(S.hy))S.hy=yearsList[yearsList.length-1];
  const top=histTop(S.hy),sm=stockMap();
  const thin=real.filter(p=>p.src==="dukapro"&&p.days>=20&&p.rec<15);
  const gaps=per.filter(p=>p.gap);
  const pctNow=bestDay?Math.round(now.v/bestDay*100):0;
  return `
  <div class="row between"><h2>History</h2><span class="muted small">DukaPro Jun 2022 – Sep 2026, then this app</span></div>
  <div class="kpis">
    <div class="kpi"><span class="l">Best year</span><span class="v num">${short(best.rev)}</span><span class="d">${best.year} · ${money(bestDay)} a day</span></div>
    <div class="kpi hero"><span class="l">Now, per day</span><span class="v num">${short(now.v)}</span><span class="d">${esc(now.l)} · ${pctNow}% of ${best.year}</span></div>
    <div class="kpi"><span class="l">Margin on drinks</span><span class="v num">${mg}%</span><span class="d">${lastExact?lastExact.year:""}, from every sale</span></div>
    <div class="kpi"><span class="l">Recorded since 2022</span><span class="v num">${short(yrs.reduce((a,y)=>a+y.rev,0))}</span><span class="d">all sales in the records</span></div>
  </div>
  <section class="panel"><h3>Average sales per day</h3><p class="muted small" style="margin:0">Each bar is a month (or a DukaPro report period in 2026), divided by the days in it, so short and long periods compare fairly. Hover a bar for the total.</p>${histChart(per)}</section>
  <section class="panel"><h3>By year</h3><div class="tbl"><table><thead><tr><th>Year</th><th class="r">Sales</th><th class="r">Gross profit</th><th class="r">Margin</th><th class="r">Days</th></tr></thead><tbody>
    ${yrs.map(y=>`<tr><td><b>${y.year}</b>${y.est?' <span class="pill n">part estimated</span>':""}</td><td class="r num" style="white-space:nowrap">${money(y.rev)}</td><td class="r num" style="white-space:nowrap">${money(y.rev-y.cost)}</td><td class="r num">${y.rev?Math.round((y.rev-y.cost)/y.rev*100):0}%</td><td class="r num">${y.est?"—":y.days}</td></tr>`).join("")}
  </tbody></table></div><p class="muted small" style="margin:0">2026 DukaPro reports have no buy prices, so their profit uses today's buy price.</p></section>
  <section class="panel"><h3>Gaps in the records</h3>
    ${gaps.length||thin.length?`<div class="tbl"><table><tbody>${gaps.map(g=>`<tr><td>${rangeLabel(g.a,g.b)}</td><td class="r"><span class="pill out">No sales recorded</span></td></tr>`).join("")}${thin.map(p=>`<tr><td>${MON[+p.a.slice(5,7)-1]} ${p.a.slice(0,4)}</td><td class="r"><span class="pill low">Sales on ${p.rec} of ${p.days} days</span></td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">No gaps.</div>'}
    <p class="muted small" style="margin:0">If the shop was open on these days, sales happened that were never entered. On 24 Jul 2026 DukaPro showed ${money(43661834)} of stock at cost; the count in August found ${money(13735375)}.</p></section>
  <section class="panel"><div class="row between"><h3>Best sellers · ${esc(S.hy)}</h3><div class="chips">${yearsList.map(y=>`<button class="chip" data-act="hy" data-v="${y}" aria-pressed="${S.hy===y}">${y}</button>`).join("")}</div></div>
    ${top.length?`<div class="tbl"><table><thead><tr><th>Product</th><th class="r">Sold</th><th class="r">Sales</th><th class="r">Gross profit</th><th class="r">In stock now</th></tr></thead><tbody>${top.map(p=>{const P=S.products[p.pid];const q=P?sm[P.id]:null;const st=P?status(P,q):null;return`<tr><td>${esc(p.name)}</td><td class="r num">${Math.round(p.qty)}</td><td class="r num">${money(p.rev)}</td><td class="r num">${money(p.gp)}</td><td class="r">${P?`<span class="pill ${st[0]}">${q}</span>`:'<span class="muted small">not sold now</span>'}</td></tr>`}).join("")}</tbody></table></div>`:'<div class="empty">No sales in this year.</div>'}
  </section>`;
}

function vProducts(){
  const every=prodList(),q=(S.pq||"").trim().toLowerCase(),words=q.split(/\s+/).filter(Boolean);
  const all=words.length?every.filter(p=>{const h=(p.name+" "+(p.size||"")+" "+p.cat+" "+(p.supplier||"")).toLowerCase();return words.every(w=>h.includes(w))}):every;
  return `
  <div class="row between"><h2>Products & prices</h2>${!ADM()?"":'<button class="btn primary" data-act="newProd">Add product</button>'}</div>
  <p class="muted small" style="margin:0">${every.length} products · margins under 10% are flagged red so you can check the price.</p>
  <section class="panel"><div class="searchwrap"><input type="search" id="pq" placeholder="Search products… name, size, type or supplier" value="${esc(S.pq||"")}" autocomplete="off" aria-label="Search products"></div>
  ${q?`<div class="muted small">${all.length} of ${every.length} products match “${esc(S.pq.trim())}”</div>`:""}
  ${all.length?`<div class="tbl"><table><thead><tr><th>Product</th><th>Type</th><th class="r">Buy</th><th class="r">Sell</th><th class="r">Margin</th><th></th></tr></thead><tbody>
  ${all.map(p=>{const mg=num(p.price)?Math.round((num(p.price)-num(p.cost))/num(p.price)*100):0;return`<tr><td><b>${esc(p.name)}</b> <span class="muted small">${esc(p.size||"")}</span></td><td class="muted">${esc(p.cat)}${p.supplier?`<div class="small">${esc(p.supplier)}</div>`:""}</td><td class="r num">${money(p.cost)}</td><td class="r num">${money(p.price)}</td><td class="r num"><span class="pill ${mg<10?"out":mg<18?"low":"ok"}">${mg}%</span></td><td class="r">${!ADM()?"":`<button class="btn ghost small" data-act="editProd" data-id="${p.id}">Edit</button>`}</td></tr>`}).join("")}
  </tbody></table></div>`:q?'<div class="empty">No product matches that search.</div>':'<div class="empty">No products yet. Add the drinks you sell.</div>'}</section>`;
}

/* ---------- sign-in: Admin & Seller (each person has their own username + password) ---------- */
const ADM=()=>S.role==="admin"&&!S.readOnly;
const canVoid=s=>!S.readOnly&&(ADM()||(s.byId&&s.byId===S.uid&&Date.now()-s.ts<10*6e4));
const TABS_SELLER=["sell","expenses","orders"];
const tabOk=t=>S.role==="admin"?true:TABS_SELLER.includes(t);
const access=()=>((S.settingsRows||{}).access||{}).value||{};
const STAFF_DOMAIN="staff.thecave.local";
S.signAs=ls("cave_signas")||"seller";
const toEmail=u=>{u=String(u||"").trim().toLowerCase();return u.includes("@")?u:u+"@"+STAFF_DOMAIN};
S.team=[];
function onAccess(){}
async function profileFor(client,userId){
  const {data,error}=await client.from("profiles").select("role,label,username,active").eq("user_id",userId).maybeSingle();
  if(error)throw error;return data;
}
function brand(){return`<h1 class="lockbrand">The <span>Cave</span> Ledger</h1>`}
function lockHtml(){
  const L=S.lock||{};
  if(!S.accessLoaded&&S.status==="loading")return`<div class="lockbox">${brand()}<p class="muted" style="text-align:center">Loading…</p></div>`;
  if(S.noaccess)return`<div class="lockbox">${brand()}<div class="panel"><h2>No access</h2><p class="muted" style="margin:0">${esc(S.noaccess)}</p><button class="btn" data-lock="signout">Sign out</button></div></div>`;
  return`<div class="lockbox">${brand()}
    ${L.msg?`<div class="banner">${esc(L.msg)}</div>`:""}
    <form class="panel" data-lockform="signin">
      <div class="seg" role="tablist" aria-label="Who is signing in">${[["seller","Seller"],["admin","Admin"]].map(([k,l])=>`<button type="button" role="tab" aria-selected="${(S.signAs||"seller")===k}" data-signas="${k}">${l}</button>`).join("")}</div>
      ${(S.signAs||"seller")==="seller"?`<h2>Seller sign in</h2>
      <p class="muted small" style="margin:0">Use the username and password the Admin gave you.</p>
      <label class="f">Username<input type="text" name="user" id="si_user" required autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(ls("cave_last_user")||"")}" placeholder="e.g. juma"></label>`:`<h2>Admin sign in</h2>
      <p class="muted small" style="margin:0">For the owner and managers. Use your Admin email.</p>
      <label class="f">Email<input type="email" name="user" id="si_user" required autocomplete="username" value="${esc(ls("cave_last_admin")||"")}" placeholder="you@example.com"></label>`}
      <label class="f">Password<input type="password" name="password" id="si_pw" required autocomplete="current-password"></label>
      <div class="lockmsg" role="alert">${esc(L.err||"")}</div>
      <button class="btn primary big"${L.busy?" disabled":""}>${L.busy?"Signing in…":"Sign in"}</button>
      <p class="muted small" style="margin:0">${S.online?"":"You're offline. Signing in needs internet — once signed in, sales keep working without it."}</p></form>
    ${CFG.url?"":`<div class="banner">This copy isn't connected to a database yet. Put the Supabase address and key in <b>config.js</b>.</div>`}
    <p class="muted small" style="text-align:center;margin:0">${niceDate(today())} · Sinza</p></div>`;
}
function renderLock(){
  const root=$("#lockRoot");if(!root)return;
  if(S.uid){root.innerHTML="";document.body.classList.remove("locked");return}
  document.body.classList.add("locked");
  const a=document.activeElement,keep=a&&a.id&&root.contains(a)?{id:a.id,v:a.value}:null;
  root.innerHTML='<div class="lock">'+lockHtml()+"</div>";
  if(keep){const el=document.getElementById(keep.id);if(el){el.value=keep.v;el.focus()}}
  else{const f=$((S.signAs==="admin"?ls("cave_last_admin"):ls("cave_last_user"))?"#si_pw":"#si_user");if(f)f.focus()}
}
document.addEventListener("click",e=>{
  const root=$("#lockRoot");if(!root||!root.contains(e.target))return;
  const g=e.target.closest("[data-signas]");if(g){S.signAs=g.dataset.signas;ls("cave_signas",S.signAs);S.lock={};renderLock();const f=$(((S.signAs==="admin"?ls("cave_last_admin"):ls("cave_last_user")))?"#si_pw":"#si_user");f&&f.focus();return}
  const l=e.target.closest("[data-lock]");if(l&&l.dataset.lock==="signout")signOutNow();
});
document.addEventListener("submit",async e=>{
  const f=e.target.closest("form[data-lockform]");if(!f)return;e.preventDefault();e.stopImmediatePropagation();
  const v=Object.fromEntries(new FormData(f).entries());
  if(!S.client){S.lock={err:"Not connected to a database — check config.js"};return renderLock()}
  S.lock={busy:true};renderLock();
  const {data,error}=await S.client.auth.signInWithPassword({email:toEmail(v.user),password:v.password});
  if(error){S.lock={err:isNetErr(error)?"No internet — connect and try again":"Wrong username or password"};return renderLock()}
  let p=null;try{p=await profileFor(S.client,data.user.id)}catch(_){}
  if(!p||p.active===false){try{await S.client.auth.signOut({scope:"local"})}catch(_){}S.lock={err:p?"This login has been turned off. Ask the Admin.":"This login hasn't been given access yet. Ask the Admin."};return renderLock()}
  if(S.signAs==="admin")ls("cave_last_admin",String(v.user).trim());else ls("cave_last_user",String(v.user).trim());
  startSession(data.user.id,p);
  toast((p.role==="admin"?"Admin · ":"")+"Karibu, "+(p.label||"")+"!");
},true);
function startSession(userId,p){
  S.uid=userId;S.role=p.role==="admin"?"admin":"seller";S.name=p.label||p.username||"";S.lock={};S.noaccess=null;
  ls("cave_profile",JSON.stringify({uid:userId,role:S.role,label:S.name}));
  if(!tabOk(S.tab))S.tab="sell";S.lastAct=Date.now();
  renderLock();render();
  loadAll().then(()=>{startRealtime();flushSoon();if(S.role==="admin")loadTeam()});
}
async function signOutNow(msg){
  if(S.queue.length&&!S.online)toast(S.queue.length+" changes stay saved on this computer and upload when it's back online");
  try{await S.client.auth.signOut({scope:"local"})}catch(_){}
  try{localStorage.removeItem("cave_profile")}catch(_){}
  S.uid=null;S.role=null;S.name="";S.cart=[];S.customer="";S.team=[];closeModal();
  if(S.channel){try{S.client.removeChannel(S.channel)}catch(_){}S.channel=null}
  S.lock={msg:msg||""};renderLock();render();
}
/* sellers are signed out after a quiet spell on the counter (only while online, so nobody is stranded offline) */
["pointerdown","keydown","touchstart"].forEach(ev=>document.addEventListener(ev,()=>{S.lastAct=Date.now()},{passive:true}));
setInterval(()=>{if(!S.uid||S.role!=="seller"||!S.online)return;const m=num(access().autoLockMin??15);if(!m)return;if(Date.now()-(S.lastAct||Date.now())>m*6e4)signOutNow("Signed out after "+m+" minutes without use.")},20000);

/* Team tab (Admin): create and manage logins through the secure manage-staff function */
async function staffApi(body){
  const {data,error}=await S.client.functions.invoke("manage-staff",{body});
  if(error){let m=error.message;try{const j=await error.context.json();if(j&&j.error)m=j.error}catch(_){}
    if(/Failed to send|fetch/i.test(m))m=S.online?"The login service isn't set up yet (manage-staff function)":"Managing logins needs internet";throw new Error(m)}
  if(data&&data.error)throw new Error(data.error);return data;
}
async function loadTeam(){
  if(!S.client||S.role!=="admin")return;
  const [pr,inf]=await Promise.all([S.client.from("profiles").select("*").order("created_at"),S.client.from("staff_info").select("*")]);
  if(!pr.error){const info={};(inf.data||[]).forEach(r=>info[r.user_id]=r);S.team=(pr.data||[]).map(u=>({...u,phone:(info[u.user_id]||{}).phone||"",notes:(info[u.user_id]||{}).notes||"",started_on:(info[u.user_id]||{}).started_on||""}));if(S.tab==="team")render()}
  staffApi({action:"list"}).then(r=>{if(r&&r.users){S.lastSeen={};r.users.forEach(u=>S.lastSeen[u.id]=u.last_sign_in_at);if(S.tab==="team")render()}}).catch(()=>{});
}
function personStats(uid){
  const [mf]=periodRange("month"),t=today();
  const all=collect("sales",mf,t).filter(s=>s.byId===uid),td=all.filter(s=>s.date===t);
  const voids=collect("sales",mf,t,true).filter(s=>s.byId===uid&&s.voidedAt).length;
  return{month:all.reduce((a,s)=>a+saleTotal(s),0),monthN:all.length,today:td.reduce((a,s)=>a+saleTotal(s),0),todayN:td.length,voids,last:all.length?Math.max(...all.map(s=>s.ts)):0};
}
const ago=iso=>{if(!iso)return"Never";const d=new Date(iso),m=Math.round((Date.now()-d)/6e4);if(m<2)return"Just now";if(m<60)return m+" min ago";if(m<1440)return Math.round(m/60)+" h ago";return niceDate(ymd(d))};
function vTeam(){
  const us=S.team,a=access(),q=(S.teamQ||"").toLowerCase();
  const list=us.filter(u=>!q||((u.label||"")+" "+(u.username||"")+" "+(u.phone||"")).toLowerCase().includes(q)).sort((x,y)=>(x.active===false)-(y.active===false)||(x.role===y.role?0:x.role==="admin"?-1:1)||(x.label||"").localeCompare(y.label||""));
  const sellers=us.filter(u=>u.role==="seller"&&u.active!==false).length;
  return `<div class="row between"><h2>Team & logins</h2>${S.readOnly?"":'<button class="btn primary" data-act="addUser">Add seller</button>'}</div>
  <section class="panel">
    <div class="row between"><h3>${sellers} active seller${sellers===1?"":"s"} · ${us.filter(u=>u.role==="admin"&&u.active!==false).length} admin</h3><input type="search" id="teamq" placeholder="Search name, username or phone…" value="${esc(S.teamQ||"")}" style="max-width:280px"></div>
    ${list.length?`<div class="tbl"><table><thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Access</th><th class="r">Sales this month</th><th>Last signed in</th><th></th></tr></thead><tbody>
    ${list.map(u=>{const off=u.active===false,me=u.user_id===S.uid,st=personStats(u.user_id);return`<tr class="click${off?" voided":""}" data-act="openUser" data-id="${u.user_id}">
      <td><b>${esc(u.label||"—")}</b>${me?' <span class="muted small">(you)</span>':""}${off?' <span class="pill out">Turned off</span>':""}</td>
      <td class="num">${esc(u.username||"(email login)")}</td><td class="num">${esc(u.phone||"—")}</td>
      <td><span class="pill ${u.role==="admin"?"ok":"n"}">${u.role==="admin"?"Admin":"Seller"}</span></td>
      <td class="r num">${money(st.month)} <span class="muted small">· ${st.monthN}</span></td>
      <td class="muted small">${S.lastSeen?ago(S.lastSeen[u.user_id]):"…"}</td>
      <td class="r"><button class="btn ghost small" data-act="openUser" data-id="${u.user_id}">Manage</button></td></tr>`}).join("")}
    </tbody></table></div>`:`<div class="empty">${us.length?"No one matches.":"Loading…"}</div>`}
  </section>
  <div class="two">
  <section class="panel"><h3>What each login can do</h3>
    <div class="tbl"><table><thead><tr><th></th><th>Seller</th><th>Admin</th></tr></thead><tbody>
    ${[["Record sales, mark credit paid","✓","✓"],["See today's sales & end-of-day close","✓","✓"],["See older sales, export","—","✓"],["Void a sale","Own sales, within 10 min","Any"],["Edit a sale","—","✓"],["See stock levels","✓","✓"],["Restock, stock counts","—","✓"],["Receive a delivery","✓ (prices locked)","✓"],["Create, send, cancel orders","—","✓"],["Add expenses","✓","✓"],["Delete expenses","—","✓"],["Profit, products & prices","—","✓"],["Manage sellers & passwords","—","✓"]].map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted small" style="margin:0">These limits are enforced by the database, not just hidden on screen.</p>
  </section>
  <section class="panel"><h3>Shared counter computer</h3>
    <label class="f">Sign sellers out after no use for<select id="autolock" ${S.readOnly?"disabled":""}>${[[5,"5 minutes"],[10,"10 minutes"],[15,"15 minutes"],[30,"30 minutes"],[60,"1 hour"],[0,"Never"]].map(([m,l])=>`<option value="${m}"${num(a.autoLockMin??15)===m?" selected":""}>${l}</option>`).join("")}</select></label>
    <p class="muted small" style="margin:0">Sellers sign in on the <b>Seller</b> tab of the sign-in screen with their username, and tap <b>Sign out</b> at the end of their shift. Your own Admin password is changed in Supabase (Authentication → Users).</p>
  </section></div>`;
}
function personForm(u){
  const n=!u;u=u||{role:"seller"};
  openModal(`<form data-form="person" data-id="${n?"":u.user_id}" style="display:grid;gap:12px"><h2>${n?"Add seller":"Edit details · "+esc(u.label||"")}</h2>
  <label class="f">Full name<input type="text" name="name" id="p_name" required value="${esc(u.label||"")}" placeholder="e.g. Juma Hassan"></label>
  <div class="grid2"><label class="f">Username (used to sign in)<input type="text" name="username" id="p_username" ${u.username||n?"required":""} pattern="[A-Za-z0-9._-]{2,30}" value="${esc(u.username||"")}" placeholder="${u.username||n?"e.g. juma":"signs in with email"}" autocapitalize="none" spellcheck="false" ${!n&&!u.username?"disabled":""}></label>
  <label class="f">Access<select name="role" id="p_role" ${u.user_id===S.uid?"disabled":""}><option value="seller"${u.role!=="admin"?" selected":""}>Seller</option><option value="admin"${u.role==="admin"?" selected":""}>Admin — full control</option></select></label></div>
  <div class="grid2"><label class="f">Phone<input type="tel" name="phone" id="p_phone" value="${esc(u.phone||"")}" placeholder="e.g. 0712 345 678"></label>
  <label class="f">Started on<input type="date" name="started_on" id="p_start" value="${esc(u.started_on||(n?today():""))}"></label></div>
  <label class="f">Notes (only Admins see this)<input type="text" name="notes" id="p_notes" value="${esc(u.notes||"")}" placeholder="e.g. weekend shifts, next of kin…"></label>
  ${n?`<div class="grid2"><label class="f">Password (8+ characters)<input type="text" name="pw" id="p_pw" minlength="8" required autocomplete="off" spellcheck="false"></label><label class="f">Repeat password<input type="text" name="pw2" id="p_pw2" minlength="8" required autocomplete="off" spellcheck="false"></label></div>
  <p class="muted small" style="margin:0">Give the username and password to the person privately.</p>`:""}
  <div class="lockmsg" id="p_err" role="alert"></div>
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" id="p_save">${n?"Create login":"Save details"}</button></div></form>`);
}
function passwordForm(u){
  openModal(`<form data-form="pw" data-id="${u.user_id}" style="display:grid;gap:12px"><h2>New password · ${esc(u.label||"")}</h2>
  <div class="grid2"><label class="f">New password (8+ characters)<input type="text" name="pw" id="w_pw" minlength="8" required autocomplete="off" spellcheck="false"></label><label class="f">Repeat password<input type="text" name="pw2" id="w_pw2" minlength="8" required autocomplete="off" spellcheck="false"></label></div>
  <p class="muted small" style="margin:0">They'll need the new password next time they sign in. Anyone signed in as them now stays signed in until they sign out.</p>
  <div class="lockmsg" id="w_err" role="alert"></div>
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" id="w_save">Save password</button></div></form>`);
}
function personPanel(u){
  const st=personStats(u.user_id),off=u.active===false,me=u.user_id===S.uid;
  const recent=collect("sales","0000-00-00","9999-99-99",true).filter(s=>s.byId===u.user_id).slice(0,8);
  openModal(`<div style="display:grid;gap:12px">
    <div class="row between"><div><h2>${esc(u.label||"—")}</h2><div class="muted small">${u.username?"Username: <b>"+esc(u.username)+"</b>":"Signs in with email"} · ${u.role==="admin"?"Admin":"Seller"}${off?" · <span style='color:var(--bad)'>Turned off</span>":""}</div></div><button class="btn ghost" data-act="close" aria-label="Close">✕</button></div>
    <div class="tbl"><table><tbody>
      <tr><td class="muted">Phone</td><td>${esc(u.phone||"—")}</td></tr>
      <tr><td class="muted">Started on</td><td>${u.started_on?niceDate(u.started_on):"—"}</td></tr>
      <tr><td class="muted">Last signed in</td><td>${S.lastSeen?ago(S.lastSeen[u.user_id]):"—"}</td></tr>
      <tr><td class="muted">Notes</td><td>${esc(u.notes||"—")}</td></tr>
      <tr><td class="muted">Sales today</td><td class="num">${money(st.today)} · ${st.todayN} sales</td></tr>
      <tr><td class="muted">Sales this month</td><td class="num">${money(st.month)} · ${st.monthN} sales${st.voids?` · <span style="color:var(--bad)">${st.voids} voided</span>`:""}</td></tr>
    </tbody></table></div>
    ${recent.length?`<h3>Latest sales</h3><div class="tbl"><table><tbody>${recent.map(s=>`<tr${s.voidedAt?' class="voided"':""}><td class="num small">${niceDate(s.date)} ${time(s.ts)}</td><td class="small">${s.items.map(i=>esc(i.qty+"× "+i.name)).join(", ")}</td><td class="r num small">${s.voidedAt?"<s>"+money(saleTotal(s))+"</s>":money(saleTotal(s))}</td></tr>`).join("")}</tbody></table></div>`:""}
    ${S.readOnly?"":`<div class="row" style="justify-content:flex-end;flex-wrap:wrap">
      ${me?"":`<button class="btn ghost${S.confirm==="del"+u.user_id?" danger":""}" data-act="delUser" data-id="${u.user_id}">${S.confirm==="del"+u.user_id?"Tap again to delete login":"Delete login"}</button>`}
      ${me?"":`<button class="btn" data-act="toggleUser" data-id="${u.user_id}">${off?"Turn on":"Turn off"}</button>`}
      ${me||!u.username?"":`<button class="btn" data-act="pwUser" data-id="${u.user_id}">New password</button>`}
      <button class="btn primary" data-act="editUser" data-id="${u.user_id}">Edit details</button></div>`}
    ${me?'<p class="muted small" style="margin:0">You can edit your own details here. Your password and access are changed in Supabase.</p>':""}
  </div>`);
}
function saveAccessSetting(patch){const v={...access(),...patch};enqueue({k:"ups",t:"settings",row:{key:"access",value:v}})}

/* ---------- sales history ---------- */
const MOBILE=["M-Pesa","Mixx by Yas","Airtel Money","HaloPesa"];
function salesRange(){
  const n=new Date(),t=ymd(n);
  if(S.sr==="yesterday"){const d=new Date(n);d.setDate(d.getDate()-1);const y=ymd(d);return[y,y,"Yesterday"]}
  if(S.sr==="custom"){const a=S.sfrom||t,b=S.sto||t;return a<=b?[a,b,a===b?niceDate(a):niceDate(a)+" – "+niceDate(b)]:[b,a,niceDate(b)+" – "+niceDate(a)]}
  return periodRange(S.sr);
}
function filteredSales(){
  const [from,to,label]=salesRange();if(S.loadedFrom&&from<S.loadedFrom)ensureFrom(from);const q=S.sq.trim().toLowerCase();
  const all=collect("sales",from,to,true).filter(s=>(S.spay==="All"||(S.spay==="Mobile money"?MOBILE.includes(s.pay):S.spay==="Open"?isOpenSale(s):s.pay===S.spay))&&(S.sby==="All"||(s.by||"")===S.sby)&&(!q||(s.items.map(i=>i.name).join(" ")+" "+(s.customer||"")).toLowerCase().includes(q)));
  return{from,to,label,all,live:all.filter(s=>!s.voidedAt)};
}
const bottles=list=>list.reduce((a,s)=>a+s.items.reduce((b,i)=>b+num(i.qty),0),0);
function vSales(){
  if(!ADM()){S.sr="today";S.sby="All"}
  const {from,to,label,all,live}=filteredSales();
  const rev=live.reduce((a,s)=>a+saleTotal(s),0),gp=rev-live.reduce((a,s)=>a+saleCost(s),0),voided=all.filter(s=>s.voidedAt);
  const staff=[...new Set(collect("sales","0000-00-00","9999-99-99",true).map(s=>s.by||"").filter(Boolean))].sort();
  const multi=from!==to;
  const shown=(S.showVoid?all:live);
  const byDay={};shown.forEach(s=>(byDay[s.date]=byDay[s.date]||[]).push(s));
  const days=Object.keys(byDay).sort().reverse();
  let count=0;
  return `
  <div class="row between"><h2>Sales · ${esc(label)}</h2>${ADM()?`<button class="btn" data-act="exportSales" ${all.length?"":"disabled"}>Export to Excel (CSV)</button>`:""}</div>
  <section class="panel">
    ${!ADM()?'<p class="muted small" style="margin:0">Sellers see today\'s sales. Ask the Admin for older days.</p>':""}<div class="chips"${ADM()?"":" hidden"}>${[["today","Today"],["yesterday","Yesterday"],["week","This week"],["month","This month"],["last","Last month"],["custom","Pick dates"]].map(([k,l])=>`<button class="chip" data-act="sr" data-v="${k}" aria-pressed="${S.sr===k}">${l}</button>`).join("")}</div>
    ${S.sr==="custom"?`<div class="grid2"><label class="f">From<input type="date" id="sfrom" value="${S.sfrom||today()}" max="${today()}"></label><label class="f">To<input type="date" id="sto" value="${S.sto||today()}" max="${today()}"></label></div>`:""}
    <div class="grid3">
      <label class="f">Paid by<select id="spay">${opt(["All","Mobile money",...PAYS],S.spay)}</select></label>
      <label class="f">Recorded by<select id="sby">${opt(["All",...staff],S.sby)}</select></label>
      <label class="f">Search<input type="search" id="sq" value="${esc(S.sq)}" placeholder="Drink or customer…" autocomplete="off"></label>
    </div>
  </section>
  <div class="kpis">
    <div class="kpi hero"><span class="l">Sales</span><span class="v num">${money(rev)}</span><span class="d">${live.length} sale${live.length===1?"":"s"}</span></div>
    <div class="kpi"><span class="l">Bottles sold</span><span class="v num">${bottles(live)}</span><span class="d">${live.length?"avg sale "+money(rev/live.length):"—"}</span></div>
    <div class="kpi"><span class="l">Gross profit</span><span class="v num">${money(gp)}</span><span class="d">${rev?Math.round(gp/rev*100)+"% margin":"—"}</span></div>
    <div class="kpi"><span class="l">Voided</span><span class="v num">${voided.length}</span><span class="d">${voided.length?money(voided.reduce((a,s)=>a+saleTotal(s),0))+" removed":"none"}</span></div>
  </div>
  ${multi?vDailyClose(from,to,live):vDayClose(from,live)}
  <section class="panel">
    <div class="row between"><h3>Every sale</h3>${voided.length?`<label class="row small"><input type="checkbox" id="showVoid" ${S.showVoid?"checked":""}> Show voided sales</label>`:""}</div>
    ${days.length?days.map(d=>{const list=byDay[d],tot=list.filter(s=>!s.voidedAt).reduce((a,s)=>a+saleTotal(s),0);if(count>400)return"";return`
      <div class="dayhead row between"><b>${niceDate(d)}</b><span class="num">${money(tot)} <span class="muted small">· ${list.filter(s=>!s.voidedAt).length} sales</span></span></div>
      <div class="tbl"><table><tbody>${list.map(s=>{count++;const v=!!s.voidedAt;return`<tr${v?' class="voided"':""}>
        <td class="num" style="width:56px">${time(s.ts)}</td>
        <td>${s.items.map(i=>esc(i.qty+"× "+i.name+(i.size?" "+i.size:""))).join(", ")}${s.editedAt?` <span class="pill n">edited</span>`:""}${v?`<div class="small" style="color:var(--bad)">Voided${s.voidedBy?" by "+esc(s.voidedBy):""}${s.voidReason?" — "+esc(s.voidReason):""}</div>`:""}</td>
        <td>${isOpenSale(s)?'<span class="pill low">Open</span>':esc(s.pay)}${s.label?`<div class="muted small">${esc(s.label)}</div>`:""}</td>
        <td class="muted">${esc(s.by||"—")}</td>
        <td class="r num">${v?`<s>${money(saleTotal(s))}</s>`:money(saleTotal(s))}</td>
        <td class="r" style="white-space:nowrap">${!ADM()?(!v&&canVoid(s)?`<button class="btn ghost small" data-act="voidSale" data-id="${s.id}" data-doc="${s._doc}">Void</button>`:""):v?`<button class="btn ghost small" data-act="unvoid" data-id="${s.id}" data-doc="${s._doc}">Restore</button>`:`<button class="btn ghost small" data-act="editSale" data-id="${s.id}" data-doc="${s._doc}">Edit</button><button class="btn ghost small" data-act="voidSale" data-id="${s.id}" data-doc="${s._doc}">Void</button>`}</td></tr>`}).join("")}</tbody></table></div>`}).join("")+(count>400?'<p class="muted small">Showing the first 400 sales. Narrow the dates or export to see them all.</p>':""):'<div class="empty">No sales match.</div>'}
  </section>`;
}
function payBreak(list){const r={Cash:0,Mobile:0,Card:0,Credit:0};list.forEach(s=>{const t=saleTotal(s);if(isOpenSale(s))r.Credit+=t;else if(s.pay==="Cash")r.Cash+=t;else if(MOBILE.includes(s.pay))r.Mobile+=t;else if(s.pay==="Card")r.Card+=t;else r.Credit+=0});return r}
function creditRepaid(from,to){return collect("sales","0000-00-00","9999-99-99").filter(s=>s.pay==="Credit"&&s.paidAt&&ymd(new Date(s.paidAt))>=from&&ymd(new Date(s.paidAt))<=to)}
function vDailyClose(from,to,live){
  const byDay={};live.forEach(s=>(byDay[s.date]=byDay[s.date]||[]).push(s));
  const days=Object.keys(byDay).sort().reverse();if(!days.length)return"";
  const tot=payBreak(live);
  return `<section class="panel"><h3>Day by day</h3><div class="tbl"><table><thead><tr><th>Day</th><th class="r">Sales</th><th class="r">Cash</th><th class="r">Mobile money</th><th class="r">Card</th><th class="r">Still open</th><th class="r">Total</th></tr></thead><tbody>
  ${days.map(d=>{const b=payBreak(byDay[d]);return`<tr class="click" data-act="pickDay" data-v="${d}"><td><b>${niceDate(d)}</b></td><td class="r num">${byDay[d].length}</td><td class="r num">${money(b.Cash)}</td><td class="r num">${money(b.Mobile)}</td><td class="r num">${money(b.Card)}</td><td class="r num">${money(b.Credit)}</td><td class="r num"><b>${money(byDay[d].reduce((a,s)=>a+saleTotal(s),0))}</b></td></tr>`}).join("")}
  <tr><td><b>Total</b></td><td class="r num"><b>${live.length}</b></td><td class="r num"><b>${money(tot.Cash)}</b></td><td class="r num"><b>${money(tot.Mobile)}</b></td><td class="r num"><b>${money(tot.Card)}</b></td><td class="r num"><b>${money(tot.Credit)}</b></td><td class="r num"><b>${money(live.reduce((a,s)=>a+saleTotal(s),0))}</b></td></tr>
  </tbody></table></div><p class="muted small" style="margin:0">Tap a day to see its end-of-day close.</p></section>`;
}
function vDayClose(day,live){
  const coll=collect("sales","0000-00-00","9999-99-99").filter(s=>!isOpenSale(s)&&paidDay(s)===day);
  const methods={};coll.forEach(s=>methods[s.pay]=(methods[s.pay]||0)+saleTotal(s));
  const earlier=coll.filter(s=>s.date<day),earlierTot=earlier.reduce((a,s)=>a+saleTotal(s),0);
  const openNow=live.filter(isOpenSale),openTot=openNow.reduce((a,s)=>a+saleTotal(s),0);
  const cashIn=methods.Cash||0;
  const exCash=(collect("expenses",day,day)).reduce((a,e)=>a+num(e.amount),0);
  const staff={};live.forEach(s=>{const k=s.by||"Not named";staff[k]=staff[k]||{n:0,t:0};staff[k].n++;staff[k].t+=saleTotal(s)});
  const b={Cash:cashIn},repCash=0,repOther=0;
  return `<div class="two">
    <section class="panel"><h3>End-of-day close · ${niceDate(day)}</h3>
      <div class="tbl"><table><tbody>
      <tr><td colspan="2" class="muted small" style="font-weight:700">MONEY TAKEN IN ON THIS DAY</td></tr>
      ${Object.entries(methods).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<tr><td>${esc(k)}</td><td class="r num">${money(v)}</td></tr>`).join("")||'<tr><td class="muted">Nothing paid</td><td></td></tr>'}
      ${earlierTot?`<tr><td class="muted small">…including tabs from earlier days paid today</td><td class="r num muted small">${money(earlierTot)}</td></tr>`:""}
      ${openTot?`<tr><td>Still open (not paid yet) · ${openNow.length} tab${openNow.length===1?"":"s"}</td><td class="r num" style="color:var(--warn)">${money(openTot)}</td></tr>`:""}
      ${exCash?`<tr><td>Expenses recorded today</td><td class="r num">− ${money(exCash)}</td></tr>`:""}
      <tr><td><b>Cash that should be in the drawer</b><div class="muted small">Cash taken in${exCash?" − expenses":""}</div></td><td class="r num"><b>${money(cashIn-exCash)}</b></td></tr>
      </tbody></table></div>
      ${exCash?'<p class="muted small" style="margin:0">Assumes today\'s expenses were paid from the till. Add them back if they were paid another way.</p>':""}
    </section>
    <section class="panel"><h3>By staff</h3>
      ${Object.keys(staff).length?`<div class="tbl"><table><tbody>${Object.entries(staff).sort((a,b)=>b[1].t-a[1].t).map(([k,v])=>`<tr><td>${esc(k)}</td><td class="r num muted">${v.n} sales</td><td class="r num">${money(v.t)}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">No sales.</div>'}
    </section></div>`;
}
function editSaleForm(s,doc){
  openModal(`<form data-form="editSale" data-id="${s.id}" data-doc="${doc}" style="display:grid;gap:12px"><h2>Edit sale · ${time(s.ts)}</h2>
  <p class="muted small" style="margin:0">${niceDate(s.date)}${s.by?" · recorded by "+esc(s.by):""}. Stock and profit update when you save.</p>
  <div class="tbl"><table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price each</th><th class="r">Remove</th></tr></thead><tbody>
  ${s.items.map((i,ix)=>`<tr><td>${esc(i.name)} <span class="muted small">${esc(i.size||"")}</span></td><td class="r"><input type="text" inputmode="numeric" class="priceIn num" style="width:56px!important" name="q${ix}" id="eq${ix}" value="${i.qty}"></td><td class="r"><input type="text" inputmode="numeric" class="priceIn num" style="width:96px!important" name="p${ix}" id="ep${ix}" value="${i.price}"></td><td class="r"><input type="checkbox" name="x${ix}" id="ex${ix}" aria-label="Remove ${esc(i.name)}"></td></tr>`).join("")}
  </tbody></table></div>
  <div class="grid2"><label class="f">Paid by<select name="pay" id="e_pay">${opt(isOpenSale(s)?[s.pay]:METHODS.includes(s.pay)?METHODS:[s.pay,...METHODS],s.pay)}</select></label><label class="f">Customer (for credit)<input type="text" name="customer" id="e_cust" value="${esc(s.customer||"")}"></label></div>
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Save changes</button></div></form>`);
}
function voidForm(s,doc){
  openModal(`<form data-form="voidSale" data-id="${s.id}" data-doc="${doc}" style="display:grid;gap:12px"><h2>Void this sale?</h2>
  <p class="muted small" style="margin:0">${time(s.ts)} · ${s.items.map(i=>esc(i.qty+"× "+i.name)).join(", ")} · <b>${money(saleTotal(s))}</b>. The bottles go back into stock. The sale stays in the history, crossed out, so you can see what was removed and by whom.</p>
  <label class="f">Reason<select name="reason" id="v_reason">${opt(["Entered by mistake","Recorded twice","Customer returned it","Wrong drink","Other"],"Entered by mistake")}</select></label>
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Keep sale</button><button class="btn primary" style="background:var(--bad);border-color:var(--bad)">Void sale</button></div></form>`);
}
async function exportSales(){
  const {from,to,all}=filteredSales();
  const q=v=>{v=String(v??"");return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
  const rows=[["Date","Time","Sale ID","Item","Size","Qty","Unit price","Line total","Unit cost","Line profit","Paid by","Customer","Credit paid","Recorded by","Status","Void reason"]];
  all.slice().sort((a,b)=>a.ts-b.ts).forEach(s=>s.items.forEach(i=>rows.push([s.date,time(s.ts),s.id,i.name,i.size||"",i.qty,i.price,num(i.qty)*num(i.price),i.cost,num(i.qty)*(num(i.price)-num(i.cost)),s.pay,s.customer||"",s.paidAt?ymd(new Date(s.paidAt))+" "+(s.paidVia||""):"",s.by||"",s.voidedAt?"Voided":s.editedAt?"Edited":"OK",s.voidReason||""])));
  const csv="﻿"+rows.map(r=>r.map(q).join(",")).join("\r\n");
  saveFile("The Cave sales "+from+(from!==to?" to "+to:"")+".csv",new Blob([csv],{type:"text/csv"}));toast("Sales exported — opens in Excel")
}

/* ---------- orders ---------- */
const supOf=p=>((p&&p.supplier)||"").trim();
function soldSince(days){const m={},d=new Date();d.setDate(d.getDate()-days);for(const s of collect("sales",ymd(d),today()))for(const i of s.items||[])m[i.pid]=(m[i.pid]||0)+num(i.qty);return m}
function suggestQty(p,q,sold30){const target=Math.max(num(p.reorder)*2,Math.ceil((sold30||0)/30*14),1);return Math.max(1,target-Math.max(0,q))}
function needsOrder(){const sm=stockMap(),oo=onOrderMap();return prodList().filter(p=>{const q=sm[p.id];return q<=num(p.reorder)&&q+(oo[p.id]||0)<=num(p.reorder)})}
function draftItem(p,q,oo,sold){return{on:true,qty:Math.max(1,suggestQty(p,q,sold)-(oo||0)),cost:num(p.cost)}}
function startOrder(){
  const sm=stockMap(),oo=onOrderMap(),s30=soldSince(30);S.draft={};S.gsup={};
  needsOrder().forEach(p=>S.draft[p.id]=draftItem(p,sm[p.id],oo[p.id],s30[p.id]));
  S.ordMode="build";S.oq="";S.tab="orders";ls("cave_tab","orders");
}
const ordTotal=o=>(o.items||[]).reduce((a,i)=>a+num(i.qty)*num(i.unitCost),0);
const OPEN=["draft","sent","partial"];
const isOpen=o=>OPEN.includes(o.status);
function gotMap(o){const m={};for(const d of o.deliveries||[])for(const i of d.items||[])m[i.pid]=(m[i.pid]||0)+num(i.qty);return m}
const dueQty=(o,i,g)=>Math.max(0,num(i.qty)-((g||gotMap(o))[i.pid]||0));
function onOrderMap(){const m={};for(const o of Object.values(S.orders))if(isOpen(o)){const g=gotMap(o);for(const i of o.items||[])m[i.pid]=(m[i.pid]||0)+dueQty(o,i,g)}return m}
const ordStatus={draft:["n","Draft — not sent"],sent:["low","Waiting for delivery"],partial:["low","Part delivered"],received:["ok","Complete"],cancelled:["out","Cancelled"]};
const isOverdue=o=>(o.status==="sent"||o.status==="partial")&&o.expectedDate&&o.expectedDate<today();
const fmtD=ts=>niceDate(ymd(new Date(ts)));
function nextLpo(){let n=0;for(const o of Object.values(S.orders)){const m=/(\d+)$/.exec(o.no||"");if(m)n=Math.max(n,+m[1])}return"LPO-"+String(n+1).padStart(4,"0")}

function vOrders(){
  if(S.ordMode==="build")return vOrderBuild();
  const need=needsOrder().length,f=S.ordFilter,all=Object.values(S.orders);
  const open=all.filter(isOpen),waiting=all.filter(o=>o.status==="sent"||o.status==="partial"),late=all.filter(isOverdue),drafts=all.filter(o=>o.status==="draft");
  const dueVal=open.reduce((a,o)=>{const g=gotMap(o);return a+o.items.reduce((s,i)=>s+dueQty(o,i,g)*num(i.unitCost),0)},0);
  const list=all.filter(o=>f==="All"||(f==="Open"?isOpen(o):f==="Complete"?o.status==="received":o.status===f.toLowerCase())).sort((a,b)=>(isOverdue(b)-isOverdue(a))||(b.createdAt-a.createdAt));
  return `
  <div class="row between"><h2>Orders</h2>${!ADM()?"":`<div class="row"><button class="btn" data-act="blankOrder">New order</button><button class="btn primary" data-act="startOrder">Order low stock${need?" ("+need+")":""}</button></div>`}</div>
  <div class="kpis">
    <div class="kpi"><span class="l">Not sent yet</span><span class="v num">${drafts.length}</span><span class="d">draft orders</span></div>
    <div class="kpi"><span class="l">Waiting for delivery</span><span class="v num">${waiting.length}</span><span class="d">sent to suppliers</span></div>
    <div class="kpi"${late.length?' style="border-color:var(--bad)"':""}><span class="l">Late</span><span class="v num"${late.length?' style="color:var(--bad)"':""}>${late.length}</span><span class="d">past expected date</span></div>
    <div class="kpi"><span class="l">Still to arrive</span><span class="v num">${money(dueVal)}</span><span class="d">at order prices</span></div>
  </div>
  ${need&&!open.length?`<div class="banner"><b>${need}</b> product${need>1?"s are":" is"} out or running low with nothing on order. <b>Order low stock</b> builds the orders for you, grouped by supplier.</div>`:""}
  <div class="chips">${["Open","Complete","Cancelled","All"].map(c=>`<button class="chip" data-act="of" data-v="${c}" aria-pressed="${f===c}">${c}${c==="Open"&&open.length?" ("+open.length+")":""}</button>`).join("")}</div>
  ${list.length?list.map(vOrderCard).join(""):`<section class="panel"><div class="empty">${f==="Open"?"No open orders.":"Nothing here yet."}</div></section>`}`;
}
function steps(o){
  const g=gotMap(o),tot=o.items.reduce((a,i)=>a+num(i.qty),0),got=o.items.reduce((a,i)=>a+Math.min(num(i.qty),g[i.pid]||0),0);
  const st=[
    ["Created",fmtD(o.createdAt),true],
    ["Sent",o.sentAt?fmtD(o.sentAt):"—",!!o.sentAt],
    ["Expected",o.expectedDate?niceDate(o.expectedDate):"—",!!o.expectedDate],
    [o.status==="received"?"Complete":"Delivered",tot?got+" of "+tot+" bottles":"—",o.status==="received"]];
  if(o.status==="cancelled")st[3]=["Cancelled",o.cancelledAt?fmtD(o.cancelledAt):"",true];
  return `<div class="steps">${st.map(([l,d,on],ix)=>`<div class="step${on?" on":""}${ix===2&&isOverdue(o)?" late":""}"><i></i><b>${l}</b><span>${d}</span></div>`).join("")}</div>
  ${tot&&(o.status==="partial"||o.status==="received")?`<div class="bar" title="${got} of ${tot} received"><i style="width:${(got/tot*100).toFixed(1)}%"></i></div>`:""}`;
}
function vOrderCard(o){
  const [c,l]=ordStatus[o.status]||["n",o.status],open=isOpen(o),g=gotMap(o),dl=o.deliveries||[],late=isOverdue(o);
  const days=late?Math.round((new Date(today())-new Date(o.expectedDate))/864e5):0;
  return `<section class="panel"${late?' style="border-color:var(--bad)"':""}>
    <div class="row between"><div><div class="muted small num">${esc(o.no||"")}</div><h2 style="font-size:20px">${esc(o.supplier||"No supplier")}</h2>${o.by?`<div class="muted small">By ${esc(o.by)}</div>`:""}</div>
      <div class="row">${late?`<span class="pill out">${days} day${days===1?"":"s"} late</span>`:""}<span class="pill ${c}">${l}</span></div></div>
    ${steps(o)}
    <div class="tbl"><table><thead><tr><th>Product</th><th class="r">Ordered</th>${dl.length?'<th class="r">Received</th><th class="r">Still due</th>':""}<th class="r">Each</th><th class="r">Total</th></tr></thead><tbody>
    ${o.items.map(i=>{const r=g[i.pid]||0,due=dueQty(o,i,g);return`<tr><td>${esc(i.name)} <span class="muted small">${esc(i.size||"")}</span></td><td class="r num">${i.qty}</td>${dl.length?`<td class="r num">${r}</td><td class="r num">${due?`<b>${due}</b>`:'<span class="pill ok">✓</span>'}</td>`:""}<td class="r num">${money(i.unitCost)}</td><td class="r num">${money(i.qty*i.unitCost)}</td></tr>`}).join("")}
    <tr><td colspan="${dl.length?5:3}"><b>${o.items.length} item${o.items.length===1?"":"s"}</b></td><td class="r num"><b>${money(ordTotal(o))}</b></td></tr></tbody></table></div>
    ${dl.length?`<div style="display:grid;gap:4px"><h3>Deliveries</h3>${dl.map(d=>{const n=d.items.reduce((a,i)=>a+num(i.qty),0),v=d.items.reduce((a,i)=>a+num(i.qty)*num(i.unitCost),0);return`<div class="row between small"><span>${fmtD(d.ts)} · ${n} bottles${d.by?" · received by "+esc(d.by):""}${d.note?" · "+esc(d.note):""}</span><span class="num">${money(v)}</span></div>`}).join("")}</div>`:""}
    ${o.closeNote?`<p class="muted small" style="margin:0">Closed early: ${esc(o.closeNote)}</p>`:""}
    <div class="row" style="justify-content:flex-end">
      ${open&&ADM()?(dl.length?`<button class="btn ghost${S.confirm==="x"+o.id?" danger":""}" data-act="closeOrder" data-id="${o.id}">${S.confirm==="x"+o.id?"Confirm — rest isn't coming":"Close order"}</button>`:`<button class="btn ghost${S.confirm==="c"+o.id?" danger":""}" data-act="cancelOrder" data-id="${o.id}">${S.confirm==="c"+o.id?"Confirm cancel":"Cancel order"}</button>`):""}
      <button class="btn" data-act="pdfOrder" data-id="${o.id}">Download LPO (PDF)</button>
      ${open?`<button class="btn" data-act="copyOrder" data-id="${o.id}">Copy for WhatsApp</button>`:""}
      ${open&&ADM()?(o.status==="draft"?`<button class="btn" data-act="sentOrder" data-id="${o.id}">Mark as sent</button>`:`<button class="btn ghost" data-act="sentOrder" data-id="${o.id}">Change date</button>`):""}${open&&!S.readOnly?`<button class="btn primary" data-act="receiveOrder" data-id="${o.id}">Receive delivery</button>`:""}
    </div>
  </section>`;
}
function sentForm(o){
  const d=new Date();d.setDate(d.getDate()+2);
  openModal(`<form data-form="sent" data-id="${o.id}" style="display:grid;gap:12px"><h2>${o.status==="draft"?"Order sent to "+esc(o.supplier):"Change delivery date"}</h2>
  <p class="muted small" style="margin:0">When did ${esc(o.supplier)} promise to deliver? The order is flagged as late if nothing arrives by then.</p>
  <label class="f">Expected delivery<input type="date" name="exp" id="s_exp" value="${o.expectedDate||ymd(d)}" min="${ymd(new Date(o.createdAt))}" required></label>
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">${o.status==="draft"?"Mark as sent":"Save date"}</button></div></form>`);
}
function orderText(o){
  const g=gotMap(o),lines=o.items.filter(i=>dueQty(o,i,g)>0).map(i=>"• "+dueQty(o,i,g)+" × "+i.name+(i.size?" "+i.size:""));
  return "Habari "+(o.supplier||"")+",\nOrder "+(o.no||"")+" from The Cave Liquor House, Sinza — "+niceDate(today())+":\n\n"+lines.join("\n")+"\n\nTotal at our last prices: "+money(o.items.reduce((a,i)=>a+dueQty(o,i,g)*num(i.unitCost),0))+(o.expectedDate?"\nDelivery needed by: "+niceDate(o.expectedDate):"")+"\nTafadhali confirm availability and delivery time. Asante!"+(S.name?"\n— "+S.name:"");
}
function receiveForm(o){
  const g=gotMap(o),rows=o.items.map((i,ix)=>({i,ix,due:dueQty(o,i,g)})).filter(r=>r.due>0);
  openModal(`<form data-form="receive" data-id="${o.id}" style="display:grid;gap:12px"><h2>Receive from ${esc(o.supplier||"supplier")}</h2>
  <p class="muted small" style="margin:0">Count what actually came off the truck. Lower a number if fewer arrived — the rest stays on the order as <b>still due</b>. Everything received goes straight into stock.</p>
  <div class="tbl"><table><thead><tr><th>Product</th><th class="r">Arrived</th><th class="r">Cost each</th></tr></thead><tbody>
  ${rows.map(({i,ix,due})=>`<tr><td>${esc(i.name)} <span class="muted small">${esc(i.size||"")}</span><div class="muted small">Due ${due}${g[i.pid]?" · "+g[i.pid]+" already in":""}</div></td><td class="r"><input type="text" inputmode="numeric" class="priceIn num" style="width:64px!important" name="q${ix}" id="rq${ix}" value="${due}"></td><td class="r"><input type="text" inputmode="numeric" class="priceIn num" style="width:96px!important" name="c${ix}" id="rc${ix}" value="${i.unitCost}" ${ADM()?"":"readonly"}></td></tr>`).join("")}
  </tbody></table></div>
  <label class="f">Delivery note / invoice no. (optional)<input type="text" name="note" id="rv_note" placeholder="e.g. DN 4471"></label>
  ${ADM()?'<label class="row small"><input type="checkbox" name="upd" id="rv_upd" checked> Save changed prices as the new buying price</label>':""}
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Add to stock</button></div></form>`);
}
/* PDF purchase order */
async function pdfOrder(o){
  if(!window.jspdf){toast("PDF tool is still loading — try again in a moment");return}
  const {jsPDF}=window.jspdf,doc=new jsPDF({unit:"mm",format:"a4"}),W=210,L=16,R=W-16;
  const g=gotMap(o),dl=(o.deliveries||[]).length>0,mny=n=>Math.round(n||0).toLocaleString("en-US");
  let y=18;
  doc.setFont("helvetica","bold");doc.setFontSize(18);doc.text("THE CAVE LIQUOR HOUSE",L,y);
  doc.setFont("helvetica","normal");doc.setFontSize(10);doc.text("Sinza, Dar es Salaam, Tanzania",L,y+6);doc.text("Instagram: @thecave_liquorhouse",L,y+11);
  doc.setFont("helvetica","bold");doc.setFontSize(13);doc.text("LOCAL PURCHASE ORDER",R,y,{align:"right"});
  doc.setFont("helvetica","normal");doc.setFontSize(10);doc.text(o.no||"",R,y+6,{align:"right"});
  y+=20;doc.setDrawColor(40);doc.setLineWidth(.5);doc.line(L,y,R,y);y+=8;
  const meta=[["Supplier",o.supplier||""],["Order date",fmtD(o.createdAt)],["Delivery by",o.expectedDate?niceDate(o.expectedDate):"As soon as possible"],["Status",(ordStatus[o.status]||["",o.status])[1]],["Prepared by",o.by||""]];
  meta.forEach(([k,v],ix)=>{const x=ix%2?W/2+4:L,yy=y+Math.floor(ix/2)*7;doc.setFont("helvetica","bold");doc.text(k+":",x,yy);doc.setFont("helvetica","normal");doc.text(String(v),x+28,yy)});
  y+=Math.ceil(meta.length/2)*7+6;
  const cols=dl?[["#",L,"l"],["Item",L+8,"l"],["Ordered",120,"r"],["Received",140,"r"],["Unit (TSh)",165,"r"],["Amount (TSh)",R,"r"]]:[["#",L,"l"],["Item",L+8,"l"],["Qty",128,"r"],["Unit price (TSh)",160,"r"],["Amount (TSh)",R,"r"]];
  const head=()=>{doc.setFillColor(235,230,222);doc.rect(L,y-5,R-L,8,"F");doc.setFont("helvetica","bold");doc.setFontSize(9);cols.forEach(([t,x,a])=>doc.text(t,x,y,{align:a==="r"?"right":"left"}));y+=8;doc.setFont("helvetica","normal");doc.setFontSize(10)};
  head();
  o.items.forEach((i,ix)=>{
    if(y>265){doc.addPage();y=20;head()}
    const name=(i.name+(i.size?" "+i.size:"")).slice(0,60);
    const vals=dl?[String(ix+1),name,String(i.qty),String(g[i.pid]||0),mny(i.unitCost),mny(i.qty*i.unitCost)]:[String(ix+1),name,String(i.qty),mny(i.unitCost),mny(i.qty*i.unitCost)];
    vals.forEach((t,c)=>doc.text(t,cols[c][1],y,{align:cols[c][2]==="r"?"right":"left"}));
    doc.setDrawColor(210);doc.setLineWidth(.2);doc.line(L,y+2.5,R,y+2.5);y+=7.5;
  });
  y+=2;doc.setFont("helvetica","bold");doc.setFontSize(11);doc.text("TOTAL  TSh "+mny(ordTotal(o)),R,y,{align:"right"});
  if(dl){y+=6;doc.setFont("helvetica","normal");doc.setFontSize(9);const rv=o.items.reduce((a,i)=>a+Math.min(num(i.qty),g[i.pid]||0)*num(i.unitCost),0);doc.text("Received so far: TSh "+mny(rv)+"   |   Deliveries: "+o.deliveries.map(d=>fmtD(d.ts)+(d.note?" ("+d.note+")":"")).join(", "),R,y,{align:"right",maxWidth:R-L})}
  y=Math.max(y+22,230);if(y>270){doc.addPage();y=40}
  doc.setFont("helvetica","normal");doc.setFontSize(10);doc.setDrawColor(40);doc.setLineWidth(.3);
  [["Authorised by (The Cave)",L],["Received by (supplier)",W/2+4]].forEach(([t,x])=>{doc.line(x,y,x+78,y);doc.text(t,x,y+5);doc.text("Name, signature & date",x,y+10)});
  doc.setFontSize(8);doc.setTextColor(120);doc.text("Please quote "+(o.no||"this order number")+" on your delivery note and invoice. Generated "+niceDate(today())+" with The Cave Ledger.",L,287);
  const blob=doc.output("blob");
  const fn=(o.no||"LPO")+" "+(o.supplier||"").replace(/[^A-Za-z0-9 ]/g,"")+".pdf";
  const url=URL.createObjectURL(blob),w=window.open(url,"_blank");
  if(!w)saveFile(fn,blob);else toast("LPO opened — use Print in the new tab");
  setTimeout(()=>URL.revokeObjectURL(url),120000);
}

function vOrderBuild(){
  const sm=stockMap(),oo=onOrderMap(),s30=soldSince(30);
  const groups={};Object.keys(S.draft).forEach(pid=>{const p=S.products[pid];if(!p)return;const k=supOf(p)||"~";(groups[k]=groups[k]||[]).push(p)});
  const keys=Object.keys(groups).sort((a,b)=>a==="~"?1:b==="~"?-1:a.localeCompare(b));
  const q=S.oq.trim().toLowerCase();
  const hits=q?prodList().filter(p=>!S.draft[p.id]&&(p.name+" "+(p.size||"")+" "+supOf(p)).toLowerCase().includes(q)).slice(0,8):[];
  return `
  <div class="row between"><h2>New orders</h2><button class="btn" data-act="cancelBuild">Back to orders</button></div>
  <div class="banner">Quantities are suggested to bring each product up to about two weeks of sales, or twice its warning level. Change anything, untick what you don't want, then create one order per supplier.</div>
  <section class="panel">
    <label class="f">Add another product<input type="search" id="oq" value="${esc(S.oq)}" placeholder="Search by name or supplier…" autocomplete="off"></label>
    ${hits.length?`<div class="tbl"><table><tbody>${hits.map(p=>`<tr><td>${esc(p.name)} <span class="muted small">${esc(p.size||"")}</span><div class="muted small">${esc(supOf(p)||"No supplier set")} · ${sm[p.id]} on hand</div></td><td class="r"><button class="btn small" data-act="addDraft" data-id="${p.id}">Add</button></td></tr>`).join("")}</tbody></table></div>`:q?'<div class="muted small">No other matches.</div>':""}
  </section>
  ${keys.length?keys.map(k=>{
    const ps=groups[k].sort((a,b)=>a.name.localeCompare(b.name));
    const tot=ps.reduce((a,p)=>{const d=S.draft[p.id];return a+(d.on?num(d.qty)*num(d.cost):0)},0);
    const n=ps.filter(p=>S.draft[p.id].on&&num(S.draft[p.id].qty)>0).length;
    const gk=k==="~"?"none":k.replace(/[^A-Za-z0-9]/g,"_");
    const supVal=S.gsup[gk]??(k==="~"?"":k);
    return `<section class="panel">
      <div class="row between"><label class="f" style="flex:1;min-width:200px">Order from<input type="text" id="gs_${gk}" data-gsup="${gk}" value="${esc(supVal)}" placeholder="Supplier name"></label>
        <div style="text-align:right"><div class="muted small">${n} item${n===1?"":"s"}</div><b class="num">${money(tot)}</b></div></div>
      ${k==="~"?'<p class="muted small" style="margin:0">These products have no supplier saved. Type who you buy them from — it will be remembered for next time.</p>':""}
      <div class="tbl"><table><thead><tr><th></th><th>Product</th><th class="r">On hand</th><th class="r">Sold 30d</th><th class="r">Order qty</th><th class="r">Cost each</th><th class="r">Line</th></tr></thead><tbody>
      ${ps.map(p=>{const d=S.draft[p.id],[c,l]=status(p,sm[p.id]);return`<tr${d.on?"":' style="opacity:.5"'}><td><input type="checkbox" id="don_${p.id}" data-don="${p.id}" ${d.on?"checked":""} aria-label="Include ${esc(p.name)}"></td>
        <td><b>${esc(p.name)}</b> <span class="muted small">${esc(p.size||"")}</span><div><span class="pill ${c}">${l}</span>${oo[p.id]?` <span class="pill n">${oo[p.id]} on order</span>`:""}</div></td>
        <td class="r num">${sm[p.id]}</td><td class="r num muted">${s30[p.id]||0}</td>
        <td class="r"><input type="text" inputmode="numeric" class="priceIn num" style="width:70px!important" id="dq_${p.id}" data-dq="${p.id}" value="${d.qty}"></td>
        <td class="r"><input type="text" inputmode="numeric" class="priceIn num" style="width:100px!important" id="dc_${p.id}" data-dc="${p.id}" value="${d.cost}"></td>
        <td class="r num">${money(num(d.qty)*num(d.cost))}</td></tr>`}).join("")}
      </tbody></table></div>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" data-act="createOrder" data-g="${esc(k)}" data-gk="${gk}" ${n?"":"disabled"}>Create order${supVal?" for "+esc(supVal):""}</button></div>
    </section>`}).join(""):`<section class="panel"><div class="empty">Nothing is low right now. Search above to order any product.</div></section>`}`;
}
function supDatalist(){const set=new Set(Object.values(S.products).map(supOf).filter(Boolean));Object.values(S.orders).forEach(o=>o.supplier&&set.add(o.supplier));return '<datalist id="supList">'+[...set].sort().map(x=>'<option value="'+esc(x)+'">').join('')+'</datalist>'}
function copyFallback(text){openModal(`<h2>Order message</h2><p class="muted small" style="margin:0">Copy this and paste it into WhatsApp or SMS.</p><textarea id="ordtxt" rows="12" style="width:100%;font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)">${esc(text)}</textarea><div class="row" style="justify-content:flex-end"><button class="btn" data-act="close">Done</button></div>`);const t=$("#ordtxt");if(t){t.focus();t.select()}}

/* ---------- forms ---------- */
function productForm(p){
  const n=!p;p=p||{name:"",cat:"Beer",size:"",cost:"",price:"",reorder:6,open:0};
  openModal(`<form data-form="prod" data-id="${n?"":p.id}" style="display:grid;gap:12px">
  <h2>${n?"Add product":"Edit product"}</h2>
  <label class="f">Name<input type="text" name="name" id="f_name" required value="${esc(p.name)}" placeholder="e.g. Serengeti Lager"></label>
  <div class="grid2"><label class="f">Type<select name="cat" id="f_cat">${opt(CATS,p.cat)}</select></label><label class="f">Size<input type="text" name="size" id="f_size" value="${esc(p.size||"")}" placeholder="500ml / 750ml"></label></div>
  <div class="grid2"><label class="f">Buying price (TSh)<input type="text" inputmode="numeric" name="cost" id="f_cost" required value="${esc(p.cost)}"></label><label class="f">Selling price (TSh)<input type="text" inputmode="numeric" name="price" id="f_price" required value="${esc(p.price)}"></label></div>
  <div class="grid2"><label class="f">Warn when stock falls to<input type="text" inputmode="numeric" name="reorder" id="f_reorder" value="${esc(p.reorder)}"></label><label class="f">Supplier<input type="text" name="supplier" id="f_sup" list="supList" value="${esc(p.supplier||"")}" placeholder="e.g. Mohans"></label></div>
  <div class="grid2">${n?`<label class="f">Bottles on hand now<input type="text" inputmode="numeric" name="open" id="f_open" value="0"></label>`:"<span></span>"}</div>
  <div class="row between">${n?"<span></span>":`<button type="button" class="btn danger" data-act="archiveProd" data-id="${p.id}">Remove product</button>`}<div class="row"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Save</button></div></div>${supDatalist()}</form>`);
}
function restockForm(p){
  openModal(`<form data-form="restock" data-id="${p.id}" style="display:grid;gap:12px"><h2>Restock ${esc(p.name)}</h2><p class="muted small" style="margin:0">${esc(p.size||"")} · currently buying at ${money(p.cost)} each</p>
  <div class="grid2"><label class="f">Bottles received<input type="text" inputmode="numeric" name="qty" id="r_qty" required></label><label class="f">Cost per bottle (TSh)<input type="text" inputmode="numeric" name="unitCost" id="r_cost" value="${esc(p.cost)}" required></label></div>
  <label class="f">Supplier (optional)<input type="text" name="supplier" id="r_sup" list="supList" value="${esc(p.supplier||"")}" placeholder="e.g. Mohans, Kawe, TBL"></label>
  <label class="row small"><input type="checkbox" name="upd" id="r_upd" checked> Use this as the new buying price</label>
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Add to stock</button></div>${supDatalist()}</form>`);
}
function countForm(p,q){
  openModal(`<form data-form="count" data-id="${p.id}" style="display:grid;gap:12px"><h2>Count ${esc(p.name)}</h2><p class="muted small" style="margin:0">The ledger thinks you have <b>${q}</b>. Count the bottles on the shelf and in the store room.</p>
  <label class="f">Bottles counted<input type="text" inputmode="numeric" name="n" id="c_n" required></label>
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Save count</button></div></form>`);
}
function expenseForm(){
  openModal(`<form data-form="exp" style="display:grid;gap:12px"><h2>Add expense</h2>
  <div class="grid2"><label class="f">Date<input type="date" name="date" id="x_date" value="${today()}" max="${today()}" required></label><label class="f">Type<select name="cat" id="x_cat">${opt(EXP,"Rent")}</select></label></div>
  <label class="f">Amount (TSh)<input type="text" inputmode="numeric" name="amount" id="x_amt" required></label>
  <label class="f">Note (optional)<input type="text" name="note" id="x_note" placeholder="e.g. September rent"></label>
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Save expense</button></div></form>`);
}
function nameForm(){
  openModal(`<form data-form="name" style="display:grid;gap:12px"><h2>Who's recording?</h2><p class="muted small" style="margin:0">Saved on this phone only. Each sale shows who recorded it.</p>
  <label class="f">Your name<input type="text" name="name" id="n_name" value="${esc(S.name)}" required></label>
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
function paidForm(id,doc){
  openModal(`<form data-form="paid" data-id="${id}" data-doc="${doc}" style="display:grid;gap:12px"><h2>Credit paid</h2>
  <label class="f">Paid with<select name="via" id="p_via">${opt(METHODS,"Cash")}</select></label>
  <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Mark paid</button></div></form>`);
}

/* ---------- events ---------- */
let confirmT;
function armConfirm(key){S.confirm=key;clearTimeout(confirmT);confirmT=setTimeout(()=>{S.confirm=null;render()},4000);render()}
document.addEventListener("click",e=>{
  const tab=e.target.closest("#tabs button");if(tab){S.tab=tab.dataset.tab;ls("cave_tab",S.tab);S.confirm=null;render();window.scrollTo(0,0);return}
  const b=e.target.closest("[data-act]");if(!b)return;
  const a=b.dataset.act;
  if(a==="closeBack"){if(e.target===b)closeModal();return}
  if(b.tagName==="SELECT"||b.tagName==="INPUT")return;
  const P=S.products[b.dataset.id];
  if(S.tab==="sell"&&!b.closest("#modalRoot .modal form")&&sellAct(a,b))return;
  if(a==="closeTab"&&sellAct(a,b))return;
  switch(a){
    case"close":closeModal();break;
    case"pdfReport":{const x=(S.sessions||{})[b.dataset.id];if(x)pdfReport(x);break}
    case"openReport":{const x=(S.sessions||{})[b.dataset.id];if(x){S.confirm=null;reportModal(x)}break}
    case"adminClose":closeModal();startClose(b.dataset.id);render();break;
    case"reopenSession":{const x=(S.sessions||{})[b.dataset.id];if(!x)break;const k="reopen"+x.id;if(S.confirm!==k){S.confirm=k;reportModal(x);setTimeout(()=>{if(S.confirm===k){S.confirm=null}},4000);break}S.confirm=null;reopenSession(x);break}
    case"cat":S.cat=b.dataset.v;render();break;
    case"sf":S.stockFilter=b.dataset.v;render();break;
    case"period":S.period=b.dataset.v;render();break;
    case"hy":S.hy=b.dataset.v;render();break;
    case"loadHist":importHistory();break;
    case"setName":nameForm();break;
    case"add":{if(!P)break;const ex=S.cart.find(i=>i.pid===P.id);if(ex)ex.qty++;else S.cart.push({pid:P.id,name:P.name,size:P.size||"",qty:1,price:num(P.price),cost:num(P.cost)});render();break}
    case"qty":{const i=S.cart[+b.dataset.ix];i.qty+=+b.dataset.d;if(i.qty<=0)S.cart.splice(+b.dataset.ix,1);render();break}
    case"clearCart":S.cart=[];render();break;
    case"record":{
      if(!S.cart.length)break;if(S.pay==="Credit"&&!S.customer.trim()){toast("Add the customer's name for a credit sale");const c=$("#cust");if(c)c.focus();break}
      const t=today(),sale={id:uid(),ts:Date.now(),items:S.cart.map(i=>({pid:i.pid,name:i.name,size:i.size,qty:i.qty,price:i.price,cost:i.cost})),pay:S.pay,by:S.name||"",byId:S.uid||""};
      if(S.pay==="Credit")sale.customer=S.customer.trim();
      const total=saleTotal(sale);
      mutateDay(myDoc(t),t,d=>{d.sales.push(sale);return d}).then(()=>{if(!S.readOnly)toast("Sale recorded · "+money(total))});
      S.cart=[];S.customer="";S.pay="Cash";render();break}
    case"void":{const k="v"+b.dataset.id;if(S.confirm!==k){armConfirm(k);break}S.confirm=null;const doc=b.dataset.doc,d0=S.days[doc];mutateDay(doc,d0.date,d=>{d.sales=d.sales.map(s=>s.id===b.dataset.id?{...s,voidedAt:Date.now(),voidedBy:S.name||"",voidReason:"Voided at the till"}:s);return d}).then(()=>toast("Sale voided — see it in Sales"));break}
    case"delExp":{const k="e"+b.dataset.id;if(S.confirm!==k){armConfirm(k);break}S.confirm=null;const doc=b.dataset.doc,d0=S.days[doc];mutateDay(doc,d0.date,d=>{d.expenses=d.expenses.filter(x=>x.id!==b.dataset.id);return d}).then(()=>toast("Expense deleted"));break}
    case"restock":if(P)restockForm(P);break;
    case"count":if(P)countForm(P,stockMap()[P.id]);break;
    case"addExp":expenseForm();break;
    case"expMonth":{const v=+b.dataset.v,cur=ymd(new Date()).slice(0,7);if(!v){S.expMonth=null}else{const [y,mo]=(S.expMonth||cur).split("-").map(Number);const n=ymd(new Date(y,mo-1+v,1)).slice(0,7);S.expMonth=n>=cur?null:n}render();break}
    case"newProd":productForm(null);break;
    case"editProd":if(P)productForm(P);break;
    case"archiveProd":{if(b.dataset.armed!=="1"){b.dataset.armed="1";b.textContent="Tap again to remove";break}writeProduct(b.dataset.id,{active:false},true);closeModal();toast("Product removed");break}
    case"paid":paidForm(b.dataset.id,b.dataset.doc);break;
    case"lock":signOutNow();break;
    case"fullscreen":{const d=document.documentElement;if(document.fullscreenElement){document.exitFullscreen&&document.exitFullscreen()}else if(d.requestFullscreen){d.requestFullscreen().catch(()=>toast("Full screen isn't available here — press F11 in your browser"))}else toast("Press F11 in your browser for full screen");break}
    case"addUser":personForm(null);break;
    case"openUser":{const u=S.team.find(x=>x.user_id===b.dataset.id);if(u){S.confirm=null;personPanel(u)}break}
    case"editUser":{const u=S.team.find(x=>x.user_id===b.dataset.id);if(u)personForm(u);break}
    case"pwUser":{const u=S.team.find(x=>x.user_id===b.dataset.id);if(u)passwordForm(u);break}
    case"toggleUser":{const u=S.team.find(x=>x.user_id===b.dataset.id);if(!u)break;const on=u.active===false;b.disabled=true;
      staffApi({action:"active",user_id:u.user_id,active:on}).then(async()=>{toast((u.label||"")+(on?" can sign in again":" can no longer sign in"));await loadTeam();const n=S.team.find(x=>x.user_id===u.user_id);if(n)personPanel(n)}).catch(err=>{toast(err.message);b.disabled=false});break}
    case"delUser":{const u=S.team.find(x=>x.user_id===b.dataset.id);if(!u)break;const k="del"+u.user_id;if(S.confirm!==k){S.confirm=k;b.classList.add("danger");b.textContent="Tap again to delete login";setTimeout(()=>{if(S.confirm===k){S.confirm=null;b.classList.remove("danger");b.textContent="Delete login"}},4000);break}
      S.confirm=null;b.disabled=true;staffApi({action:"delete",user_id:u.user_id}).then(()=>{closeModal();toast((u.label||"Login")+" deleted — their past sales are kept");loadTeam()}).catch(err=>{toast(err.message);b.disabled=false});break}
    case"sr":S.sr=b.dataset.v;if(S.sr==="custom"&&!S.sfrom){S.sfrom=today();S.sto=today()}render();break;
    case"pickDay":S.sr="custom";S.sfrom=S.sto=b.dataset.v;render();window.scrollTo(0,0);break;
    case"exportSales":exportSales();break;
    case"editSale":{const s=collect("sales","0000-00-00","9999-99-99",true).find(x=>x.id===b.dataset.id);if(s)editSaleForm(s,b.dataset.doc);break}
    case"voidSale":{const s=collect("sales","0000-00-00","9999-99-99",true).find(x=>x.id===b.dataset.id);if(s)voidForm(s,b.dataset.doc);break}
    case"unvoid":{const doc=b.dataset.doc,d0=S.days[doc];if(!d0)break;mutateDay(doc,d0.date,d=>{d.sales=d.sales.map(s=>{if(s.id!==b.dataset.id)return s;const c={...s};delete c.voidedAt;delete c.voidedBy;delete c.voidReason;return c});return d}).then(()=>toast("Sale restored"));break}
    case"startOrder":startOrder();render();window.scrollTo(0,0);break;
    case"blankOrder":S.draft={};S.gsup={};S.oq="";S.ordMode="build";render();setTimeout(()=>{const q=$("#oq");if(q)q.focus()},0);break;
    case"cancelBuild":S.ordMode=null;S.draft={};render();break;
    case"of":S.ordFilter=b.dataset.v;render();break;
    case"addDraft":{if(!P)break;const sm=stockMap(),oo=onOrderMap(),s30=soldSince(30);S.draft[P.id]=draftItem(P,sm[P.id],oo[P.id],s30[P.id]);S.oq="";render();break}
    case"createOrder":{
      const k=b.dataset.g,gk=b.dataset.gk,sup=(S.gsup[gk]??(k==="~"?"":k)).trim();
      if(!sup){toast("Type the supplier's name first");const el=$("#gs_"+gk);if(el)el.focus();break}
      const pids=Object.keys(S.draft).filter(pid=>{const p=S.products[pid];return p&&(supOf(p)||"~")===k&&S.draft[pid].on&&num(S.draft[pid].qty)>0});
      const id="o"+uid(),o={id,no:nextLpo(),deliveries:[],createdAt:Date.now(),by:S.name||"",byId:S.uid||"",supplier:sup,status:"draft",items:pids.map(pid=>{const p=S.products[pid],d=S.draft[pid];return{pid,name:p.name,size:p.size||"",qty:num(d.qty),unitCost:num(d.cost)}})};
      Object.keys(S.draft).filter(pid=>{const p=S.products[pid];return p&&(supOf(p)||"~")===k}).forEach(pid=>delete S.draft[pid]);
      if(!Object.keys(S.draft).length)S.ordMode=null;
      S.orders[id]=o;render();
      writeDoc("orders/"+id,o).then(ok=>{if(ok)toast(o.no+" created for "+sup+" — download, copy or mark it sent below")});
      (async()=>{for(const pid of pids){const p=S.products[pid];if(p&&supOf(p)!==sup)await writeDoc("products/"+pid,{supplier:sup},true)}})();
      break}
    case"copyOrder":{const o=S.orders[b.dataset.id];if(!o)break;const t=orderText(o);
      try{navigator.clipboard.writeText(t).then(()=>toast("Order copied — paste it into WhatsApp"),()=>copyFallback(t))}catch(_){copyFallback(t)}break}
    case"sentOrder":{const o=S.orders[b.dataset.id];if(o)sentForm(o);break}
    case"pdfOrder":{const o=S.orders[b.dataset.id];if(o)pdfOrder(o);break}
    case"closeOrder":{const k="x"+b.dataset.id;if(S.confirm!==k){armConfirm(k);break}S.confirm=null;writeDoc("orders/"+b.dataset.id,{status:"received",closedAt:Date.now(),closeNote:"remaining items not delivered"},true).then(ok=>{if(ok)toast("Order closed")});break}
    case"cancelOrder":{const k="c"+b.dataset.id;if(S.confirm!==k){armConfirm(k);break}S.confirm=null;writeDoc("orders/"+b.dataset.id,{status:"cancelled",cancelledAt:Date.now()},true).then(ok=>{if(ok)toast("Order cancelled")});break}
    case"receiveOrder":{const o=S.orders[b.dataset.id];if(o)receiveForm(o);break}
    case"countAll":S.countMode=true;S.counts={};render();window.scrollTo(0,0);break;
    case"cancelCount":S.countMode=false;S.counts={};render();break;
    case"ccat":S.ccat=b.dataset.v;render();break;
    case"saveCounts":{
      const ids=Object.keys(S.counts).filter(k=>S.counts[k]!==""&&S.products[k]);const ts=Date.now();
      S.countMode=false;const vals={...S.counts};S.counts={};render();toast("Saving "+ids.length+" counts…");
      (async()=>{for(const id of ids){await writeProduct(id,{open:num(vals[id]),countedAt:ts,needsCount:false},true)}toast("Saved "+ids.length+" counts")})();
      break}
  }
});
document.addEventListener("input",e=>{
  const t=e.target;
  if(t.dataset&&t.dataset.cl){closeInput(t);return}
  if(t.id==="q"){S.q=t.value;const g=$("#pgrid");const pos=t.selectionStart;render();const q=$("#q");if(q){q.focus();try{q.setSelectionRange(pos,pos)}catch(_){}}return}
  if(t.id==="cust"){S.customer=t.value;return}
  if(t.id==="tabname"){S.ticket.label=t.value;return}
  if(t.id==="sq"){S.sq=t.value;render();return}
  if(t.id==="teamq"){S.teamQ=t.value;render();return}
  if(t.id==="oq"){S.oq=t.value;render();return}
  if(t.id==="pq"){S.pq=t.value;render();return}
  if(t.id==="stq"){S.stq=t.value;render();return}
  if(t.dataset&&t.dataset.gsup){S.gsup[t.dataset.gsup]=t.value;const btn=t.closest(".panel").querySelector('[data-act="createOrder"]');if(btn)btn.textContent="Create order"+(t.value.trim()?" for "+t.value.trim():"");return}
  if(t.dataset&&(t.dataset.dq||t.dataset.dc)){const pid=t.dataset.dq||t.dataset.dc;if(S.draft[pid]){S.draft[pid][t.dataset.dq?"qty":"cost"]=t.value.replace(/[^0-9]/g,"");render()}return}
  if(t.dataset&&t.dataset.cnt){const had=(S.counts[t.dataset.cnt]??"")!=="";S.counts[t.dataset.cnt]=t.value.replace(/[^0-9]/g,"");if(had!==(S.counts[t.dataset.cnt]!=="")){const n=Object.values(S.counts).filter(v=>v!=="").length,btn=document.querySelector('[data-act="saveCounts"]');if(btn){btn.disabled=!n;btn.textContent="Save "+(n||"")+" count"+(n===1?"":"s")}}return}
  if(t.dataset&&t.dataset.act==="price"){const i=S.ticket.items[+t.dataset.ix];if(i){i.price=num(t.value);S.ticket.dirty=true;const el=document.querySelector(".ticket .total .num");if(el)el.textContent=money(ticketTotal());const lt=t.closest(".tline").querySelector(".lt");if(lt)lt.textContent=money(i.qty*i.price)}}
});
document.addEventListener("change",e=>{
  if(e.target.dataset&&e.target.dataset.clv){const C=S.close,id=e.target.dataset.clv;if(C){C.collected[id]={...(C.collected[id]||{amount:""}),via:e.target.value};updateCloseSum()}return}
  if(e.target.dataset&&e.target.dataset.paysel){changePay(e.target.dataset.paysel,e.target.value);return}
  if(e.target.id==="autolock"){saveAccessSetting({autoLockMin:num(e.target.value)});toast("Auto-lock updated");return}
  {const t=e.target;if(t.id==="spay"){S.spay=t.value;render();return}if(t.id==="sby"){S.sby=t.value;render();return}if(t.id==="sfrom"){S.sfrom=t.value;render();return}if(t.id==="sto"){S.sto=t.value;render();return}if(t.id==="showVoid"){S.showVoid=t.checked;render();return}}
  if(e.target.dataset&&e.target.dataset.don){const d=S.draft[e.target.dataset.don];if(d){d.on=e.target.checked;render()}return}
  if(e.target.id==="pay"){S.pay=e.target.value;render()}
  if(e.target.dataset&&e.target.dataset.act==="price")render();
});
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal();
  if(e.target&&e.target.id==="q"&&e.key==="Enter"){e.preventDefault();const m=sellMatches();if(m[0]){addToTicket(m[0]);S.q="";render();const q=$("#q");q&&q.focus()}}
  if(e.target&&e.target.id==="tabname"&&e.key==="Enter"){e.preventDefault();sellAct("openTab",e.target)}
});
document.addEventListener("submit",async e=>{
  const f=e.target.closest("form[data-form]");if(!f)return;e.preventDefault();
  const v=Object.fromEntries(new FormData(f).entries()),kind=f.dataset.form,id=f.dataset.id;
  if(kind==="person"||kind==="pw"){
    const pre=kind==="person"?"p":"w",err=m=>{const el=$("#"+pre+"_err");if(el)el.textContent=m;else toast(m)},btn=$("#"+pre+"_save");
    if(v.pw!==undefined){if(v.pw!==v.pw2)return err("The two passwords don't match");if(v.pw.length<8)return err("Password must be at least 8 characters")}
    if(btn)btn.disabled=true;
    try{
      if(kind==="pw"){await staffApi({action:"password",user_id:id,password:v.pw});closeModal();toast("Password changed");return}
      const info={name:String(v.name||"").trim(),phone:String(v.phone||"").trim(),notes:String(v.notes||"").trim(),started_on:v.started_on||null};
      if(!info.name)throw new Error("Add a name");
      if(!id){const username=String(v.username||"").trim().toLowerCase();await staffApi({action:"create",...info,username,role:v.role,password:v.pw});closeModal();toast(info.name+" can now sign in as “"+username+"”");await loadTeam();return}
      const cur=S.team.find(x=>x.user_id===id)||{};
      const body={action:"update",user_id:id,...info};
      if(v.role&&v.role!==cur.role)body.role=v.role;
      if(v.username!==undefined&&cur.username&&String(v.username).trim().toLowerCase()!==cur.username)body.username=String(v.username).trim().toLowerCase();
      await staffApi(body);closeModal();toast(body.username?"Saved — they now sign in as “"+body.username+"”":"Details saved");await loadTeam();
      if(id===S.uid){S.name=info.name;render()}
    }catch(e2){err(e2.message);if(btn)btn.disabled=false}
    return}
  if(kind==="name"){S.name=v.name.trim();ls("cave_name",S.name);closeModal();render();return}
  if(kind==="prod"){
    const data={name:v.name.trim(),cat:v.cat,size:v.size.trim(),cost:num(v.cost),price:num(v.price),reorder:num(v.reorder),supplier:(v.supplier||"").trim()};
    if(!data.name)return toast("Give the product a name");
    if(id){writeProduct(id,data,true);toast("Saved")}
    else{const nid="p"+uid();writeProduct(nid,{...data,id:nid,open:num(v.open),countedAt:Date.now(),active:true,needsCount:false});toast("Product added")}
    closeModal();return}
  if(kind==="restock"){
    const P=S.products[id],qty=num(v.qty),uc=num(v.unitCost);if(qty<=0)return toast("Enter how many bottles came in");
    const t=today();mutateDay(myDoc(t),t,d=>{d.restocks.push({id:uid(),ts:Date.now(),pid:id,name:P.name,qty,unitCost:uc,supplier:(v.supplier||"").trim(),by:S.name||""});return d}).then(()=>toast("Added "+qty+" × "+P.name));
    if(v.upd&&uc!==num(P.cost))writeProduct(id,{cost:uc},true);
    closeModal();return}
  if(kind==="receive"){
    const o=S.orders[id];if(!o)return closeModal();
    const g0=gotMap(o);
    const got=o.items.map((i,ix)=>v["q"+ix]===undefined?null:{pid:i.pid,name:i.name,qty:Math.min(num(v["q"+ix]),dueQty(o,i,g0)),unitCost:num(v["c"+ix])}).filter(x=>x&&x.qty>0);
    if(!got.length)return toast("Enter how many bottles arrived");
    const ts=Date.now(),t=today(),dv={id:uid(),ts,date:t,by:S.name||"",note:(v.note||"").trim(),items:got.map(({pid,qty,unitCost})=>({pid,qty,unitCost}))};
    const deliveries=[...(o.deliveries||[]),dv],o2={...o,deliveries},g=gotMap(o2),done=o.items.every(i=>dueQty(o2,i,g)===0);
    const upd={deliveries,status:done?"received":"partial"};if(done)upd.receivedAt=ts;if(!o.sentAt)upd.sentAt=ts;
    const updCosts=!!(v.upd&&ADM());
    const local=[{k:"upd",t:"orders",id,patch:toRow("orders",upd)}];
    got.forEach(x=>{local.push({k:"ins",t:"restocks",row:toRow("restocks",{id:dv.id+":"+x.pid,date:t,ts,pid:x.pid,name:x.name,qty:x.qty,unitCost:x.unitCost,supplier:o.supplier||"",orderId:o.id,orderNo:o.no||"",by:S.name||""})});
      if(updCosts&&x.unitCost!==num((S.products[x.pid]||{}).cost))local.push({k:"upd",t:"products",id:x.pid,patch:{cost:x.unitCost}})});
    enqueue({k:"rpc",fn:"receive_delivery",args:{p_order:id,p_delivery:dv,p_update_costs:updCosts},local});
    toast(done?"Order complete — stock updated":"Part delivery saved — the rest is still due");
    closeModal();return}
  if(kind==="sent"){const o=S.orders[id];if(!o)return closeModal();const upd={expectedDate:v.exp};if(o.status==="draft"){upd.status="sent";upd.sentAt=Date.now()}writeDoc("orders/"+id,upd,true).then(ok=>{if(ok)toast(o.status==="draft"?"Marked as sent — due "+niceDate(v.exp):"Delivery date changed")});closeModal();return}
  if(kind==="count"){const n=num(v.n);writeProduct(id,{open:n,countedAt:Date.now(),needsCount:false},true);closeModal();toast("Count saved");return}
  if(kind==="exp"){
    const amt=num(v.amount);if(amt<=0)return toast("Enter the amount paid");
    const date=v.date||today();mutateDay(myDoc(date),date,d=>{d.expenses.push({id:uid(),ts:Date.now(),cat:v.cat,amount:amt,note:(v.note||"").trim(),by:S.name||"",byId:S.uid||""});return d}).then(()=>toast("Expense saved"));
    closeModal();return}
  if(kind==="editSale"||kind==="voidSale"){
    const doc=f.dataset.doc,d0=S.days[doc];if(!d0)return closeModal();
    if(kind==="voidSale"){mutateDay(doc,d0.date,d=>{d.sales=d.sales.map(s=>s.id===id?{...s,voidedAt:Date.now(),voidedBy:S.name||"",voidReason:v.reason}:s);return d}).then(()=>toast("Sale voided — bottles back in stock"));closeModal();return}
    const s0=(d0.sales||[]).find(s=>s.id===id);if(!s0)return closeModal();
    const items=s0.items.map((i,ix)=>v["x"+ix]?null:{...i,qty:num(v["q"+ix]),price:num(v["p"+ix])}).filter(i=>i&&i.qty>0);
    if(!items.length)return toast("A sale needs at least one item — use Void to remove it");
    if(v.pay==="Credit"&&!(v.customer||"").trim())return toast("Add the customer's name for a credit sale");
    mutateDay(doc,d0.date,d=>{d.sales=d.sales.map(s=>{if(s.id!==id)return s;const c={...s,items,pay:v.pay,editedAt:Date.now(),editedBy:S.name||""};if(v.pay==="Credit")c.customer=v.customer.trim();else{delete c.customer;delete c.paidAt;delete c.paidVia}return c});return d}).then(()=>toast("Sale updated"));
    closeModal();return}
  if(kind==="paid"){const doc=f.dataset.doc,d0=S.days[doc];mutateDay(doc,d0.date,d=>{d.sales=d.sales.map(s=>s.id===id?{...s,paidAt:Date.now(),paidVia:v.via}:s);return d}).then(()=>toast("Marked as paid"));closeModal();return}
});

/* ---------- boot ---------- */
async function boot(){
  render();renderLock();
  const cache=await idb.get("cache");
  if(cache&&cache.srv){S.srv={...S.srv,...cache.srv,counter_sessions:cache.srv.counter_sessions||{},credits:cache.srv.credits||{}};S.loadedFrom=cache.loadedFrom;S.status="ok";rebuild()}
  if(!window.supabase||!CFG.url||!CFG.anonKey){S.status="ok";S.accessLoaded=true;renderLock();return}
  S.client=supabase.createClient(CFG.url,CFG.anonKey,{auth:{persistSession:true,autoRefreshToken:true,storageKey:"cave-main"}});
  S.accessLoaded=true;
  let prof=null;try{prof=JSON.parse(ls("cave_profile")||"null")}catch(_){}
  let session=null;try{session=(await S.client.auth.getSession()).data.session}catch(_){}
  if(!session){S.status="ok";renderLock();render();return}
  if(prof&&prof.uid!==session.user.id)prof=null;
  try{const p=await profileFor(S.client,session.user.id);
    if(!p||p.active===false){S.noaccess=p?"This login has been turned off. Ask the Admin.":"This login hasn't been given access yet. Ask the Admin.";S.status="ok";renderLock();return}
    prof={uid:session.user.id,role:p.role,label:p.label||p.username||""}}
  catch(e){if(!prof){S.status="ok";if(!isNetErr(e)){S.noaccess="Couldn't check this login: "+(e.message||e)}renderLock();return}S.online=false}
  startSession(session.user.id,prof);renderStatus();
}
boot();
if("serviceWorker" in navigator&&location.protocol.startsWith("http")){let swReloaded=false;navigator.serviceWorker.addEventListener("controllerchange",()=>{if(swReloaded||S.queue.length)return;swReloaded=true;location.reload()})}
if("serviceWorker" in navigator&&location.protocol.startsWith("http"))navigator.serviceWorker.register("sw.js").then(r=>{r.addEventListener("updatefound",()=>{const w=r.installing;w&&w.addEventListener("statechange",()=>{if(w.state==="installed"&&navigator.serviceWorker.controller)toast("A new version is ready — it loads next time you open the app")})})}).catch(()=>{});
})();

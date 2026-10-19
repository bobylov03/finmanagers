"use strict";
/* ============================================================
   11. ОТЧЁТЫ (раздел 9)
   ============================================================ */
const RF = {
  rep37:{date:"", byOrg:false, byAcc:false, byCur:false, zero:false},
  rep75:{date:"", wallets:[], sub:true},
  rep38:{from:"", to:"", step:"month", wallets:[], sub:true, cur:""},
  rep40:{date:""},
  recon:{bad:false},
  hist:{from:"", to:"", org:"", dept:"", cpty:"", q:""},
};
let DRILLS = [];
const drillLink = (fn, html) => { DRILLS.push(fn); return `<a class="lnk" onclick="DRILLS[${DRILLS.length-1}]()">${html}</a>`; };
const repDate = F => F.date || CUR.date;

/** Дерево видимых кошельков: родитель — ближайший видимый предок */
function visibleTree(){
  const V = visibleWallets();
  const list = DB.wallets.filter(w=>V.has(w.id)).map(w=>{ let p = wal(w.parent); while(p && !V.has(p.id)) p = wal(p.parent); return Object.assign({}, w, {parent:p?p.id:null}); });
  return tree(list);
}
function srcTitle(f){
  if(f.src.k==="open") return "Входящий остаток";
  if(f.src.k==="op"){ const o = byId(DB.ops,f.src.id); return o ? `${OP_KINDS[o.kind].name} ${o.no}` : "Операция"; }
  const d = byId(DB.docs,f.src.id); return d ? `${d.type} ${d.no1c||d.no}` : "Документ";
}
function openSrc(k, id){ if(k==="op") openOp(id); else if(k==="doc") openDoc(id); else if(isAdmin(me())) go("opening"); }
/** Переход до документа: список фактов */
function showFacts(title, pred){
  openModal({title:esc(title), drawer:true, width:1180, body:()=>{
    const list = visFacts().filter(pred).sort((a,b)=>(a.docDate||a.date)<(b.docDate||b.date)?-1:(a.docDate||a.date)>(b.docDate||b.date)?1:0);
    const byCur = {}; list.forEach(f=>byCur[f.cur]=(byCur[f.cur]||0)+f.sum);
    return `
    <div class="row" style="margin-bottom:8px">${Object.entries(byCur).map(([c,v])=>`<span class="tag">${fmtS(r2(v))} ${esc(curCode(c))}</span>`).join(" ")}
      <span class="muted">${list.length} записей</span><div style="flex:1"></div>
      <button class="btn sm" onclick="exportTable('factsTbl','Документы')">Выгрузить в Excel</button></div>
    <div class="tbl-wrap"><table id="factsTbl" class="sortable"><thead><tr><th>Дата</th><th>Документ</th><th>Организация</th><th>Счёт или касса</th><th>Кошелёк</th><th>Тип расхода CF / вид</th><th class="num">Сумма</th><th>Вал.</th><th class="num">USD</th></tr></thead>
    <tbody>${list.map(f=>`<tr class="clickable" onclick="openSrc('${f.src.k}','${f.src.id}')">
      <td>${fmtD(f.docDate||f.date)}${f.sbds?`<div class="sub">${f.date!==FAR?`банк ${fmtD(f.date)}`:f.kp!==FAR?`<span class="tag info">Писх</span>`:`<span class="tag warn">не исполнен</span>`}</div>`:""}</td><td><a class="lnk">${esc(srcTitle(f))}</a></td><td>${esc(nm(org(f.org)))}</td><td>${esc(nm(acc(f.acc)))}</td>
      <td>${f.wallet?esc(nm(wal(f.wallet))):`<span class="tag warn">без кошелька</span>`}</td>
      <td>${f.cat==="internal"?esc(OP_KINDS[f.kind].name):f.cat==="transfer"?esc(f.op):f.cat==="opening"?"Входящий остаток":esc(refName(DB.cfTypes,f.cf))}</td>
      <td class="num ${f.sum<0?"neg":"pos"}">${fmtS(f.sum)}</td><td>${esc(curCode(f.cur))}</td><td class="num ${f.usd<0?"neg":""}">${fmtS(f.usd)}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">Нет записей</td></tr>`}</tbody></table></div>`; }});
}
function repHeader(title, tr, lede, tableId){
  return `<h1>${esc(title)} <span class="tzref">${tr}</span></h1><p class="lede">${lede}</p>`;
}
function exportBtn(tableId, name){ return `<button class="btn" onclick="exportTable('${tableId}','${jsq(name)}')">Выгрузить в Excel</button>`; }
function emptyHint(){
  if(DB.wallets.length && facts().length) return "";
  return `<div class="alert warn">Данных пока нет. ${isAdmin(me())?`Начните с раздела <a class="lnk" onclick="go('dash')">Сводка</a> — там порядок первичной настройки.`:"Обратитесь к администратору."}</div>`;
}

/* ---------- ТР-37. Деньги по кошелькам на дату: Кф и Кп ---------- */
/* Кф — фактический расчётный остаток (СБДС — только исполненные банком); Кп = Кф − Писх (подтверждённые казначеем исходящие в пути) */
let R37C = new Set();   // свёрнутые кошельки
function tog37(id){ R37C.has(id) ? R37C.delete(id) : R37C.add(id); render(); }
const KFKP_HELP = "Кф — фактический расчётный остаток: всё, что исполнено банком. Кп — плановый: Кф за вычетом исходящих платежей, которые казначей подтвердил как отправленные, но банк ещё не списал (Кп = Кф − Писх, ТР-07).";
function viewRep37(){
  DRILLS = []; const F = RF.rep37; const date = repDate(F);
  const list = visFacts(); const bad = badAccs();
  const split = F.byOrg || F.byAcc;
  const keyOf = f => [F.byOrg?f.org:"", F.byAcc?f.acc:"", f.cur].join("|");
  const agg = pred => { const kf={}, kp={}, parts=new Map(); let neg=false, hasBad=false;
    list.forEach(f=>{ const inF = f.date<=date, inP = (f.kp||f.date)<=date; if((!inF && !inP) || !pred(f)) return;
      if(inF) kf[f.cur]=(kf[f.cur]||0)+f.sum; if(inP) kp[f.cur]=(kp[f.cur]||0)+f.sum;
      if(bad.has(f.acc)) hasBad = true;
      if(split){ const k = keyOf(f); let p = parts.get(k); if(!p){ p={org:f.org, acc:f.acc, cur:f.cur, kf:0, kp:0}; parts.set(k,p);} if(inF) p.kf+=f.sum; if(inP) p.kp+=f.sum; } });
    balances(date, list.filter(pred)).forEach(r=>{ if(r.sum < -0.005 || r.kp < -0.005) neg = true; });
    return {kf, kp, ukf:usdOf(kf,date), ukp:usdOf(kp,date), parts:[...parts.values()], neg, hasBad}; };
  const V = visibleWallets(); const T = visibleTree();
  const kids = new Set(T.map(w=>w.parent).filter(Boolean));
  const hiddenBy = w => { let p = T.find(x=>x.id===w.parent); while(p){ if(R37C.has(p.id)) return true; p = T.find(x=>x.id===p.parent); } return false; };
  const rows = T.map(w=>{ const S = descendants(w.id); return {w, a:agg(f=>f.wallet && S.has(f.wallet) && V.has(f.wallet)), pred:f=>f.wallet && S.has(f.wallet), hidden:hiddenBy(w)}; });
  const noW = seesNoWallet(me()) ? agg(f=>!f.wallet) : null;
  const tot = agg(()=>true);
  const curs = [...new Set([...Object.keys(tot.kf), ...Object.keys(tot.kp)])].filter(c=>Math.abs(tot.kf[c]||0)>=0.005 || Math.abs(tot.kp[c]||0)>=0.005 || F.zero)
    .sort((a,b)=>(isUSD(b)-isUSD(a)) || curCode(a).localeCompare(curCode(b)));
  const cell = (v, cls="") => Math.abs(v||0)<0.005 ? `<td class="num muted ${cls}">—</td>` : `<td class="num ${cls} ${v<0?"neg":""}">${fmt(r2(v))}</td>`;
  const curCells = a => curs.map(c=>cell(a.kf[c],"kf")+cell(a.kp[c],"kp")).join("");
  const partRows = (a, pred, lvl) => a.parts.filter(p=>F.zero || Math.abs(p.kf)>=0.005 || Math.abs(p.kp)>=0.005).sort((x,y)=>(nm(org(x.org))+nm(acc(x.acc))+curCode(x.cur)).localeCompare(nm(org(y.org))+nm(acc(y.acc))+curCode(y.cur),"ru")).map(p=>{
    const k = rateAt(p.cur,date); const uf = k ? r2(p.kf/k) : NaN, up = k ? r2(p.kp/k) : NaN;
    const label = [F.byOrg?nm(org(p.org)):"", F.byAcc?posLabel(p.acc,p.cur):""].filter(Boolean).join(" · ");
    const isBad = F.byAcc && bad.has(p.acc);
    const pr = f=>pred(f) && (!F.byOrg||f.org===p.org) && (!F.byAcc||f.acc===p.acc) && f.cur===p.cur;
    return `<tr class="part ${isBad?"bad":""}"><td style="padding-left:${lvl*20+44}px">${drillLink(()=>showFacts(label, f=>pr(f) && (f.date<=date || (f.kp||f.date)<=date)), esc(label))}
      ${isBad?` <span class="tag off" title="ТР-42">расхождение</span>`:""}</td>
      ${curs.map(c=>c===p.cur?cell(p.kf,"kf")+cell(p.kp,"kp"):`<td></td><td></td>`).join("")}${cell(uf,"kf usd")}${cell(up,"kp usd")}</tr>`;
  }).join("");
  const line = (w, label, a, pred, lvl, cls="") => {
    const has = w && kids.has(w.id); const closed = has && R37C.has(w.id);
    const miss = [...new Set([...a.ukf.miss, ...a.ukp.miss])];
    return `<tr class="${cls}"><td style="padding-left:${lvl*20+14}px"><span class="tw">${has?`<button type="button" class="twist ${closed?"":"open"}" aria-expanded="${!closed}" aria-label="${closed?"Развернуть":"Свернуть"}" onclick="event.stopPropagation();tog37('${w.id}')"></button>`:`<span class="twist-sp"></span>`}
        ${drillLink(()=>showFacts(label, f=>pred(f) && (f.date<=date || (f.kp||f.date)<=date)), esc(label))}</span>
        ${a.neg?` <span class="tag off">есть минус</span>`:""}${a.hasBad?` <span class="tag off" title="ТР-42">счёт с расхождением</span>`:""}${miss.length?` <span class="tag warn">нет курса ${esc(miss.join(", "))}</span>`:""}</td>
      ${curCells(a)}${cell(a.ukf.usd,"kf usd")}${cell(a.ukp.usd,"kp usd")}</tr>` + (split && !closed ? partRows(a,pred,lvl) : ""); };
  const allIds = [...kids];
  return `${repHeader("Деньги по кошелькам на дату","ТР-37",`Остаток каждого кошелька по иерархии: родитель включает подчинённые. ${KFKP_HELP} Остаток в USD = остаток в валюте ÷ курс ERP на дату отчёта (ТР-58). Нажмите на название, чтобы увидеть документы.`)}
  ${emptyHint()}
  <div class="toolbar">
    <label class="fld"><span>На дату</span><input type="date" value="${date}" onchange="RF.rep37.date=this.value;render()"></label>
    <div class="fld"><span>Разбить по</span><div class="chips">
      ${chip(F.byOrg,"RF.rep37.byOrg=!RF.rep37.byOrg;render()","юрлицам")}${chip(F.byAcc,"RF.rep37.byAcc=!RF.rep37.byAcc;render()","позициям (счёт × валюта)")}</div></div>
    <div class="fld"><span>Показать</span><div class="chips">${chip(F.zero,"RF.rep37.zero=!RF.rep37.zero;render()","нулевые")}</div></div>
    <div class="grow"></div>
    ${allIds.length?`<div class="row tb-actions"><button type="button" class="btn ghost" onclick="R37C=new Set();render()">Развернуть всё</button><button type="button" class="btn ghost" onclick="R37C=new Set(${esc(JSON.stringify(allIds))});render()">Свернуть всё</button></div>`:""}
    ${exportBtn("t37","Деньги по кошелькам")}
  </div>
  <div class="panel"><div class="body flush"><div class="tbl-wrap" style="max-height:none"><table id="t37" class="ledger-t kfkp">
    <thead><tr><th rowspan="2">Кошелёк</th>${curs.map(c=>`<th class="num grp-h" colspan="2">${esc(curCode(c))}</th>`).join("")}<th class="num grp-h" colspan="2">Итого, USD</th></tr>
      <tr>${[...curs, "usd"].map(()=>`<th class="num kf" title="Фактический расчётный остаток">Кф</th><th class="num kp" title="Плановый остаток: Кф − Писх">Кп</th>`).join("")}</tr></thead>
    <tbody>
      ${rows.filter(r=>!r.hidden).map(r=>line(r.w, r.w.name, r.a, r.pred, r.w._lvl, r.w._lvl?"":"grp")).join("") || `<tr><td colspan="${curs.length*2+3}" class="muted">Нет доступных кошельков</td></tr>`}
      ${noW && [...Object.values(noW.kf), ...Object.values(noW.kp)].some(v=>Math.abs(v)>=0.005) ? line(null, "Без кошелька", noW, f=>!f.wallet, 0, "grp nowallet") : ""}
      <tr class="tot"><td>Итого</td>${curCells(tot)}${cell(tot.ukf.usd,"kf usd")}${cell(tot.ukp.usd,"kp usd")}</tr>
    </tbody></table></div></div></div>`;
}

/* ---------- ТР-75. Расположение ДС: компания → счёт или касса, Кф и Кп рядом, группы сворачиваются ---------- */
let R75C = new Set();   // свёрнутые компании
function toggle75(id,on){ const a = RF.rep75.wallets; RF.rep75.wallets = on ? [...new Set([...a,id])] : a.filter(x=>x!==id); render(); }
function tog75(o){ R75C.has(o) ? R75C.delete(o) : R75C.add(o); render(); }
function viewRep75(){
  DRILLS = []; const F = RF.rep75; const date = repDate(F);
  const sel = new Set(); F.wallets.forEach(id=>{ (F.sub?descendants(id):new Set([id])).forEach(x=>{ if(visibleWallets().has(x)) sel.add(x); }); });
  const list = visFacts().filter(f=>f.wallet && sel.has(f.wallet) && (f.date<=date || (f.kp||f.date)<=date));
  const m = new Map();
  list.forEach(f=>{ const k = f.org+"|"+f.acc+"|"+f.cur; let r = m.get(k); if(!r){ r={org:f.org, acc:f.acc, cur:f.cur, kf:0, kp:0, byW:{}}; m.set(k,r);}
    if(f.date<=date){ r.kf+=f.sum; r.byW[f.wallet]=(r.byW[f.wallet]||0)+f.sum; } if((f.kp||f.date)<=date) r.kp+=f.sum; });
  const rows = [...m.values()].filter(r=>Math.abs(r.kf)>=0.005 || Math.abs(r.kp)>=0.005);
  const bad = badAccs();
  const orgs = [...new Set(rows.map(r=>r.org))].sort((a,b)=>nm(org(a)).localeCompare(nm(org(b)),"ru"));
  const gF = {v:0}, gP = {v:0}; const missing = new Set();
  const usdCell = v => `<td class="num ${v<0?"neg":""}">${fmt(r2(v))}</td>`;
  const body = orgs.map(o=>{
    const rs = rows.filter(r=>r.org===o).sort((a,b)=>nm(acc(a.acc)).localeCompare(nm(acc(b.acc)),"ru"));
    let sF = 0, sP = 0; const closed = R75C.has(o);
    const html = rs.map(r=>{ const k = rateAt(r.cur,date); const uf = k?r2(r.kf/k):NaN, up = k?r2(r.kp/k):NaN; if(k){ sF += r.kf/k; sP += r.kp/k; } else missing.add(curCode(r.cur));
      if(closed) return "";
      const a = acc(r.acc);
      return `<tr class="${bad.has(r.acc)?"bad":""}"><td style="padding-left:40px">${drillLink(()=>showFacts(nm(a), f=>f.wallet&&sel.has(f.wallet)&&f.acc===r.acc&&f.cur===r.cur&&(f.date<=date||(f.kp||f.date)<=date)), esc(nm(a)))}
        <span class="muted">${a?esc(a.kind==="Касса"?"касса":(a.accType||"счёт").toLowerCase()):""}</span>${bad.has(r.acc)?` <span class="tag off">расхождение</span>`:""}</td>
        <td>${esc(curCode(r.cur))}</td><td class="num kf ${r.kf<0?"neg":""}">${fmt(r2(r.kf))}</td><td class="num kp ${r.kp<0?"neg":""}">${fmt(r2(r.kp))}</td>${usdCell(uf)}${usdCell(up)}
        <td class="muted" style="font-size:11px">${Object.entries(r.byW).filter(([w,v])=>Math.abs(v)>=0.005).map(([w,v])=>`${esc(nm(wal(w)))}: ${fmt(r2(v))}`).join("; ")}</td></tr>`; }).join("");
    gF.v += sF; gP.v += sP;
    return `<tr class="grp"><td colspan="4"><span class="tw"><button type="button" class="twist ${closed?"":"open"}" aria-expanded="${!closed}" aria-label="${closed?"Развернуть":"Свернуть"}" onclick="tog75('${o}')"></button> ${esc(nm(org(o)))} <span class="muted">· ${rs.length} ${plural(rs.length,"счёт","счёта","счетов")}</span></span></td>${usdCell(sF)}${usdCell(sP)}<td></td></tr>` + html;
  }).join("");
  return `${repHeader("Расположение ДС","ТР-75",`Выберите один или несколько кошельков — отчёт покажет, в каких компаниях, на каких счетах и кассах и в какой валюте лежат их деньги. ${KFKP_HELP} Компании сворачиваются, как группировка в Excel.`)}
  ${emptyHint()}
  <div class="toolbar">
    ${walletPicker("w75", F.wallets, "toggle75", {all:"Не выбраны", onAll:"RF.rep75.wallets=[...visibleWallets()].filter(id=>!wal(id).parent||!visibleWallets().has(wal(id).parent));render()", onClear:"RF.rep75.wallets=[];render()"})}
    <label class="fld"><span>На дату</span><input type="date" value="${date}" onchange="RF.rep75.date=this.value;render()"></label>
    <div class="fld"><span>Подчинённые</span><div class="chips">${chip(F.sub,"RF.rep75.sub=!RF.rep75.sub;render()","включать")}</div></div>
    <div class="grow"></div>
    ${orgs.length?`<div class="row tb-actions"><button type="button" class="btn ghost" onclick="R75C=new Set();render()">Развернуть все счета</button><button type="button" class="btn ghost" onclick="R75C=new Set(${esc(JSON.stringify(orgs))});render()">Свернуть все счета</button></div>`:""}
    ${exportBtn("t75","Расположение ДС")}
  </div>
  ${missing.size?`<div class="alert warn">Нет курса на ${fmtD(date)} для: ${esc([...missing].join(", "))}. Загрузите курсы из 1С.</div>`:""}
  <div class="panel"><div class="body flush"><div class="tbl-wrap" style="max-height:none"><table id="t75" class="kfkp">
    <thead><tr><th rowspan="2">Компания / счёт или касса</th><th rowspan="2">Валюта</th><th class="num grp-h" colspan="2">Остаток в валюте</th><th class="num grp-h" colspan="2">Остаток, USD</th><th rowspan="2">В т.ч. по кошелькам (Кф)</th></tr>
      <tr><th class="num kf" title="Фактический расчётный остаток">Кф</th><th class="num kp" title="Плановый остаток: Кф − Писх">Кп</th><th class="num kf">Кф</th><th class="num kp">Кп</th></tr></thead>
    <tbody>${F.wallets.length ? (body || `<tr><td colspan="7" class="muted">У выбранных кошельков нет остатков на ${fmtD(date)}</td></tr>`) : `<tr><td colspan="7" class="empty-cell">Выберите один или несколько кошельков в поле «Кошельки» выше.<br><button type="button" class="btn sm" style="margin-top:10px" onclick="RF.rep75.wallets=[...visibleWallets()].filter(id=>!wal(id).parent||!visibleWallets().has(wal(id).parent));render()">Показать все кошельки</button></td></tr>`}
    ${F.wallets.length && body ? `<tr class="tot"><td colspan="4">Итого, USD</td>${usdCell(gF.v)}${usdCell(gP.v)}<td></td></tr>`:""}</tbody>
  </table></div></div></div>`;
}

/* ---------- ТР-38. Фактический ДДС с остатками ---------- */
function toggle38(id,on){ const a = RF.rep38.wallets; RF.rep38.wallets = on ? [...new Set([...a,id])] : a.filter(x=>x!==id); render(); }
function buckets(from, to, step){
  const out = []; let s = from;
  while(s <= to && out.length < 400){
    let e;
    if(step==="day") e = s;
    else if(step==="week"){ const dow = (new Date(s+"T00:00:00Z").getUTCDay()+6)%7; e = addDays(s, 6-dow); }
    else e = monthEnd(s);
    if(e > to) e = to;
    const label = step==="day" ? fmtD(s) : step==="week" ? `${fmtD(s).slice(0,5)}–${fmtD(e).slice(0,5)}` : new Date(s+"T00:00:00Z").toLocaleDateString(LANG==="en"?"en-US":"ru-RU",{month:"short",year:"numeric",timeZone:"UTC"});
    out.push({s, e, label}); s = addDays(e,1);
  }
  return out;
}
function viewRep38(){
  DRILLS = []; const F = RF.rep38;
  const to = F.to || CUR.date; const from = F.from || (to.slice(0,7)+"-01");
  let list = visFacts();
  let S = null;
  if(F.wallets.length){ S = new Set(); F.wallets.forEach(id=>(F.sub?descendants(id):new Set([id])).forEach(x=>S.add(x))); list = list.filter(f=>f.wallet && S.has(f.wallet)); }
  if(F.cur) list = list.filter(f=>f.cur===F.cur);
  const inCur = !!F.cur;
  const B = buckets(from, to, F.step);
  // ТР-33: при выборе валюты — в валюте счёта и в USD; иначе — в USD
  const modes = inCur ? ["cur","usd"] : ["usd"];
  const val = (f,m) => m==="cur" ? f.sum : f.usd;
  const balOf = (lst, d, m) => { const bc = {}; lst.forEach(f=>{ if(f.date<=d) bc[f.cur]=(bc[f.cur]||0)+f.sum; }); return m==="cur" ? r2(bc[F.cur]||0) : usdOf(bc,d).usd; };
  const inB = (f,b) => f.date>=b.s && f.date<=b.e;
  const cfIn = new Set(), cfOut = new Set(), trOps = new Set(), kinds = new Set(); let hasOpen=false;
  list.forEach(f=>{ if(f.date<from||f.date>to) return;
    if(f.cat==="in") cfIn.add(f.cf||""); else if(f.cat==="out") cfOut.add(f.cf||""); else if(f.cat==="transfer") trOps.add(f.op||""); else if(f.cat==="internal") kinds.add(f.kind); else if(f.cat==="opening") hasOpen=true; });
  const cols = B.map(b=>{ const c = {b};
    modes.forEach(m=>{ const start = balOf(list, addDays(b.s,-1), m), end = balOf(list, b.e, m);
      const turn = list.filter(f=>inB(f,b)).reduce((s,f)=>s+val(f,m),0);
      c[m] = {start, end, fx: m==="cur" ? 0 : r2(end-start-turn)}; });
    return c; });
  const sumBy = (b, pred, m) => r2(list.filter(f=>inB(f,b) && pred(f)).reduce((s,f)=>s+val(f,m),0));
  const total = (pred, m) => r2(list.filter(f=>f.date>=from && f.date<=to && pred(f)).reduce((s,f)=>s+val(f,m),0));
  const LSET = new Set(list);
  const cellRow = (label, pred, {cls="", pad=0}={}) => `<tr class="${cls}"><td style="padding-left:${14+pad}px">${esc(label)}</td>${cols.map(c=>modes.map(m=>{ const v = sumBy(c.b,pred,m);
      return `<td class="num ${v<0?"neg":v>0?"pos":""}">${Math.abs(v)<0.005?`<span class="muted">·</span>`:drillLink(()=>showFacts(`${label} · ${c.b.label}`, f=>inB(f,c.b)&&pred(f)&&LSET.has(f)), fmtS(v))}</td>`; }).join("")).join("")}
      ${modes.map(m=>{ const t = total(pred,m); return `<td class="num ${t<0?"neg":""}"><b>${fmtS(t)}</b></td>`; }).join("")}</tr>`;
  const cfName = id => id ? refName(DB.cfTypes,id) : "Тип расхода CF не указан";
  const first = cols[0], last = cols[cols.length-1];
  const balRow = (label, key, cls) => `<tr class="${cls}"><td>${label}</td>${cols.map(c=>modes.map(m=>`<td class="num ${c[m][key]<0?"neg":""}">${fmt(c[m][key])}</td>`).join("")).join("")}
      ${modes.map(m=>`<td class="num">${fmt(key==="start" ? (first?first[m].start:0) : (last?last[m].end:0))}</td>`).join("")}</tr>`;
  const body = `
    ${balRow("Остаток на начало","start","grp")}
    ${hasOpen ? cellRow("Ввод входящих остатков", f=>f.cat==="opening") : ""}
    ${cellRow("Поступления", f=>f.cat==="in", {cls:"grp"})}
    ${[...cfIn].sort().map(cf=>cellRow(cfName(cf), f=>f.cat==="in" && (f.cf||"")===cf, {pad:18})).join("")}
    ${cellRow("Расходы", f=>f.cat==="out", {cls:"grp"})}
    ${[...cfOut].sort().map(cf=>cellRow(cfName(cf), f=>f.cat==="out" && (f.cf||"")===cf, {pad:18})).join("")}
    ${trOps.size ? cellRow("Переброски и конвертации между счетами группы", f=>f.cat==="transfer", {cls:"grp"}) + [...trOps].map(o=>cellRow(o||"—", f=>f.cat==="transfer"&&f.op===o, {pad:18})).join("") : ""}
    ${cellRow("Внутренние операции между кошельками", f=>f.cat==="internal", {cls:"grp"})}
    ${[...kinds].map(k=>cellRow(OP_KINDS[k].name, f=>f.cat==="internal"&&f.kind===k, {pad:18})).join("")}
    <tr><td title="ТР-58">Курсовая разница</td>${cols.map(c=>modes.map(m=>m==="cur"?`<td class="num muted">·</td>`:`<td class="num ${c.usd.fx<0?"neg":""}">${Math.abs(c.usd.fx)<0.005?`<span class="muted">·</span>`:fmtS(c.usd.fx)}</td>`).join("")).join("")}
      ${modes.map(m=>m==="cur"?`<td class="num muted">·</td>`:`<td class="num"><b>${fmtS(r2(cols.reduce((s,c)=>s+c.usd.fx,0)))}</b></td>`).join("")}</tr>
    ${balRow("Остаток на конец","end","tot")}`;
  // По кошелькам: иерархия за весь период (раздел 9)
  const V = visibleWallets(); const allVis = visFacts().filter(f=>!F.cur || f.cur===F.cur);
  const wRows = visibleTree().filter(w=>!S || S.has(w.id)).map(w=>{
    const D = descendants(w.id); const lst = allVis.filter(f=>f.wallet && D.has(f.wallet) && V.has(f.wallet) && (!S || S.has(f.wallet)));
    const m = inCur ? "cur" : "usd"; const per = lst.filter(f=>f.date>=from && f.date<=to);
    const sumC = c => r2(per.filter(f=>f.cat===c).reduce((s,f)=>s+val(f,m),0));
    const start = balOf(lst, addDays(from,-1), m), end = balOf(lst, to, m);
    const r = {w, start, end, open:sumC("opening"), inn:sumC("in"), out:sumC("out"), tr:sumC("transfer"), int:sumC("internal")};
    r.fx = inCur ? 0 : r2(end - start - r.open - r.inn - r.out - r.tr - r.int);
    r.endUsd = inCur ? balOf(lst, to, "usd") : end;
    return r; });
  const curs = [...new Set([...DB.accounts,...DB.cashboxes].map(a=>a.cur))].filter(Boolean);
  const unit = inCur ? curCode(F.cur) : "USD";
  return `${repHeader("Фактический ДДС с остатками","ТР-38",`Поступления со знаком «+», расходы со знаком «−». Обороты в USD — по курсам ERP на даты операций, остатки — по курсу на конец шага; разница показана строкой «Курсовая разница» (ТР-58). При выборе валюты отчёт показывает суммы в валюте счёта и в USD (ТР-33).`)}
  ${emptyHint()}
  <div class="toolbar">
    <label class="fld"><span>Период с</span><input type="date" value="${from}" onchange="RF.rep38.from=this.value;render()"></label>
    <label class="fld"><span>по</span><input type="date" value="${to}" onchange="RF.rep38.to=this.value;render()"></label>
    <div class="fld"><span>Шаг</span><div class="seg">${[["day","День"],["week","Неделя"],["month","Месяц"]].map(([k,t])=>`<button type="button" class="${F.step===k?"on":""}" aria-pressed="${F.step===k}" onclick="RF.rep38.step='${k}';render()">${t}</button>`).join("")}</div></div>
    <label class="fld"><span>Валюта</span><select onchange="RF.rep38.cur=this.value;render()"><option value="">Все — в USD</option>${curs.map(c=>`<option value="${c}" ${F.cur===c?"selected":""}>${esc(curCode(c))} — в валюте и USD</option>`).join("")}</select></label>
    ${walletPicker("w38", F.wallets, "toggle38", {onClear:"RF.rep38.wallets=[];render()"})}
    <div class="fld"><span>Подчинённые</span><div class="chips">${chip(F.sub,"RF.rep38.sub=!RF.rep38.sub;render()","включать")}</div></div>
    <div class="grow"></div>
    ${exportBtn("t38","ДДС")}
  </div>
  ${B.length>=400?`<div class="alert warn">Слишком много колонок — показаны первые 400. Увеличьте шаг.</div>`:""}
  <div class="panel"><div class="body flush"><div class="tbl-wrap" style="max-height:none;overflow-x:auto"><table id="t38" class="sticky-first">
    <thead>${inCur?`<tr><th rowspan="2">Статья</th>${cols.map(c=>`<th class="num" colspan="2" style="text-align:center">${esc(c.b.label)}</th>`).join("")}<th class="num" colspan="2" style="text-align:center">Итого</th></tr>
      <tr>${[...cols,{}].map(()=>`<th class="num">${esc(unit)}</th><th class="num">USD</th>`).join("")}</tr>`
      : `<tr><th>Статья · USD</th>${cols.map(c=>`<th class="num">${esc(c.b.label)}</th>`).join("")}<th class="num">Итого</th></tr>`}</thead>
    <tbody>${body}</tbody></table></div></div></div>
  <div class="panel"><header><h2>По кошелькам за период</h2><span class="hint">${fmtD(from)} – ${fmtD(to)} · ${esc(unit)} · родитель включает подчинённые</span><div style="flex:1"></div>${exportBtn("t38w","ДДС по кошелькам")}</header>
  <div class="body flush"><div class="tbl-wrap" style="max-height:none"><table id="t38w">
    <thead><tr><th>Кошелёк</th><th class="num">Остаток на начало</th><th class="num">Ввод остатков</th><th class="num">Поступления</th><th class="num">Расходы</th><th class="num">Переброски</th><th class="num">Внутренние</th>${inCur?"":`<th class="num">Курсовая разница</th>`}<th class="num">Остаток на конец</th>${inCur?`<th class="num">Остаток на конец, USD</th>`:""}</tr></thead>
    <tbody>${wRows.map(r=>`<tr class="${r.w._lvl?"":"grp"}"><td><span class="tree-pad" style="width:${r.w._lvl*16}px"></span>${esc(r.w.name)}</td>
      <td class="num ${r.start<0?"neg":""}">${fmt(r.start)}</td><td class="num">${r.open?fmtS(r.open):""}</td><td class="num pos">${r.inn?fmtS(r.inn):""}</td><td class="num neg">${r.out?fmtS(r.out):""}</td>
      <td class="num">${r.tr?fmtS(r.tr):""}</td><td class="num">${r.int?fmtS(r.int):""}</td>${inCur?"":`<td class="num">${r.fx?fmtS(r.fx):""}</td>`}
      <td class="num ${r.end<0?"neg":""}"><b>${fmt(r.end)}</b></td>${inCur?`<td class="num ${r.endUsd<0?"neg":""}">${fmt(r.endUsd)}</td>`:""}</tr>`).join("") || `<tr><td colspan="10" class="muted">Нет кошельков</td></tr>`}</tbody></table></div></div></div>`;
}

/* ---------- ТР-40. Внутренние займы ---------- */
function loanRows(date){
  const V = visibleWallets(); const A = isAdmin(me());
  return DB.contracts.map(c=>{
    const ops = DB.ops.filter(o=>o.contract===c.id && !o.deleted && o.posted && opComplete(o) && o.date<=date && (o.kind==="loan"||o.kind==="repay"));
    const given = r2(ops.filter(o=>o.kind==="loan").reduce((s,o)=>s+opLegs(o)[0].usd,0));
    const repaid = r2(ops.filter(o=>o.kind==="repay").reduce((s,o)=>s+opLegs(o)[0].usd,0));
    return {c, ops, given, repaid, debt:r2(given-repaid)};
  }).filter(r=> A || V.has(r.c.lender) || V.has(r.c.borrower));
}
function viewRep40(){
  DRILLS = []; const F = RF.rep40; const date = repDate(F); const rows = loanRows(date);
  const tot = r2(rows.reduce((s,r)=>s+r.debt,0));
  return `${repHeader("Внутренние займы","ТР-40",`Задолженность между кошельками в USD на дату — по каждой паре кошельков и договору. Займы учитываются в USD по курсу каждой стороны, зафиксированному в операции (ТР-28). Проценты не начисляются (ТР-29).`)}
  <div class="toolbar">
    <label class="fld"><span>На дату</span><input type="date" value="${date}" onchange="RF.rep40.date=this.value;render()"></label>
    <div class="grow"></div>
    ${canEnter(me())?`<button class="btn" onclick="openContract(null)">Новый договор займа</button>`:""}
    ${exportBtn("t40","Внутренние займы")}
  </div>
  <div class="panel"><div class="body flush"><table id="t40" class="sortable">
    <thead><tr><th>Займодавец</th><th>Заёмщик</th><th>Договор</th><th class="num">Выдано, USD</th><th class="num">Погашено, USD</th><th class="num">Долг, USD</th></tr></thead>
    <tbody>${rows.map(r=>`<tr><td>${esc(nm(wal(r.c.lender)))}</td><td>${esc(nm(wal(r.c.borrower)))}</td>
      <td>${drillLink(()=>showOpsList(`Операции по договору «${r.c.name}»`, r.ops), esc(r.c.name))}</td>
      <td class="num">${fmt(r.given)}</td><td class="num">${fmt(r.repaid)}</td><td class="num ${r.debt>0?"":"muted"}"><b>${fmt(r.debt)}</b>${Math.abs(r.debt)<0.005&&r.ops.length?` <span class="tag ok">закрыт</span>`:""}</td></tr>`).join("")
      || `<tr><td colspan="6" class="muted">Договоров займа нет</td></tr>`}
      ${rows.length?`<tr class="tot"><td colspan="5">Итого долг</td><td class="num">${fmt(tot)}</td></tr>`:""}</tbody></table></div></div>`;
}
function showOpsList(title, ops){
  openModal({title:esc(title), drawer:true, width:1000, body:()=>`<table><thead><tr><th>Дата</th><th>Номер</th><th>Вид</th><th>Отправитель → получатель</th><th class="num">Сумма</th><th class="num">USD</th></tr></thead>
    <tbody>${ops.map(o=>{ const L = opLegs(o); return `<tr class="clickable" onclick="openOp('${o.id}')"><td>${fmtD(o.date)}</td><td><a class="lnk">${esc(o.no)}</a></td><td>${esc(OP_KINDS[o.kind].name)}</td>
      <td>${esc(nm(wal(o.from)))} → ${esc(nm(wal(o.to)))}</td><td class="num">${L.map(l=>`${fmt(l.sum)} ${esc(curCode(l.cur))}`).join("<br>")}</td><td class="num">${L.map(l=>fmt(l.usd)).join("<br>")}</td></tr>`; }).join("") || `<tr><td colspan="6" class="muted">Нет операций</td></tr>`}</tbody></table>`});
}

/* ---------- ТР-43. Сверка с 1С ---------- */
function viewRecon(){
  DRILLS = []; const u = me(); const V = visibleWallets(u);
  const all = isAdmin(u) || has(u,"owner");
  const rows = recon().filter(r => all || facts().some(f=>f.acc===r.acc && f.wallet && V.has(f.wallet)))
    .sort((a,b)=>(Math.abs(b.diff)>=0.005)-(Math.abs(a.diff)>=0.005) || nm(a.a).localeCompare(nm(b.a),"ru"));
  const badN = rows.filter(r=>Math.abs(r.diff)>=0.005).length;
  const okN = rows.length - badN; const badSum = {}; rows.forEach(r=>{ if(Math.abs(r.diff)>=0.005) badSum[r.cur]=(badSum[r.cur]||0)+r.diff; });
  const shownRows = RF.recon.bad ? rows.filter(r=>Math.abs(r.diff)>=0.005) : rows;
  const off = !DB.settings.recon1c;
  return `${off?`<div class="alert warn">Сверка с остатками 1С выключена: главный контроль — Daily Balance (раздел 7). Включится в «Период и настройки», когда в 1С появятся актуальные остатки (ТР-41…43). Расхождения ниже — справочно, уведомления не отправляются и дни не блокируются.</div>`:""}
  ${repHeader("Сверка с 1С","ТР-41…43",`Главный контроль: сумма всех кошельков на счёте или в кассе равна остатку в 1С. Остатки 1С загружаются файлом (ТР-65), сверка — на дату загруженных остатков. Работа не блокируется, но день без расхождений закрывается для правки (ТР-55).`)}
  ${rows.length?`<div class="summary">
    <div class="sum-item"><b>${rows.length}</b><span>счетов и касс сверено</span></div>
    <div class="sum-item"><b class="pos">${okN}</b><span>сходятся с 1С</span></div>
    <div class="sum-item ${badN?"alarm":""}"><b class="${badN?"neg":""}">${badN}</b><span>с расхождением${badN?`: <span class="nowrap notr">${Object.entries(badSum).map(([c,v])=>`${fmtS(r2(v))} ${esc(curCode(c))}`).join(", ")}</span>`:""}</span></div>
  </div>`:""}
  <div class="panel"><header><div class="chips">${chip(!RF.recon.bad,"RF.recon.bad=false;render()",`Все · ${rows.length}`)}${chip(RF.recon.bad,"RF.recon.bad=true;render()",`С расхождением · ${badN}`)}</div>
    <div style="flex:1"></div>${isAdmin(u)?`<button class="btn" onclick="IMP.tab='bal';go('import')">Загрузить остатки 1С</button>`:""}${exportBtn("tRec","Сверка")}</header>
  <div class="body flush"><div class="tbl-wrap" style="max-height:none"><table id="tRec" class="sortable">
    <thead><tr><th>Организация</th><th>Счёт или касса</th><th>Валюта позиции</th><th>Дата сверки</th><th class="num">Остаток в 1С</th><th class="num">Сумма кошельков</th><th class="num">Расхождение</th><th>Расхождение с</th><th></th></tr></thead>
    <tbody>${shownRows.map(r=>{ const bad = Math.abs(r.diff)>=0.005; const from = r.since || r.date;
      const lastOk = r.hist.filter(h=>h.date<from && Math.abs(h.diff)<0.005).map(h=>h.date).pop();
      return `<tr class="${bad?"bad":""}"><td>${esc(nm(org(r.org)))}</td><td>${esc(nm(r.a))}</td><td>${esc(curCode(r.cur))}</td><td>${fmtD(r.date)}</td>
      <td class="num">${fmt(r.c1)}</td><td class="num">${fmt(r.w)}</td><td class="num ${bad?"neg":""}"><b>${bad?fmtS(r.diff):"0,00"}</b></td>
      <td>${bad?fmtD(r.since):""}</td>
      <td class="row">${drillLink(()=>showFacts(`${nm(r.a)}: документы ${lastOk?"с "+fmtD(addDays(lastOk,1)):""} по ${fmtD(r.date)}`, f=>f.acc===r.acc && f.date<=r.date && (!lastOk || f.date>lastOk)), "документы")}
        ${drillLink(()=>showReconHist(r), "история")}</td></tr>`; }).join("") || `<tr><td colspan="9" class="muted">Остатки 1С ещё не загружены</td></tr>`}</tbody>
  </table></div></div></div>`;
}
function showReconHist(r){
  openModal({title:`История сверки · ${esc(nm(r.a))}`, drawer:true, width:760, body:()=>`<table><thead><tr><th>Дата</th><th class="num">1С</th><th class="num">Кошельки</th><th class="num">Расхождение</th></tr></thead>
    <tbody>${r.hist.slice().reverse().map(h=>`<tr class="${Math.abs(h.diff)>=0.005?"bad":""}"><td>${fmtD(h.date)}</td><td class="num">${fmt(h.c1)}</td><td class="num">${fmt(h.w)}</td><td class="num">${fmtS(h.diff)}</td></tr>`).join("")}</tbody></table>`});
}

/* ---------- Сводка ---------- */
function viewDash(){
  DRILLS = []; const u = me(); const A = isAdmin(u);
  const nf = notifications(u);
  const list = visFacts(); const bc = {}, bp = {}; list.forEach(f=>{ if(f.date<=CUR.date) bc[f.cur]=(bc[f.cur]||0)+f.sum; if((f.kp||f.date)<=CUR.date) bp[f.cur]=(bp[f.cur]||0)+f.sum; });
  const tot = usdOf(bc, CUR.date);
  const S = DB.settings;
  const steps = [
    [DB.orgs.length && (DB.accounts.length||DB.cashboxes.length), "Загрузить справочники 1С: организации, счета, кассы, валюты, курсы, типы расхода CF, подразделения, зоны", "import", "ТР-64"],
    [DB.wallets.length, "Создать кошельки и их иерархию, отметить головной кошелёк", "wallets", "раздел 4"],
    [DB.rules.length, "Настроить правила автозаполнения кошелька", "rules", "ТР-73"],
    [DB.users.length>1, "Завести пользователей, роли и кошельки", "users", "раздел 8"],
    [S.startDate, "Задать дату начала учёта по кошелькам", "settings", "ТР-20"],
    [DB.opening.length, "Ввести входящие остатки на дату начала", "opening", "ТР-21"],
    [DB.docs.some(d=>d.source==="file"), "Загрузить файл расходов (СБДС, РКО) из 1С", "import", "ТР-60"],
    [DB.bal1c.length, "Загрузить остатки счетов и касс 1С для сверки", "import", "ТР-65"],
  ];
  const done = steps.filter(s=>s[0]).length;
  // ---- первый запуск: пока нет данных, главное на экране — пошаговая настройка
  const noData = !list.length;
  if(noData && A && done < steps.length){
    const HELPS = [
      "Выгрузите из 1С файл со справочниками: организации, банковские счета, кассы, валюты и курсы к USD. Без них нельзя создать ни один документ.",
      "Кошельки — это «владельцы» денег внутри группы. Создайте их и выстройте иерархию: родитель включает подчинённые. Отметьте головной кошелёк.",
      "Правила раскладывают платежи из 1С по кошелькам автоматически — по организации, счёту, подразделению, типу расхода. Что не попало под правила, окажется в «Без кошелька».",
      "Заведите сотрудников, дайте им роли (казначей, руководитель и т.д.) и назначьте кошельки, которые они видят.",
      "С этой даты система начинает учёт. Документы раньше неё в расчёт не попадают.",
      "Введите, сколько денег каждого кошелька лежало на каждом счёте и в каждой кассе на дату начала учёта.",
      "Загрузите из 1С файл расходов (СБДС и РКО) — это основной поток данных.",
      "Загрузите остатки счетов и касс из 1С — система сверит их с суммой кошельков и покажет расхождения.",
    ];
    const cur = steps.findIndex(s=>!s[0]);
    return `<h1>Сводка</h1>
    <section class="wizard">
      <div class="wz-head"><div><span class="wz-kicker">Настройка системы · шаг ${cur+1} из ${steps.length}</span>
        <h2>${esc(steps[cur][1])}</h2></div>
        <div class="progress big" aria-label="Выполнено ${done} из ${steps.length}"><i style="width:${Math.round(done/steps.length*100)}%"></i></div></div>
      <p>${esc(HELPS[cur])} <span class="tzref">${steps[cur][3]}</span></p>
      <div class="row"><button type="button" class="btn primary lg" onclick="go('${steps[cur][2]}')">Перейти к этому шагу</button>
        <span class="muted">Когда шаг будет выполнен, он отметится здесь автоматически.</span></div>
    </section>
    <div class="panel"><header><h2>Все шаги</h2><span class="hint">${done} из ${steps.length} выполнено</span></header>
      <div class="body"><ol class="steps">${steps.map((s,i)=>`<li class="${s[0]?"done":""} ${i===cur?"current":""}"><span class="grow">${esc(s[1])} <span class="tzref">${s[3]}</span></span>${s[0]?`<span class="muted">готово</span>`:`<button class="btn sm ${i===cur?"primary":""}" onclick="go('${s[2]}')">Открыть</button>`}</li>`).join("")}</ol></div></div>`;
  }
  if(noData && !A){
    return `<h1>Сводка</h1>
    <section class="wizard"><h2>Данных пока нет</h2>
      <p>${visibleWallets(u).size ? "По вашим кошелькам ещё нет остатков и документов. Они появятся, когда администратор загрузит данные из 1С и введёт входящие остатки." : "Вам ещё не назначены кошельки. Обратитесь к администратору — он откроет доступ к нужным кошелькам."}</p></section>`;
  }
  // валюты: сумма в валюте и её эквивалент в USD
  const curRows = Object.entries(bc).filter(([c,v])=>Math.abs(v)>=0.005).map(([c,v])=>{ const k = rateAt(c,CUR.date); return {c, v:r2(v), usd:k?r2(v/k):NaN}; })
    .sort((a,b)=>(b.usd||0)-(a.usd||0));
  // кошельки верхнего уровня с долей в общем остатке
  const V = visibleWallets(u);
  const top = visibleTree().filter(w=>!w._lvl).map(w=>{ const D = descendants(w.id); const b = {}; list.forEach(f=>{ if(f.wallet && D.has(f.wallet) && V.has(f.wallet) && f.date<=CUR.date) b[f.cur]=(b[f.cur]||0)+f.sum; }); return {w, usd:usdOf(b,CUR.date).usd}; });
  const subs = visibleTree().filter(w=>w._lvl===1).map(w=>{ const D = descendants(w.id); const b = {}; list.forEach(f=>{ if(f.wallet && D.has(f.wallet) && V.has(f.wallet) && f.date<=CUR.date) b[f.cur]=(b[f.cur]||0)+f.sum; }); return {w, usd:usdOf(b,CUR.date).usd}; });
  // если наверху один головной кошелёк — показываем его подчинённые
  const wl = (top.length===1 && subs.length ? subs : top).sort((a,b)=>b.usd-a.usd);
  const maxW = Math.max(1, ...wl.map(x=>Math.abs(x.usd)));
  const noW = list.filter(f=>!f.wallet && f.date<=CUR.date); const noWb = {}; noW.forEach(f=>noWb[f.cur]=(noWb[f.cur]||0)+f.sum); const noWusd = usdOf(noWb,CUR.date).usd;
  const docsN = DB.docs.filter(d=>docCounts(d)).length, opsN = DB.ops.filter(o=>opCounts(o)).length, badN = badAccs().size, dbBad = nf.filter(n=>n.go==="dbrecon").length;
  const actions = canEnter(u) ? `<div class="quick">
      <button type="button" class="btn primary" onclick="newDoc('ПБДС')">Поступление на счёт</button>
      <button type="button" class="btn" onclick="newDoc('ПКО')">Поступление в кассу</button>
      <button type="button" class="btn" onclick="newDoc('ПЕР')">Конвертация или переброска</button>
      <button type="button" class="btn" onclick="newOp()">Внутренняя операция</button></div>` : "";
  return `<h1>Сводка</h1>
  <p class="lede">Калькулятор фактических остатков денег группы по кошелькам. Платежи ведутся в 1С ERP; здесь — кошельки, правила, входящие остатки, внутренние операции и, до запуска шлюза, ручной ввод поступлений и перебросок. Вы вошли как <b>${esc(u.name)}</b> (${u.roles.map(r=>`<span>${esc(ROLES[r])}</span>`).join(", ")}) — все экраны показывают только доступные вам кошельки.</p>
  ${actions}
  <section class="hero">
    <div class="hero-main">
      <span class="hero-label">Фактический остаток (Кф) доступных кошельков на ${fmtD(CUR.date)}</span>
      <b class="hero-sum ${tot.usd<0?"neg":""}">${fmt(tot.usd)}<small>USD</small></b>
      <span class="hero-label" title="Кп = Кф − исходящие в пути, подтверждённые казначеем">Плановый (Кп): <b>${fmt(usdOf(bp,CUR.date).usd)} USD</b></span>
      <div class="hero-links"><a class="lnk" onclick="go('rep37')">Открыть по кошелькам</a><a class="lnk" onclick="go('rep75')">Расположение ДС</a></div>
    </div>
    <table class="hero-cur"><thead><tr><th>Валюта</th><th class="num">Остаток</th><th class="num">В USD</th></tr></thead>
      <tbody>${curRows.map(r=>`<tr><td>${esc(curCode(r.c))}</td><td class="num ${r.v<0?"neg":""}">${fmt(r.v)}</td><td class="num">${fmt(r.usd)}</td></tr>`).join("") || `<tr><td colspan="3" class="hero-empty">Остатков пока нет</td></tr>`}</tbody></table>
  </section>
  ${tot.miss.length?`<div class="alert warn">Нет курса на ${fmtD(CUR.date)} для: ${esc(tot.miss.join(", "))} — эти суммы не вошли в USD.</div>`:""}
  <div class="dash-grid">
    <div class="panel"><header><h2>Требует внимания</h2>${nf.length?`<span class="count">${nf.length}</span>`:""}</header>
      <div class="body flush">${nf.length ? `<ul class="todo">${nf.map(n=>`<li class="${n.lvl}"><span class="todo-mark"></span><span class="todo-text">${esc(n.text)} <span class="tzref">${n.tr}</span></span><button type="button" class="btn sm" onclick="go('${n.go}')">Перейти</button></li>`).join("")}</ul>`
        : `<p class="empty">Всё в порядке: расхождений и неразнесённых строк нет.</p>`}</div></div>
    <div class="panel"><header><h2>Кошельки</h2><span class="hint">USD на ${fmtD(CUR.date)}</span><div style="flex:1"></div><a class="lnk" onclick="go('rep37')">Все</a></header>
      <div class="body flush"><ul class="wlist">${wl.map(x=>`<li onclick="RF.rep75.wallets=['${x.w.id}'];go('rep75')" title="Расположение ДС этого кошелька">
          <span class="wl-name">${esc(x.w.name)}</span><span class="num ${x.usd<0?"neg":""}">${fmt(x.usd)}</span>
          <span class="wl-bar"><i style="width:${Math.max(0,Math.round(Math.abs(x.usd)/maxW*100))}%" class="${x.usd<0?"n":""}"></i></span>
          <span class="wl-pct muted">${tot.usd?Math.round(x.usd/tot.usd*100):0}%</span></li>`).join("") || `<li class="empty">Кошельков нет</li>`}
        ${Math.abs(noWusd)>=0.005?`<li class="nowallet" onclick="go('nowallet')"><span class="wl-name">Без кошелька</span><span class="num ${noWusd<0?"neg":""}">${fmt(noWusd)}</span><span class="wl-bar"></span><span class="wl-pct"></span></li>`:""}</ul></div></div>
  </div>
  <div class="facts">
    <a class="fact" onclick="go('docs')"><b>${docsN}</b><span>документов в расчёте</span></a>
    <a class="fact" onclick="go('ops')"><b>${opsN}</b><span>внутренних операций</span></a>
    ${S.recon1c ? `<a class="fact" onclick="go('recon')"><b class="${badN?"neg":""}">${badN}</b><span>счетов с расхождением с 1С</span></a>`
      : allowedViews().has("dbrecon") ? `<a class="fact" onclick="go('dbrecon')"><b class="${dbBad?"neg":""}">${dbBad}</b><span>расхождений Daily Balance</span></a>` : ""}
    <div class="fact"><b>${S.closedTo?fmtD(S.closedTo):"—"}</b><span>период закрыт по</span></div>
  </div>
  ${A && done<steps.length ? `<div class="panel"><header><h2>Первичная настройка</h2><span class="hint">${done} из ${steps.length}</span>
      <div class="progress" aria-hidden="true"><i style="width:${Math.round(done/steps.length*100)}%"></i></div></header>
    <div class="body"><ol class="steps">${steps.map(s=>`<li class="${s[0]?"done":""}"><span class="grow">${esc(s[1])} <span class="tzref">${s[3]}</span></span>${s[0]?"":`<button class="btn sm" onclick="go('${s[2]}')">Открыть</button>`}</li>`).join("")}</ol></div></div>` : ""}
  ${!A ? `<div class="panel"><header><h2>Мои кошельки</h2></header><div class="body stack">
      <span>${[...visibleWallets(u)].map(id=>esc(nm(wal(id)))).join(", ") || `<span class="muted">не назначены — обратитесь к администратору</span>`}</span>
      <span class="muted">${canEnter(u)?"Можно вводить внутренние операции и ручные документы по своим кошелькам в открытом периоде.":"Только просмотр."}</span></div></div>` : ""}`;
}


/* ---------- ТР-83 → «Операции»: движения денег из отчёта ERP «История согласования» (правки 16.10) ---------- */
const OPS_COLS = [
  ["guid","GUID документа (ERP)", (d,l)=>`<code class="k">${esc(d.guid||"")}</code>`, (d,l)=>d.guid||""],
  ["no","Номер документа (ERP)", (d,l)=>`<a class="lnk">${esc(d.no1c||d.no||"—")}</a>`, (d,l)=>d.no1c||d.no||""],
  ["date","Дата документа (ERP)", (d,l)=>fmtD(d.date), (d,l)=>d.date, "nowrap"],
  ["usd","Сумма (USD)", (d,l)=>fmt(l.usd), (d,l)=>l.usd, "num"],
  ["cf","Тип расхода CF", (d,l)=>esc(refName(DB.cfTypes,l.cf)), (d,l)=>refName(DB.cfTypes,l.cf)],
  ["dept","Подразделение", (d,l)=>esc(refName(DB.depts,l.dept)), (d,l)=>refName(DB.depts,l.dept)],
  ["purpose","Заметки", (d,l)=>esc(l.purpose||""), (d,l)=>l.purpose||""],
  ["cpty","Получатель", (d,l)=>esc(l.cpty||""), (d,l)=>l.cpty||""],
  ["org","Организация", (d,l)=>esc(nm(org(d.org))), (d,l)=>nm(org(d.org))],
  ["bank","Банк", (d,l)=>esc(d.bankName || (acc(d.acc)||{}).bank || ""), (d,l)=>d.bankName||(acc(d.acc)||{}).bank||""],
  ["accNo","Р/сч", (d,l)=>esc(d.accNo || nm(acc(d.acc))), (d,l)=>d.accNo||nm(acc(d.acc))],
  ["cur","Валюта", (d,l)=>esc(curCode(d.cur)), (d,l)=>curCode(d.cur)],
  ["sum","Сумма в валюте документа", (d,l)=>fmt(l.sum), (d,l)=>l.sum, "num"],
  ["rate","Курс", (d,l)=>d.rate?fmtRate(d.rate):"", (d,l)=>d.rate||"", "num"],
  ["bankDate","Дата проведения банком", (d,l)=>d.bankDate?fmtD(d.bankDate):"", (d,l)=>d.bankDate||"", "nowrap"],
  ["op","Хозяйственная операция", (d,l)=>esc(d.op||""), (d,l)=>d.op||""],
  ["erpType","Тип документа ERP", (d,l)=>esc(d.erpType||""), (d,l)=>d.erpType||""],
  ["wallet","Кошелёк (приложение)", (d,l)=>l.wallet?esc(nm(wal(l.wallet))):`<span class="tag warn">без кошелька</span>`, (d,l)=>l.wallet?nm(wal(l.wallet)):"без кошелька"],
  ["state","Учёт (приложение)", (d,l)=>opsAccount(d), (d,l)=>stripTags(opsAccount(d))],
];
const OPS_DEF = ["no","date","org","bank","accNo","cur","sum","usd","cpty","dept","cf","bankDate","wallet","state"];
let OPSCFG; try{ OPSCFG = JSON.parse(localStorage.getItem("wallets-opscols")||"null"); }catch(e){ OPSCFG = null; }
if(!Array.isArray(OPSCFG) || !OPSCFG.length) OPSCFG = OPS_COLS.map(c=>({k:c[0], on:OPS_DEF.includes(c[0])})).sort((a,b)=>(OPS_DEF.indexOf(a.k)+1||99)-(OPS_DEF.indexOf(b.k)+1||99));
OPS_COLS.forEach(c=>{ if(!OPSCFG.some(x=>x.k===c[0])) OPSCFG.push({k:c[0], on:false}); });
function saveOpsCfg(){ try{ localStorage.setItem("wallets-opscols", JSON.stringify(OPSCFG)); }catch(e){} }
function opsAccount(d){   // ТР-07: участие в Кф и Кп
  const st = docState(d);
  if(st!=="posted") return docStateTag(d);
  if(d.type!=="СБДС") return `<span class="tag ok">в Кф</span>`;
  if(d.bankDate) return `<span class="tag ok" title="Исполнен банком ${fmtD(d.bankDate)}">в Кф</span>`;
  return d.sentConf ? `<span class="tag info" title="Казначей подтвердил отправку">в Кп (Писх)</span>` : `<span class="tag warn" title="Банк не исполнил, казначей не подтвердил отправку">не исполнен банком</span>`;
}
function openOpsForm(){
  openModal({title:"Настроить форму", width:560, body:()=>`<p class="muted">Отметьте колонки, которые нужно показывать, и расставьте их стрелками. Настройка запоминается в этом браузере.</p>
    <table class="mini" style="width:100%"><tbody>${OPSCFG.map((c,i)=>{ const col = OPS_COLS.find(x=>x[0]===c.k); return col ? `<tr><td><label class="chk"><input type="checkbox" ${c.on?"checked":""} onchange="OPSCFG[${i}].on=this.checked;saveOpsCfg();render();refreshModal()"> ${esc(col[1])}</label></td>
      <td class="num nowrap"><button class="btn sm ghost" ${i?"":"disabled"} onclick="opsMove(${i},-1)" aria-label="Выше">↑</button><button class="btn sm ghost" ${i<OPSCFG.length-1?"":"disabled"} onclick="opsMove(${i},1)" aria-label="Ниже">↓</button></td></tr>` : ""; }).join("")}</tbody></table>`,
    footer:()=>`<button class="btn ghost" style="margin-right:auto" onclick="OPSCFG=OPS_COLS.map(c=>({k:c[0],on:OPS_DEF.includes(c[0])})).sort((a,b)=>(OPS_DEF.indexOf(a.k)+1||99)-(OPS_DEF.indexOf(b.k)+1||99));saveOpsCfg();render();refreshModal()">Как было</button><button class="btn primary" onclick="closeModal()">Готово</button>`});
}
function opsMove(i, d){ const j = i+d; [OPSCFG[i], OPSCFG[j]] = [OPSCFG[j], OPSCFG[i]]; saveOpsCfg(); render(); refreshModal(); }
function histDocs(){
  const F = RF.hist; const q = norm(F.cpty);
  return DB.docs.filter(d=>d.source==="file" && (d.type==="СБДС"||d.type==="РКО")).filter(d=>
    (!F.from || d.date>=F.from) && (!F.to || d.date<=F.to) && (!F.org || d.org===F.org)
    && (!F.dept || d.lines.some(l=>l.dept===F.dept)) && (!q || d.lines.some(l=>norm(l.cpty).includes(q))))
    .sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0);
}
function opsMatch(d, l, q){   // поиск: номер ERP, сумма (с разделителями или без), получатель, заметки, GUID
  if(!q) return true;
  const n = parseNum(q);
  if(isFinite(n) && n>0 && /^[\d\s.,−-]+$/.test(q)){ const t = r2(Math.abs(n)); if([l.sum, l.usd, d.docSum].some(v=>v!=null && Math.abs(r2(v)-t)<0.005)) return true; }
  return norm([d.no1c, d.no, d.guid, l.cpty, l.purpose, d.op, nm(org(d.org)), d.accNo, d.bankName].join(" ")).includes(norm(q));
}
function viewHist(){
  const F = RF.hist; const docs = histDocs(); const cols = OPSCFG.filter(c=>c.on).map(c=>OPS_COLS.find(x=>x[0]===c.k)).filter(Boolean);
  const rows = []; docs.forEach(d=>d.lines.forEach(l=>{ if(lineVisible(l.wallet) && opsMatch(d, l, F.q||"")) rows.push([d,l]); }));
  const shown = rows.slice(0, 2000);
  return `<h1>Операции <span class="tzref">ТР-83</span></h1>
  <p class="lede">Движения денег из отчёта ERP «История согласования» за период — по строке на каждую строку расшифровки. Само наличие документа в отчёте движения не создаёт: в фактический остаток (Кф) СБДС входит после исполнения банком, в плановый (Кп) — после подтверждения казначеем (ТР-07). Колонки настраиваются кнопкой «Настроить форму».</p>
  <div class="toolbar">
    <label class="fld" style="min-width:260px"><span>Поиск</span><input type="search" value="${esc(F.q||"")}" placeholder="номер ERP, сумма, получатель…" onchange="RF.hist.q=this.value;render()"></label>
    <label class="fld"><span>Период с</span><input type="date" value="${F.from}" onchange="RF.hist.from=this.value;render()"></label>
    <label class="fld"><span>по</span><input type="date" value="${F.to}" onchange="RF.hist.to=this.value;render()"></label>
    <label class="fld"><span>Организация</span><select onchange="RF.hist.org=this.value;render()">${opts(DB.orgs,F.org,{empty:"Все организации"})}</select></label>
    <label class="fld"><span>Подразделение</span><select onchange="RF.hist.dept=this.value;render()">${optsTree(DB.depts,F.dept,"Все подразделения")}</select></label>
    <label class="fld"><span>Получатель</span><input type="search" value="${esc(F.cpty)}" placeholder="часть названия" onchange="RF.hist.cpty=this.value;render()"></label>
    <div class="grow"></div>
    <button type="button" class="btn" onclick="openOpsForm()">Настроить форму</button>
    ${exportBtn("tHist","Операции")}
  </div>
  <div class="panel"><header><h2>${rows.length} ${plural(rows.length,"строка","строки","строк")} · ${docs.length} ${plural(docs.length,"документ","документа","документов")}</h2>${rows.length>2000?`<span class="hint">показаны первые 2000</span>`:""}</header>
  <div class="body flush"><div class="tbl-wrap"><table id="tHist" class="list-t sortable"><thead><tr>${cols.map(c=>`<th class="${c[4]==="num"?"num":""}">${esc(c[1])}</th>`).join("")}</tr></thead>
  <tbody>${shown.map(([d,l])=>`<tr class="clickable ${docRowClass(d)}" onclick="openDoc('${d.id}')">${cols.map(c=>`<td class="${c[4]||""}">${c[2](d,l)}</td>`).join("")}</tr>`).join("")
    || `<tr><td colspan="${cols.length||1}" class="empty-cell">${DB.docs.some(d=>d.source==="file")?"Под фильтры и поиск не попала ни одна строка.":"Документов нет. Загрузите файл «История согласования» в разделе «Загрузка файлов»."}</td></tr>`}</tbody></table></div></div></div>`;
}
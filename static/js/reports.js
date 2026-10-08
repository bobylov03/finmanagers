"use strict";
/* ============================================================
   11. ОТЧЁТЫ (раздел 9)
   ============================================================ */
const RF = {
  rep37:{date:"", byOrg:false, byAcc:false, byCur:true, zero:false},
  rep75:{date:"", wallets:[], sub:true},
  rep38:{from:"", to:"", step:"month", wallets:[], sub:true, cur:""},
  rep40:{date:""},
  recon:{},
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
  const list = visFacts().filter(pred).sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
  const byCur = {}; list.forEach(f=>byCur[f.cur]=(byCur[f.cur]||0)+f.sum);
  openModal({title:esc(title), width:1180, body:()=>`
    <div class="row" style="margin-bottom:8px">${Object.entries(byCur).map(([c,v])=>`<span class="tag">${fmtS(r2(v))} ${esc(curCode(c))}</span>`).join(" ")}
      <span class="muted">${list.length} записей</span><div style="flex:1"></div>
      <button class="btn sm" onclick="exportTable('factsTbl','Документы')">Выгрузить в Excel</button></div>
    <div class="tbl-wrap"><table id="factsTbl"><thead><tr><th>Дата</th><th>Документ</th><th>Организация</th><th>Счёт или касса</th><th>Кошелёк</th><th>Тип расхода CF / вид</th><th class="num">Сумма</th><th>Вал.</th><th class="num">USD</th></tr></thead>
    <tbody>${list.map(f=>`<tr class="clickable" onclick="openSrc('${f.src.k}','${f.src.id}')">
      <td>${fmtD(f.date)}</td><td><a class="lnk">${esc(srcTitle(f))}</a></td><td>${esc(nm(org(f.org)))}</td><td>${esc(nm(acc(f.acc)))}</td>
      <td>${f.wallet?esc(nm(wal(f.wallet))):`<span class="tag warn">без кошелька</span>`}</td>
      <td>${f.cat==="internal"?esc(OP_KINDS[f.kind].name):f.cat==="transfer"?esc(f.op):f.cat==="opening"?"Входящий остаток":esc(refName(DB.cfTypes,f.cf))}</td>
      <td class="num ${f.sum<0?"neg":"pos"}">${fmtS(f.sum)}</td><td>${esc(curCode(f.cur))}</td><td class="num ${f.usd<0?"neg":""}">${fmtS(f.usd)}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">Нет записей</td></tr>`}</tbody></table></div>`});
}
function repHeader(title, tr, lede, tableId){
  return `<h1>${esc(title)} <span class="tzref">${tr}</span></h1><p class="lede">${lede}</p>`;
}
function exportBtn(tableId, name){ return `<button class="btn" onclick="exportTable('${tableId}','${jsq(name)}')">Выгрузить в Excel</button>`; }
function emptyHint(){
  if(DB.wallets.length && facts().length) return "";
  return `<div class="alert warn">Данных пока нет. ${isAdmin(me())?`Начните с раздела <a class="lnk" onclick="go('dash')">Сводка</a> — там порядок первичной настройки.`:"Обратитесь к администратору."}</div>`;
}

/* ---------- ТР-37. Деньги по кошелькам на дату ---------- */
function viewRep37(){
  DRILLS = []; const F = RF.rep37; const date = repDate(F);
  const list = visFacts(); const bad = badAccs();
  const keyOf = f => [F.byOrg?f.org:"", F.byAcc?f.acc:"", (F.byCur||F.byAcc)?f.cur:""].join("|");
  const split = F.byOrg || F.byAcc || F.byCur;
  const agg = pred => { const byCur={}, nb={}, parts=new Map(); let neg=false, hasBad=false;
    list.forEach(f=>{ if(f.date>date || !pred(f)) return;
      byCur[f.cur]=(byCur[f.cur]||0)+f.sum; if(f.notBank) nb[f.cur]=(nb[f.cur]||0)+f.sum;
      if(bad.has(f.acc)) hasBad = true;
      if(split){ const k = keyOf(f); let p = parts.get(k); if(!p){ p={org:f.org, acc:f.acc, cur:f.cur, sum:0, nb:0}; parts.set(k,p);} p.sum+=f.sum; if(f.notBank) p.nb+=f.sum; } });
    // отрицательный остаток на уровне кошелёк × счёт × валюта (ТР-24)
    const cell = balances(date, list.filter(pred)); cell.forEach(r=>{ if(r.sum < -0.005) neg = true; });
    return {byCur, usd:usdOf(byCur,date), nb:usdOf(nb,date).usd, parts:[...parts.values()], neg, hasBad}; };
  const rows = []; const V = visibleWallets();
  visibleTree().forEach(w=>{
    const S = descendants(w.id); const a = agg(f=>f.wallet && S.has(f.wallet) && V.has(f.wallet));
    rows.push({w, a, pred:f=>f.wallet && S.has(f.wallet)});
  });
  const noW = seesNoWallet(me()) ? agg(f=>!f.wallet) : null;
  const tot = agg(()=>true);
  const curList = bc => Object.entries(bc).filter(([c,v])=>Math.abs(v)>=0.005).map(([c,v])=>`<span class="${v<0?"neg":""}">${fmt(r2(v))}&nbsp;${esc(curCode(c))}</span>`).join("<br>") || `<span class="muted">0</span>`;
  const partRows = (a, pred, lvl) => a.parts.filter(p=>F.zero || Math.abs(p.sum)>=0.005).sort((x,y)=>(nm(org(x.org))+nm(acc(x.acc))).localeCompare(nm(org(y.org))+nm(acc(y.acc)),"ru")).map(p=>{
    const k = rateAt(p.cur,date); const usd = k ? r2(p.sum/k) : NaN;
    const label = [F.byOrg?nm(org(p.org)):"", F.byAcc?nm(acc(p.acc)):"", (F.byCur||F.byAcc)?curCode(p.cur):""].filter(Boolean).join(" · ");
    const isBad = F.byAcc && bad.has(p.acc);
    return `<tr class="${isBad?"bad":""}"><td style="padding-left:${lvl*18+26}px" class="muted">${drillLink(()=>showFacts(label, f=>pred(f) && f.date<=date && (!F.byOrg||f.org===p.org) && (!F.byAcc||f.acc===p.acc) && (!(F.byCur||F.byAcc)||f.cur===p.cur)), esc(label))}
      ${isBad?` <span class="tag off" title="ТР-42">расхождение со сверкой</span>`:""}</td>
      <td class="num ${p.sum<0?"neg":""}">${fmt(r2(p.sum))} ${esc(curCode(p.cur))}</td><td class="num ${usd<0?"neg":""}">${fmt(usd)}</td><td class="num">${p.nb?fmt(r2(p.nb/(k||1))):""}</td></tr>`;
  }).join("");
  const line = (label, a, pred, lvl, cls="") => `<tr class="${cls}">
      <td style="padding-left:${lvl*18+9}px">${drillLink(()=>showFacts(label, f=>pred(f) && f.date<=date), esc(label))}
        ${a.neg?` <span class="tag off">есть минус</span>`:""}${a.hasBad?` <span class="tag off" title="ТР-42">счёт с расхождением</span>`:""}${a.usd.miss.length?` <span class="tag warn">нет курса ${esc(a.usd.miss.join(", "))}</span>`:""}</td>
      <td class="num">${curList(a.byCur)}</td><td class="num ${a.usd.usd<0?"neg":""}">${fmt(a.usd.usd)}</td><td class="num">${a.nb?fmt(a.nb):""}</td></tr>` + (split ? partRows(a,pred,lvl) : "");
  return `${repHeader("Деньги по кошелькам на дату","ТР-37",`Остаток каждого кошелька по иерархии: родитель включает подчинённые. Остаток в USD = остаток в валюте ÷ курс ERP на дату отчёта (ТР-58). Нажмите строку, чтобы перейти к документам.`)}
  ${emptyHint()}
  <div class="panel"><div class="body filters">
    <label class="fld"><span>На дату</span><input type="date" value="${date}" onchange="RF.rep37.date=this.value;render()"></label>
    <div class="fld"><span>Разрезы</span><div class="row">
      <label class="chk"><input type="checkbox" ${F.byOrg?"checked":""} onchange="RF.rep37.byOrg=this.checked;render()"> юрлицо</label>
      <label class="chk"><input type="checkbox" ${F.byAcc?"checked":""} onchange="RF.rep37.byAcc=this.checked;render()"> счёт или касса</label>
      <label class="chk"><input type="checkbox" ${F.byCur?"checked":""} onchange="RF.rep37.byCur=this.checked;render()"> валюта</label>
      <label class="chk"><input type="checkbox" ${F.zero?"checked":""} onchange="RF.rep37.zero=this.checked;render()"> нулевые строки</label></div></div>
    <div style="flex:1"></div>
    ${exportBtn("t37","Деньги по кошелькам")}
  </div></div>
  <div class="panel"><div class="body flush"><div class="tbl-wrap" style="max-height:none"><table id="t37">
    <thead><tr><th>Кошелёк</th><th class="num">Остаток в валюте</th><th class="num">Остаток, USD</th><th class="num" title="ТР-09">в т.ч. не исполнено банком, USD</th></tr></thead>
    <tbody>
      ${rows.map(r=>line(r.w.name, r.a, r.pred, r.w._lvl, r.w._lvl?"":"grp")).join("") || `<tr><td colspan="4" class="muted">Нет доступных кошельков</td></tr>`}
      ${noW ? line("Без кошелька", noW, f=>!f.wallet, 0, "grp") : ""}
      <tr class="tot"><td>Итого</td><td class="num">${curList(tot.byCur)}</td><td class="num ${tot.usd.usd<0?"neg":""}">${fmt(tot.usd.usd)}</td><td class="num">${tot.nb?fmt(tot.nb):""}</td></tr>
    </tbody></table></div></div></div>`;
}

/* ---------- ТР-75. Где лежат деньги ---------- */
function toggle75(id,on){ const a = RF.rep75.wallets; RF.rep75.wallets = on ? [...new Set([...a,id])] : a.filter(x=>x!==id); render(); }
function viewRep75(){
  DRILLS = []; const F = RF.rep75; const date = repDate(F);
  const sel = new Set(); F.wallets.forEach(id=>{ (F.sub?descendants(id):new Set([id])).forEach(x=>{ if(visibleWallets().has(x)) sel.add(x); }); });
  const list = visFacts().filter(f=>f.wallet && sel.has(f.wallet) && f.date<=date);
  const m = new Map();
  list.forEach(f=>{ const k = f.org+"|"+f.acc+"|"+f.cur; let r = m.get(k); if(!r){ r={org:f.org, acc:f.acc, cur:f.cur, sum:0, nb:0, byW:{}}; m.set(k,r);} r.sum+=f.sum; if(f.notBank) r.nb+=f.sum; r.byW[f.wallet]=(r.byW[f.wallet]||0)+f.sum; });
  const rows = [...m.values()].filter(r=>Math.abs(r.sum)>=0.005);
  const bad = badAccs();
  const orgs = [...new Set(rows.map(r=>r.org))].sort((a,b)=>nm(org(a)).localeCompare(nm(org(b)),"ru"));
  let grand = 0; const missing = new Set();
  const body = orgs.map(o=>{
    const rs = rows.filter(r=>r.org===o).sort((a,b)=>nm(acc(a.acc)).localeCompare(nm(acc(b.acc)),"ru"));
    let sub = 0;
    const html = rs.map(r=>{ const k = rateAt(r.cur,date); const usd = k?r2(r.sum/k):NaN; if(k) sub += r.sum/k; else missing.add(curCode(r.cur));
      const a = acc(r.acc);
      return `<tr class="${bad.has(r.acc)?"bad":""}"><td style="padding-left:26px">${drillLink(()=>showFacts(nm(a), f=>f.wallet&&sel.has(f.wallet)&&f.acc===r.acc&&f.cur===r.cur&&f.date<=date), esc(nm(a)))}
        <span class="muted">${a?esc(a.kind==="Касса"?"касса":(a.accType||"счёт").toLowerCase()):""}</span>${bad.has(r.acc)?` <span class="tag off">расхождение</span>`:""}</td>
        <td>${esc(curCode(r.cur))}</td><td class="num ${r.sum<0?"neg":""}">${fmt(r2(r.sum))}</td><td class="num ${usd<0?"neg":""}">${fmt(usd)}</td>
        <td class="muted" style="font-size:11px">${Object.entries(r.byW).filter(([w,v])=>Math.abs(v)>=0.005).map(([w,v])=>`${esc(nm(wal(w)))}: ${fmt(r2(v))}`).join("; ")}</td></tr>`; }).join("");
    grand += sub;
    return `<tr class="grp"><td colspan="3">${esc(nm(org(o)))}</td><td class="num">${fmt(r2(sub))}</td><td></td></tr>` + html;
  }).join("");
  return `${repHeader("Где лежат деньги","ТР-75",`Выберите один или несколько кошельков — отчёт покажет, в каких компаниях, на каких счетах и кассах и в какой валюте лежат их деньги.`)}
  ${emptyHint()}
  <div class="panel"><div class="body filters">
    <div class="fld"><span>Кошельки</span>${walletChecklist(F.wallets,"toggle75")}</div>
    <div class="stack">
      <label class="fld"><span>На дату</span><input type="date" value="${date}" onchange="RF.rep75.date=this.value;render()"></label>
      <label class="chk"><input type="checkbox" ${F.sub?"checked":""} onchange="RF.rep75.sub=this.checked;render()"> включая подчинённые кошельки</label>
      <div class="row"><button class="btn sm" onclick="RF.rep75.wallets=[...visibleWallets()].filter(id=>!wal(id).parent||!visibleWallets().has(wal(id).parent));render()">Выбрать все</button>
      <button class="btn sm" onclick="RF.rep75.wallets=[];render()">Снять</button></div>
    </div>
    <div style="flex:1"></div>
    ${exportBtn("t75","Где лежат деньги")}
  </div></div>
  ${missing.size?`<div class="alert warn">Нет курса на ${fmtD(date)} для: ${esc([...missing].join(", "))}. Загрузите курсы из 1С.</div>`:""}
  <div class="panel"><div class="body flush"><div class="tbl-wrap" style="max-height:none"><table id="t75">
    <thead><tr><th>Компания / счёт или касса</th><th>Валюта</th><th class="num">Остаток в валюте</th><th class="num">Остаток, USD</th><th>В т.ч. по кошелькам</th></tr></thead>
    <tbody>${F.wallets.length ? (body || `<tr><td colspan="5" class="muted">У выбранных кошельков нет остатков на ${fmtD(date)}</td></tr>`) : `<tr><td colspan="5" class="muted">Выберите кошельки слева</td></tr>`}
    ${F.wallets.length && body ? `<tr class="tot"><td colspan="3">Итого, USD</td><td class="num ${grand<0?"neg":""}">${fmt(r2(grand))}</td><td></td></tr>`:""}</tbody>
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
  const cellRow = (label, pred, {cls="", pad=0}={}) => `<tr class="${cls}"><td style="padding-left:${9+pad}px">${esc(label)}</td>${cols.map(c=>modes.map(m=>{ const v = sumBy(c.b,pred,m);
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
  <div class="panel"><div class="body filters">
    <label class="fld"><span>Период с</span><input type="date" value="${from}" onchange="RF.rep38.from=this.value;render()"></label>
    <label class="fld"><span>по</span><input type="date" value="${to}" onchange="RF.rep38.to=this.value;render()"></label>
    <label class="fld"><span>Шаг</span><select onchange="RF.rep38.step=this.value;render()">${[["day","День"],["week","Неделя"],["month","Месяц"]].map(([k,t])=>`<option value="${k}" ${F.step===k?"selected":""}>${t}</option>`).join("")}</select></label>
    <label class="fld"><span>Валюта</span><select onchange="RF.rep38.cur=this.value;render()"><option value="">Все валюты — в USD</option>${curs.map(c=>`<option value="${c}" ${F.cur===c?"selected":""}>${esc(curCode(c))} — в валюте и в USD</option>`).join("")}</select></label>
    <div class="fld"><span>Кошельки (пусто — все доступные)</span>${walletChecklist(F.wallets,"toggle38")}
      <label class="chk"><input type="checkbox" ${F.sub?"checked":""} onchange="RF.rep38.sub=this.checked;render()"> включая подчинённые</label></div>
    <div style="flex:1"></div>
    ${exportBtn("t38","ДДС")}
  </div></div>
  ${B.length>=400?`<div class="alert warn">Слишком много колонок — показаны первые 400. Увеличьте шаг.</div>`:""}
  <div class="panel"><div class="body flush"><div class="tbl-wrap" style="max-height:none;overflow-x:auto"><table id="t38">
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
  <div class="panel"><div class="body filters">
    <label class="fld"><span>На дату</span><input type="date" value="${date}" onchange="RF.rep40.date=this.value;render()"></label>
    <div style="flex:1"></div>
    ${canEnter(me())?`<button class="btn" onclick="openContract(null)">Новый договор займа</button>`:""}
    ${exportBtn("t40","Внутренние займы")}
  </div></div>
  <div class="panel"><div class="body flush"><table id="t40">
    <thead><tr><th>Займодавец</th><th>Заёмщик</th><th>Договор</th><th class="num">Выдано, USD</th><th class="num">Погашено, USD</th><th class="num">Долг, USD</th></tr></thead>
    <tbody>${rows.map(r=>`<tr><td>${esc(nm(wal(r.c.lender)))}</td><td>${esc(nm(wal(r.c.borrower)))}</td>
      <td>${drillLink(()=>showOpsList(`Операции по договору «${r.c.name}»`, r.ops), esc(r.c.name))}</td>
      <td class="num">${fmt(r.given)}</td><td class="num">${fmt(r.repaid)}</td><td class="num ${r.debt>0?"":"muted"}"><b>${fmt(r.debt)}</b>${Math.abs(r.debt)<0.005&&r.ops.length?` <span class="tag ok">закрыт</span>`:""}</td></tr>`).join("")
      || `<tr><td colspan="6" class="muted">Договоров займа нет</td></tr>`}
      ${rows.length?`<tr class="tot"><td colspan="5">Итого долг</td><td class="num">${fmt(tot)}</td></tr>`:""}</tbody></table></div></div>`;
}
function showOpsList(title, ops){
  openModal({title:esc(title), width:1000, body:()=>`<table><thead><tr><th>Дата</th><th>Номер</th><th>Вид</th><th>Отправитель → получатель</th><th class="num">Сумма</th><th class="num">USD</th></tr></thead>
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
  return `${repHeader("Сверка с 1С","ТР-41…43",`Главный контроль: сумма всех кошельков на счёте или в кассе равна остатку в 1С. Остатки 1С загружаются файлом (ТР-65), сверка — на дату загруженных остатков. Работа не блокируется, но день без расхождений закрывается для правки (ТР-55).`)}
  <div class="panel"><header><h2>${rows.length} счетов и касс</h2>${badN?`<span class="tag off">с расхождением: ${badN}</span>`:rows.length?`<span class="tag ok">расхождений нет</span>`:""}
    <div style="flex:1"></div>${isAdmin(u)?`<button class="btn" onclick="IMP.tab='bal';go('import')">Загрузить остатки 1С</button>`:""}${exportBtn("tRec","Сверка")}</header>
  <div class="body flush"><div class="tbl-wrap" style="max-height:none"><table id="tRec">
    <thead><tr><th>Организация</th><th>Счёт или касса</th><th>Вал.</th><th>Дата сверки</th><th class="num">Остаток в 1С</th><th class="num">Сумма кошельков</th><th class="num">Расхождение</th><th>Расхождение с</th><th></th></tr></thead>
    <tbody>${rows.map(r=>{ const bad = Math.abs(r.diff)>=0.005; const from = r.since || r.date;
      const lastOk = r.hist.filter(h=>h.date<from && Math.abs(h.diff)<0.005).map(h=>h.date).pop();
      return `<tr class="${bad?"bad":""}"><td>${esc(nm(org(r.org)))}</td><td>${esc(nm(r.a))}</td><td>${esc(curCode(r.cur))}</td><td>${fmtD(r.date)}</td>
      <td class="num">${fmt(r.c1)}</td><td class="num">${fmt(r.w)}</td><td class="num ${bad?"neg":""}"><b>${bad?fmtS(r.diff):"0,00"}</b></td>
      <td>${bad?fmtD(r.since):""}</td>
      <td class="row">${drillLink(()=>showFacts(`${nm(r.a)}: документы ${lastOk?"с "+fmtD(addDays(lastOk,1)):""} по ${fmtD(r.date)}`, f=>f.acc===r.acc && f.date<=r.date && (!lastOk || f.date>lastOk)), "документы")}
        ${drillLink(()=>showReconHist(r), "история")}</td></tr>`; }).join("") || `<tr><td colspan="9" class="muted">Остатки 1С ещё не загружены</td></tr>`}</tbody>
  </table></div></div></div>`;
}
function showReconHist(r){
  openModal({title:`История сверки · ${esc(nm(r.a))}`, width:760, body:()=>`<table><thead><tr><th>Дата</th><th class="num">1С</th><th class="num">Кошельки</th><th class="num">Расхождение</th></tr></thead>
    <tbody>${r.hist.slice().reverse().map(h=>`<tr class="${Math.abs(h.diff)>=0.005?"bad":""}"><td>${fmtD(h.date)}</td><td class="num">${fmt(h.c1)}</td><td class="num">${fmt(h.w)}</td><td class="num">${fmtS(h.diff)}</td></tr>`).join("")}</tbody></table>`});
}

/* ---------- Сводка ---------- */
function viewDash(){
  DRILLS = []; const u = me(); const A = isAdmin(u);
  const nf = notifications(u);
  const list = visFacts(); const bc = {}; list.forEach(f=>{ if(f.date<=CUR.date) bc[f.cur]=(bc[f.cur]||0)+f.sum; });
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
  return `<h1>Сводка</h1>
  <p class="lede">Калькулятор фактических остатков денег группы по кошелькам. Платежи ведутся в 1С ERP; здесь — кошельки, правила, входящие остатки, внутренние операции и, до запуска шлюза, ручной ввод поступлений и перебросок. Вы вошли как <b>${esc(u.name)}</b> (${u.roles.map(r=>`<span>${esc(ROLES[r])}</span>`).join(", ")}) — все экраны показывают только доступные вам кошельки.</p>
  <div class="panel"><div class="stats">
    <div class="stat"><b class="${tot.usd<0?"neg":""}">${fmt(tot.usd)}</b><span>Остаток доступных кошельков, USD на ${fmtD(CUR.date)}</span></div>
    <div class="stat"><b>${visibleWallets(u).size}</b><span>доступных кошельков</span></div>
    <div class="stat"><b>${DB.docs.filter(d=>docCounts(d)).length}</b><span>документов в расчёте</span></div>
    <div class="stat"><b>${DB.ops.filter(o=>opCounts(o)).length}</b><span>внутренних операций</span></div>
    <div class="stat"><b class="${badAccs().size?"neg":""}">${badAccs().size}</b><span>счетов с расхождением</span></div>
  </div></div>
  ${tot.miss.length?`<div class="alert warn">Нет курса на ${fmtD(CUR.date)} для: ${esc(tot.miss.join(", "))} — эти суммы не вошли в USD.</div>`:""}
  <div class="split">
    <div class="panel"><header><h2>Уведомления</h2><span class="hint">для текущего пользователя</span></header>
      <div class="body">${nf.length ? nf.map(n=>`<div class="alert ${n.lvl}" style="cursor:pointer" onclick="go('${n.go}')">${esc(n.text)} <span class="tzref">${n.tr}</span></div>`).join("") : `<p class="muted" style="margin:0">Нет уведомлений.</p>`}</div></div>
    ${A ? `<div class="panel"><header><h2>Первичная настройка</h2><span class="hint">${done} из ${steps.length}</span></header>
      <div class="body"><ol class="steps">${steps.map(s=>`<li class="${s[0]?"done":""}"><span class="grow">${esc(s[1])} <span class="tzref">${s[3]}</span></span><button class="btn sm" onclick="go('${s[2]}')">Открыть</button></li>`).join("")}</ol></div></div>`
    : `<div class="panel"><header><h2>Что мне доступно</h2></header><div class="body stack">
        <span>Кошельки: ${[...visibleWallets(u)].map(id=>esc(nm(wal(id)))).join(", ") || `<span class="muted">не назначены — обратитесь к администратору</span>`}</span>
        <span>${canEnter(u)?"Можно вводить внутренние операции и ручные документы по своим кошелькам в открытом периоде.":"Только просмотр."}</span>
        <div class="row"><button class="btn primary" onclick="go('rep37')">Деньги по кошелькам</button><button class="btn" onclick="go('rep75')">Где лежат деньги</button>
        ${canEnter(u)?`<button class="btn" onclick="newOp()">Новая внутренняя операция</button>`:""}</div></div></div>`}
  </div>`;
}

"use strict";
/* ============================================================
   12. ДОКУМЕНТЫ: СПИСОК, ПРОСМОТР, РУЧНОЙ ВВОД (раздел 3а)
   ============================================================ */
const DF = {src:"", type:"", org:"", from:"", to:"", q:"", state:"", sort:"date", dir:"desc"};
function docVisible(d, u){
  u = u||me(); const V = visibleWallets(u); const nw = seesNoWallet(u);
  const ws = d.type==="ПЕР" ? [d.from.wallet, d.to.wallet] : d.lines.map(l=>l.wallet);
  return ws.some(w => w ? V.has(w) : nw);
}
function docTotal(d){ return d.type==="ПЕР" ? d.from.sum : r2(d.lines.reduce((s,l)=>s+l.sum,0)); }
/** Сумма только видимых пользователю строк */
function docVisTotal(d){ return d.type==="ПЕР" ? d.from.sum : r2(d.lines.filter(l=>lineVisible(l.wallet)).reduce((s,l)=>s+l.sum,0)); }
function docWallets(d){ const ws = d.type==="ПЕР" ? [d.from.wallet,d.to.wallet] : d.lines.filter(l=>lineVisible(l.wallet)).map(l=>l.wallet);
  return [...new Set(ws.map(w=>w?wname(w):"без кошелька"))].join(d.type==="ПЕР"?" → ":", "); }
/** Элементы справочника, действующие на дату, плюс уже выбранный (ТР-19) */
const activeOn = (list, date, keep) => list.filter(x => isActiveAt(x,date) || x.id===keep);
function optsTreeActive(list, val, date, empty){ const ok = new Set(activeOn(list,date,val).map(x=>x.id)); return optsTree(list, val, empty, x=>ok.has(x.id)); }
function manualAllowed(date){ return !(DB.settings.switchDate && date >= DB.settings.switchDate); }
let DOCLIM = 500;
function docsFiltered(){

  const u = me();
  let list = DB.docs.filter(d=>docVisible(d,u));
  if(DF.src) list = list.filter(d=>d.source===DF.src);
  if(DF.type) list = list.filter(d=>d.type===DF.type);
  if(DF.org) list = list.filter(d=>d.org===DF.org || (d.type==="ПЕР" && (d.from.org===DF.org||d.to.org===DF.org)));
  if(DF.from) list = list.filter(d=>d.date>=DF.from);
  if(DF.to) list = list.filter(d=>d.date<=DF.to);
  if(DF.state==="in") list = list.filter(docCounts); else if(DF.state==="out") list = list.filter(d=>!docCounts(d));
  if(DF.q){ const q = norm(DF.q); list = list.filter(d=>norm([d.no,d.no1c,d.guid,d.op,...(d.lines||[]).map(l=>l.cpty+" "+l.purpose)].join(" ")).includes(q)); }
  const key = {date:d=>d.date+"|"+(d.no1c||d.no), no:d=>String(d.no1c||d.no), org:d=>nm(org(d.type==="ПЕР"?d.from.org:d.org)).toLowerCase(),
    sum:d=>d.type==="ПЕР"?d.from.sum:DOC_TYPES[d.type].sign*docVisTotal(d)}[DF.sort] || (d=>d.date);
  const dir = DF.dir==="asc" ? 1 : -1;
  list.sort((a,b)=>{ const x = key(a), y = key(b); return (typeof x==="number" ? x-y : x<y?-1:x>y?1:0) * dir; });
  return list;
}
function exportDocs(){
  const list = docsFiltered();
  const rows = [["Дата","Тип","Номер","GUID 1С","Хоз. операция","Организация","Счёт или касса","Сумма","Валюта","Кошельки","Источник","Состояние"]];
  list.forEach(d=>{ const P = d.type==="ПЕР"; const sg = DOC_TYPES[d.type].sign;
    rows.push([fmtD(d.date), d.type, d.no1c||d.no, d.guid||"", d.op||"", P?`${nm(org(d.from.org))} → ${nm(org(d.to.org))}`:nm(org(d.org)), P?`${nm(acc(d.from.acc))} → ${nm(acc(d.to.acc))}`:nm(acc(d.acc)),
      P ? d.from.sum : sg*docVisTotal(d), P?`${curCode(acc(d.from.acc)?.cur)}→${curCode(acc(d.to.acc)?.cur)}`:curCode(d.cur), docWallets(d), d.source==="file"?"файл 1С":"вручную",
      docCounts(d)?"в расчёте":"вне расчёта"]); });
  const fname = `Документы ${CUR.date}.xlsx`; downloadBlob(xlsxBlob([{name:"Документы", rows}]), fname);
  audit("Выгрузка в Excel", "Документы", `файл ${fname}; строк ${list.length}`);
}
let DF_MORE = false;
function docSort(k){ if(DF.sort===k) DF.dir = DF.dir==="asc"?"desc":"asc"; else { DF.sort = k; DF.dir = k==="date"||k==="sum" ? "desc" : "asc"; } render(); }
function sortTh(k, label, cls=""){ const on = DF.sort===k; return `<th class="${cls} sort-th" aria-sort="${on?(DF.dir==="asc"?"ascending":"descending"):"none"}" tabindex="0" onclick="docSort('${k}')" onkeydown="if(event.key==='Enter')docSort('${k}')">${label}</th>`; }
const DOC_COLS = [["org","Организация и счёт"],["wallet","Кошелёк"],["cpty","Контрагент"],["state","Состояние"]];
let DOCHIDE; try{ DOCHIDE = new Set(JSON.parse(localStorage.getItem("wallets-doccols")||'["cpty"]')); }catch(e){ DOCHIDE = new Set(["cpty"]); }
function togDocCol(k){ DOCHIDE.has(k) ? DOCHIDE.delete(k) : DOCHIDE.add(k); try{ localStorage.setItem("wallets-doccols", JSON.stringify([...DOCHIDE])); }catch(e){} render(); }
function colsMenu(){ const open = POP==="v:cols";
  return `<div class="popwrap"><button type="button" class="btn" onclick="togglePop('v:cols',event)" aria-expanded="${open}">Колонки</button>
    ${open?`<div class="pop pop-right"><div class="pop-title">Показывать колонки</div><div class="stack" style="padding:4px 12px 10px">${DOC_COLS.map(([k,t])=>`<label class="chk"><input type="checkbox" ${DOCHIDE.has(k)?"":"checked"} onchange="togDocCol('${k}')"> ${t}</label>`).join("")}</div></div>`:""}</div>`; }
function docCpty(d){ const L = d.type==="ПЕР" ? [d.from,d.to] : d.lines.filter(l=>lineVisible(l.wallet)); return [...new Set(L.map(l=>l.cpty).filter(Boolean))].join(", "); }
function dfCount(){ return ["type","org","from","to"].filter(k=>DF[k]).length; }
function createMenu(){
  const id = "v:create"; const open = POP===id;
  return `<div class="popwrap"><button type="button" class="btn primary" onclick="togglePop('${id}',event)" aria-expanded="${open}">Создать <span class="caret light"></span></button>
    ${open?`<div class="pop pop-right" role="menu">
      <button type="button" class="pop-item" onclick="POP=null;newDoc('ПБДС')"><b>Поступление на счёт</b><span class="muted">ПБДС — оплата, возврат, кредит</span></button>
      <button type="button" class="pop-item" onclick="POP=null;newDoc('ПКО')"><b>Поступление в кассу</b><span class="muted">ПКО — наличные</span></button>
      <button type="button" class="pop-item" onclick="POP=null;newDoc('ПЕР')"><b>Конвертация или переброска</b><span class="muted">Между счетами группы, одной формой</span></button>
      <button type="button" class="pop-item" onclick="POP=null;newOp()"><b>Внутренняя операция</b><span class="muted">Займ, финансирование, дивиденды</span></button></div>`:""}</div>`;
}
function seg(cur, opts, setter){ return `<div class="seg">${opts.map(([v,t])=>`<button type="button" class="${cur===v?"on":""}" aria-pressed="${cur===v}" onclick="${setter}='${v}';render()">${t}</button>`).join("")}</div>`; }
function viewDocs(){
  const u = me(); const list = docsFiltered();
  const shown = list.slice(0,DOCLIM);
  const can = canEnter(u);
  const sw = DB.settings.switchDate; const nf = dfCount();
  return `<h1>Документы</h1>
  <p class="lede">Расходы (СБДС, РКО) приходят из 1С — файлом, позже через шлюз; здесь у них можно только назначить кошелёк. Поступления, конвертации и переброски пока вводятся вручную (ТР-68).${sw?` С ${fmtD(sw)} ручной ввод отключён — данные приходят из 1С (ТР-72).`:""}</p>
  <div class="toolbar">
    <label class="fld search"><span>Поиск</span><input type="search" value="${esc(DF.q)}" placeholder="Номер, GUID, контрагент, назначение" onchange="DF.q=this.value;DOCLIM=500;render()"></label>
    <div class="fld"><span>Состояние</span>${seg(DF.state,[["","Все"],["in","В расчёте"],["out","Вне расчёта"]],"DF.state")}</div>
    <div class="fld"><span>Источник</span>${seg(DF.src,[["","Все"],["file","Файл 1С"],["manual","Вручную"]],"DF.src")}</div>
    <div class="fld"><span>&nbsp;</span><button type="button" class="btn ${DF_MORE||nf?"on":""}" aria-expanded="${DF_MORE}" onclick="DF_MORE=!DF_MORE;render()">Ещё фильтры${nf?` <span class="count">${nf}</span>`:""}</button></div>
    <div class="grow"></div>
    ${can?createMenu():""}
  </div>
  ${DF_MORE?`<div class="toolbar sub">
    <label class="fld"><span>Тип</span><select onchange="DF.type=this.value;render()"><option value="">Все типы</option>${Object.entries(DOC_TYPES).map(([k,t])=>`<option value="${k}" ${DF.type===k?"selected":""}>${k} — ${esc(t.name)}</option>`).join("")}</select></label>
    <label class="fld"><span>Организация</span><select onchange="DF.org=this.value;render()">${opts(DB.orgs,DF.org,{empty:"Все организации"})}</select></label>
    <label class="fld"><span>Дата с</span><input type="date" value="${DF.from}" onchange="DF.from=this.value;render()"></label>
    <label class="fld"><span>по</span><input type="date" value="${DF.to}" onchange="DF.to=this.value;render()"></label>
    ${nf?`<button type="button" class="btn ghost" onclick="Object.assign(DF,{type:'',org:'',from:'',to:''});render()">Сбросить</button>`:""}
  </div>`:""}
  <div class="panel"><header><h2>${list.length} ${plural(list.length,"документ","документа","документов")}</h2>${list.length>DOCLIM?`<span class="hint">показаны первые ${DOCLIM}</span>`:""}<div style="flex:1"></div>${colsMenu()}<button type="button" class="btn" onclick="exportDocs()">Выгрузить в Excel</button></header>
  <div class="body flush"><div class="tbl-wrap"><table id="tDocs" class="list-t">
    <thead><tr>${sortTh("date","Дата")}${sortTh("no","Документ")}${DOCHIDE.has("org")?"":sortTh("org","Организация и счёт")}${DOCHIDE.has("wallet")?"":"<th>Кошелёк</th>"}${DOCHIDE.has("cpty")?"":"<th>Контрагент</th>"}${sortTh("sum","Сумма","num")}${DOCHIDE.has("state")?"":"<th>Состояние</th>"}</tr></thead>
    <tbody>${shown.map(d=>{ const P = d.type==="ПЕР"; const sg = DOC_TYPES[d.type].sign;
      return `<tr class="clickable ${docCounts(d)?"":"excl"}" onclick="openDoc('${d.id}')"><td class="nowrap">${fmtD(d.date)}</td>
      <td><span class="dtype">${d.type}</span> <a class="lnk">${esc(d.no1c||d.no)}</a><div class="sub"><span>${esc(d.op||DOC_TYPES[d.type].name)}</span> · <span>${d.source==="file"?"файл 1С":"вручную"}</span></div></td>
      ${DOCHIDE.has("org")?"":`<td>${P?`${esc(nm(org(d.from.org)))} → ${esc(nm(org(d.to.org)))}`:esc(nm(org(d.org)))}<div class="sub">${P?`${esc(nm(acc(d.from.acc)))} → ${esc(nm(acc(d.to.acc)))}`:esc(nm(acc(d.acc)))}</div></td>`}
      ${DOCHIDE.has("wallet")?"":`<td>${esc(docWallets(d))}</td>`}${DOCHIDE.has("cpty")?"":`<td>${esc(docCpty(d))}</td>`}
      <td class="num ${sg<0?"neg":sg>0?"pos":""}">${P?fmt(d.from.sum):fmtS(sg*docVisTotal(d))}<div class="sub">${P?`${esc(curCode(acc(d.from.acc)?.cur))} → ${esc(curCode(acc(d.to.acc)?.cur))}`:esc(curCode(d.cur))}</div></td>
      ${DOCHIDE.has("state")?"":`<td>${docStateTag(d)}${d.type==="СБДС"&&!d.bankDone&&docCounts(d)?`<div class="sub"><span class="tag warn">не исполнен банком</span></div>`:""}</td>`}</tr>`; }).join("")
      || `<tr><td colspan="7" class="empty-cell">Под фильтры не попал ни один документ.${nf||DF.q||DF.state||DF.src?`<br><button type="button" class="btn sm" style="margin-top:10px" onclick="Object.assign(DF,{src:'',type:'',org:'',from:'',to:'',q:'',state:''});render()">Сбросить фильтры</button>`:""}</td></tr>`}</tbody></table></div>
    ${list.length>DOCLIM?`<div class="body row"><button class="btn" onclick="DOCLIM+=500;render()">Показать ещё 500</button><button class="btn ghost" onclick="DOCLIM=1e9;render()">Показать все</button></div>`:""}</div></div>`;
}
function plural(n, one, few, many){ const a = Math.abs(n)%100, b = a%10; if(LANG==="en") return many; if(a>10&&a<20) return many; if(b>1&&b<5) return few; if(b===1) return one; return many; }

/* --- просмотр / редактирование --- */
let ED = null, EDerr = null;
function newDoc(type){
  const u = me(); if(!canEnter(u)) return;
  const base = {id:uid("D"), no:"", source:"manual", type, op:MANUAL_OPS[type][0], no1c:"", date1c:"", date:CUR.date, status:"Проведён",
    author:u.id, created:new Date().toISOString(), deleted:false, excluded:false, versions:[], lines:[]};
  const side = () => ({org:"",acc:"",sum:null,wallet:null,wsrc:null,dept:"",cf:"",zone:"",cpty:"",contract:"",purpose:""});
  if(type==="ПЕР"){ Object.assign(base, {from:side(), to:side()}); base.link = {kind:"", contract:""}; }
  else { Object.assign(base, {org:"", acc:"", cur:"", lines:[{sum:null, wallet:null, wsrc:null, dept:"", cf:"", zone:"", cpty:"", contract:"", purpose:""}]}); }
  const L = lastPick(type); const activeOrgs = DB.orgs.filter(o=>isActiveAt(o,base.date));
  const pickSide = (S, pref, cash) => {
    if(pref && activeOrgs.some(o=>o.id===pref.org)){ S.org = pref.org; const a = acc(pref.acc);
      if(a && a.org===pref.org && isActiveAt(a,base.date) && (cash==null || (a.kind==="Касса")===cash)) S.acc = pref.acc; }
    else if(activeOrgs.length===1) S.org = activeOrgs[0].id;
    if(S.org && !S.acc){ const one = onlyAccount(S.org, cash); if(one) S.acc = one.id; } };
  if(type==="ПЕР"){ pickSide(base.from, L&&L.from, null); ["from"].forEach(k=>{ const S = base[k]; if(S.acc){ const m = matchRule(sideCtx(S), base.date); S.wallet = m.wallet; S.wsrc = m.wallet?"rule":null; S.rule = m.rule?m.rule.id:null; } }); }
  else { pickSide(base, L, DOC_TYPES[type].cash); if(base.acc) base.cur = acc(base.acc).cur; applyRules(base); }
  const dr = readDraft(type); if(dr && hasContent(dr)) base._draft = dr;
  ED = base; EDerr = null; openDocModal(true);
}
/* --- последние выбранные организация и счёт, черновики --- */
function lastPick(type){ try{ return JSON.parse(localStorage.getItem("wallets-last-"+type)||"null"); }catch(e){ return null; } }
function rememberPick(d){ try{ localStorage.setItem("wallets-last-"+d.type, JSON.stringify(d.type==="ПЕР" ? {from:{org:d.from.org,acc:d.from.acc}, to:{org:d.to.org,acc:d.to.acc}} : {org:d.org, acc:d.acc})); }catch(e){} }
function onlyAccount(orgId, cash){ const l = [...(cash!==true?DB.accounts:[]), ...(cash!==false?DB.cashboxes:[])].filter(a=>a.org===orgId && isActiveAt(a,CUR.date)); return l.length===1 ? l[0] : null; }
const draftKey = t => "wallets-draft-" + t;
function readDraft(t){ try{ return JSON.parse(localStorage.getItem(draftKey(t))||"null"); }catch(e){ return null; } }
function dropDraft(t){ try{ localStorage.removeItem(draftKey(t)); }catch(e){} }
function hasContent(d){ if(!d) return false; if(d.leg1 && !d.type) return !!(d.leg1.sum || (d.leg2&&d.leg2.sum)); if(d.type==="ПЕР") return !!(d.from && (d.from.sum || d.to.sum)); return (d.lines||[]).some(l=>l.sum>0); }
function cleanDraft(o){ const x = JSON.parse(JSON.stringify(o)); delete x._draft; delete x._tried; delete x._fe; delete x._warnOk; x._saved = new Date().toISOString(); return x; }
function saveDraft(){ if(!ED || ED.source!=="manual" || byId(DB.docs,ED.id) || !hasContent(ED)) return; try{ localStorage.setItem(draftKey(ED.type), JSON.stringify(cleanDraft(ED))); }catch(e){} }
function draftBanner(obj, restore, drop){ const d = obj && obj._draft; if(!d) return "";
  return `<div class="alert ok draft-note"><span>Есть несохранённый черновик от ${fmtDT(d._saved)}.</span> <button type="button" class="btn sm" onclick="${restore}">Восстановить</button> <button type="button" class="btn sm ghost" onclick="${drop}">Удалить черновик</button></div>`; }
function restoreDocDraft(){ const d = ED._draft; delete d._saved; ED = Object.assign(d, {id:uid("D")}); refreshModal(); }
/* --- ошибки у поля --- */
function fe(k, o){ o = o||ED; const m = o && o._tried && o._fe && o._fe[k]; return m ? `<small class="ferr">${esc(String(m).replace(/^(Отправитель|Получатель|Строка \d+|Нога 1|Нога 2[^:]*|Счёт): /,""))}</small>` : ""; }
function fi(k, o){ o = o||ED; return o && o._tried && o._fe && o._fe[k] ? "invalid" : ""; }
function errSummary(o, all, server){
  let h = ""; if(o._tried){ const fv = new Set(Object.values(o._fe||{})); const gen = all.filter(x=>!fv.has(x)); const nf = Object.keys(o._fe||{}).length;
    if(nf || gen.length) h += `<div class="alert err">${nf?`<b>Проверьте отмеченные поля: ${nf}.</b>`:""}${gen.length?`<ul>${gen.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`:""}</div>`; }
  if(server && server.length) h += `<div class="alert err"><ul>${server.map(x=>`<li>${esc(x)}</li>`).join("")}</ul></div>`;
  return h; }
function focusFirstError(){ setTimeout(()=>{ const el = document.querySelector("#modalHost .invalid select, #modalHost .invalid input"); if(el){ el.focus(); el.scrollIntoView({block:"center"}); } }, 30); }
function openDoc(id){
  const d = byId(DB.docs,id); if(!d) return;
  ED = clone(d); EDerr = null; if(ED.type==="ПЕР") ED.link = {kind:"", contract:""};
  openDocModal(false);
}
function edEditable(){
  const u = me(); const d = ED;
  if(d.source!=="manual" || d.excluded) return false;
  if(!canEnter(u)) return false;
  if(periodError(d.date)) return false;
  if(!manualAllowed(d.date)) return false;
  const orig = byId(DB.docs,d.id);
  if(orig && !isAdmin(u)){ // казначей правит только документы своих кошельков
    const ws = orig.type==="ПЕР" ? [orig.from.wallet,orig.to.wallet] : orig.lines.map(l=>l.wallet);
    if(!ws.some(w=>w && canEditWallet(u,w)) && !(orig.author===u.id)) return false;
    if(orig.type!=="ПЕР" && (orig.hiddenLines || orig.lines.some(l=>l.wallet && !canEditWallet(u,l.wallet)))) return false;
  }
  return true;
}
function openDocModal(isNew){
  const t = DOC_TYPES[ED.type];
  openModal({width:1180,
    title: `${esc(t.name)} ${ED.no1c||ED.no?`№ ${esc(ED.no1c||ED.no)}`:"(новый)"} <span class="tag">${ED.source==="file"?"из файла 1С":"ручной ввод"}</span>`,
    body: () => ED.source==="file" ? fileDocBody() : ED.type==="ПЕР" ? transferBody() : manualBody(),
    footer: docFooter,
    submit: () => { if(ED.source==="file"){ if(fileLinesEditable()) saveFileWallets(); } else if(edEditable() && !ED.deleted) saveManual(); },
    submitLabel: ED.source==="file" ? "сохранить кошельки" : "провести",
    onRender: saveDraft, onChange: saveDraft,
  });
}
function docFooter(){
  const d = ED; const orig = byId(DB.docs,d.id); const u = me();
  if(d.source==="file"){
    const can = fileLinesEditable();
    return `<span class="muted" style="margin-right:auto">Документы из файла нельзя пометить на удаление — их исключает повторная загрузка (ТР-74).</span>
      <button class="btn" onclick="closeModal()">Закрыть</button>${can?`<button class="btn primary" onclick="saveFileWallets()">Сохранить кошельки</button>`:""}`;
  }
  const ed = edEditable();
  return `${orig && ed ? `<button class="btn danger" style="margin-right:auto" onclick="toggleDocDelete()">${d.deleted?"Снять пометку удаления":"Пометить на удаление"}</button>`:""}
    ${orig && d.type==="ПЕР" && needsFormalizing().some(x=>x.id===d.id) && canEnter(u) ? `<button class="btn" onclick="closeModal();formalizeDoc('${d.id}')">Оформить внутреннюю операцию</button>`:""}
    ${ed && !orig ? `<span class="muted draft-hint">Черновик сохраняется автоматически</span>`:""}
    <button class="btn" onclick="closeModal()">${ed?"Отмена":"Закрыть"}</button>
    ${ed && !d.deleted ? `<button class="btn primary" onclick="saveManual()">Провести</button>`:""}`;
}
function lockReason(){
  const d = ED; const u = me();
  if(d.source!=="manual") return "";
  const r = !canEnter(u) ? "Ваша роль — только просмотр." : periodError(d.date) || (!manualAllowed(d.date) ? `С ${fmtD(DB.settings.switchDate)} ручной ввод отключён — данные приходят из 1С (ТР-72).` : "");
  return r ? `<div class="alert warn">${esc(r)}</div>` : (!edEditable() ? `<div class="alert warn">В документе есть строки чужих кошельков — его правит администратор или казначей этих кошельков. Только просмотр.</div>` : "");
}
function versionsBlock(obj){
  const v = obj.versions||[]; if(!v.length) return "";
  return `<fieldset><legend>Версии документа (ТР-14)</legend><table><thead><tr><th>Когда</th><th>Кто / источник</th><th>Изменения (было → стало)</th></tr></thead>
    <tbody>${v.slice().reverse().map(x=>`<tr><td>${fmtDT(x.t)}</td><td>${esc(x.u)}${x.source?`<br><span class="muted">${esc(x.source)}</span>`:""}</td><td style="font-size:11px" class="notr">${esc(x.diff)}</td></tr>`).join("")}</tbody></table></fieldset>`;
}

/* --- документ из файла 1С: только назначение кошелька --- */
function fileLinesEditable(){ const u = me(); return !ED.excluded && canEnter(u) && !periodError(ED.date); }
function fileDocBody(){
  const d = ED; const can = fileLinesEditable(); const u = me(); const a = acc(d.acc);
  return `${d.excluded?`<div class="alert err">Документ исключён из расчёта: его нет в последней загрузке или он распроведён/помечен на удаление в 1С (ТР-08).</div>`:""}
  ${!can && canEnter(u) && !d.excluded ? `<div class="alert warn">${esc(periodError(d.date)||"")}</div>`:""}
  <div class="grid2">
    <dl class="kv"><dt>GUID 1С</dt><dd><code class="k">${esc(d.guid)}</code></dd>
      <dt>Тип</dt><dd>${d.type} — ${esc(DOC_TYPES[d.type].name)}</dd>
      <dt>Хоз. операция</dt><dd>${esc(d.op||"—")}</dd>
      <dt>Номер</dt><dd>${esc(d.no1c||"—")}</dd>
      <dt>Дата (создания документа)</dt><dd>${fmtD(d.date)}</dd>
      <dt>Статус 1С</dt><dd>${esc(d.statusRaw||d.status)} · ${docStateTag(d)}</dd></dl>
    <dl class="kv"><dt>Организация</dt><dd>${esc(nm(org(d.org)))}</dd>
      <dt>${a&&a.kind==="Касса"?"Касса":"Банковский счёт"}</dt><dd>${esc(nm(a))}</dd>
      <dt>Валюта</dt><dd>${esc(curCode(d.cur))}</dd>
      ${d.type==="СБДС"?`<dt>Проведено банком</dt><dd>${d.bankDone?`<span class="tag ok">да</span>`:`<span class="tag warn">нет</span>`}</dd>
      <dt>Дата проведения банком</dt><dd>${d.bankDone?fmtD(d.bankDate):"—"}</dd>`:""}
      <dt>Загружен</dt><dd>${fmtDT(d.loaded)} <span class="muted">${esc(d.fileName||"")}</span></dd></dl>
  </div>
  <fieldset style="margin-top:12px"><legend>Расшифровка платежа — кошелёк по каждой строке (ТР-54)</legend>
  <div class="tbl-wrap"><table><thead><tr><th class="num">Сумма</th><th class="num">USD (из 1С)</th><th style="min-width:210px">Кошелёк</th><th>Подразделение</th><th>Тип расхода CF</th><th>Зона ответственности</th><th>Контрагент</th><th>Договор</th><th>Назначение</th></tr></thead>
  <tbody>${d.lines.map((l,i)=>{ if(!lineVisible(l.wallet)) return ""; const lineCan = can && (!l.wallet || canEditWallet(u,l.wallet));
    return `<tr><td class="num">${fmt(l.sum)} ${esc(curCode(d.cur))}</td><td class="num">${fmt(l.usd)}</td>
    <td>${lineCan?`<select onchange="ED.lines[${i}].wallet=this.value||null;ED.lines[${i}].wsrc=this.value?'manual':null;refreshModal()">${optsWallets(l.wallet,d.date,{onlyEditable:!isAdmin(u)})}</select>`:esc(l.wallet?nm(wal(l.wallet)):"без кошелька")}
      <div class="who">${l.wsrc==="rule"?`по правилу «${esc(nm(byId(DB.rules,l.rule))||"")}»`:l.wsrc==="file"?"из файла":l.wsrc==="manual"?"назначен вручную":""}</div></td>
    <td>${esc(refName(DB.depts,l.dept))}</td><td>${esc(refName(DB.cfTypes,l.cf))}</td><td>${esc(refName(DB.zones,l.zone))}</td>
    <td>${esc(l.cpty||"")}</td><td>${esc(l.contract||"")}</td><td style="font-size:11px">${esc(l.purpose||"")}</td></tr>`; }).join("")}</tbody></table></div>
  ${hiddenLinesNote(d)}
  ${can&&isAdmin(u)?`<button class="btn sm" onclick="ED.lines.forEach(l=>{if(l.wsrc==='rule'){l.wallet=null;l.wsrc=null}});applyRules(ED);refreshModal()">Заполнить по правилам</button>`:""}
  </fieldset>
  ${versionsBlock(d)}`;
}
function hiddenLinesNote(d){ const n = d.hiddenLines || 0;
  return n ? `<p class="muted">Строк других кошельков скрыто: ${n} — они вам недоступны (раздел 8).</p>` : ""; }
async function saveFileWallets(){
  const orig = byId(DB.docs, ED.id);
  const changes = [];
  orig.lines.forEach((l,i)=>{ const n = ED.lines[i]; if(l.wallet!==n.wallet) changes.push({where:String(l.idx ?? i), wallet:n.wallet||""}); });
  if(!changes.length){ closeModal(); return; }
  const r = await mutate(`/api/docs/${encodeURIComponent(ED.id)}/wallets`, {changes});
  if(!r.ok){ EDerr = r.errors; refreshModal(); return; }
  closeModal(); toast("Кошельки сохранены", {lvl:"ok"});
}
/* --- ручной ПБДС / ПКО --- */
function edSet(k, v){ ED[k] = v;
  if(k==="org"){ ED.acc=""; ED.cur=""; const one = v && onlyAccount(v, DOC_TYPES[ED.type].cash); if(one){ ED.acc = one.id; ED.cur = one.cur; } }
  if(k==="acc"){ const a = acc(v); ED.cur = a ? a.cur : ""; }
  if(["org","acc","date"].includes(k)) applyRules(ED);
  refreshModal(); }
function edLine(i, k, v){ const l = ED.lines[i]; l[k] = v;
  if(k==="wallet"){ l.wsrc = v ? "manual" : null; l.rule = null; }
  else if(["dept","cf","zone","cpty"].includes(k)) applyRules(ED);
  refreshModal(); }
function manualBody(){
  const d = ED; const ed = edEditable(); const cash = DOC_TYPES[d.type].cash; const dis = ed ? "" : "disabled";
  const rate = d.cur ? rateAt(d.cur, d.date) : null;
  const allE = d._tried ? validateManual(d) : [];
  return `${lockReason()}${draftBanner(d,"restoreDocDraft()","dropDraft(ED.type);ED._draft=null;refreshModal()")}${errSummary(d, allE, EDerr)}
  ${d.deleted?`<div class="alert err">Документ помечен на удаление и не участвует в расчёте.</div>`:""}
  <div class="grid2">
    <label class="fld"><span>Хозяйственная операция <em>*</em></span><select ${dis} onchange="edSet('op',this.value)">${MANUAL_OPS[d.type].map(o=>`<option value="${esc(o)}" ${o===d.op?"selected":""}>${esc(o)}</option>`).join("")}</select></label>
    <label class="fld ${fi("date")}"><span>Дата поступления <em>*</em></span><input type="date" ${dis} value="${d.date}" onchange="edSet('date',this.value)">${fe("date")}</label>
    <label class="fld ${fi("org")}"><span>Организация <em>*</em></span><select ${dis} onchange="edSet('org',this.value)">${opts(DB.orgs.filter(o=>isActiveAt(o,d.date)||o.id===d.org),d.org)}</select>${fe("org")}</label>
    <label class="fld ${fi("acc")}"><span>${cash?"Касса":"Банковский счёт"} <em>*</em></span><select ${dis} onchange="edSet('acc',this.value)">${optsAccounts(d.org,d.acc,{cash})}</select>
      ${fe("acc")||`<small>Список зависит от организации (МД-05)</small>`}</label>
    <label class="fld"><span>Номер документа 1С, если уже есть</span><input type="text" ${dis} value="${esc(d.no1c)}" onchange="ED.no1c=this.value"></label>
    <label class="fld"><span>Дата документа 1С</span><input type="date" ${dis} value="${d.date1c||""}" onchange="ED.date1c=this.value"></label>
  </div>
  <div class="row" style="margin:6px 0 10px"><span class="muted">Валюта: <span class="cur">${esc(d.cur?curCode(d.cur):"—")}</span> из счёта · курс ERP на ${fmtD(d.date)}: ${rate?`${fmtRate(rate)} ${esc(curCode(d.cur))} за 1 USD`:d.cur?`<span class="neg">нет курса</span>`:"—"}</span></div>
  <fieldset><legend>Расшифровка — кошелёк по каждой строке</legend>
  <div class="tbl-wrap" style="max-height:none"><table><thead><tr><th style="min-width:170px">Сумма</th><th class="num">USD</th><th style="min-width:190px">Кошелёк</th><th>Подразделение</th><th>Тип расхода CF</th><th>Зона</th><th>Контрагент</th><th>Договор</th><th>Назначение</th><th></th></tr></thead>
  <tbody>${d.lines.map((l,i)=>!lineVisible(l.wallet)?"":`<tr>
    <td class="${fi("l"+i+".sum")}">${sumWithCur(ed?moneyInput({id:`ln${i}`, value:l.sum, onchange:`edLine(${i},'sum',parseNum(this.value))`}):`<span class="num">${fmt(l.sum)}</span>`, d.cur)}${fe("l"+i+".sum")}</td>
    <td class="num muted">${l.sum>0&&rate?fmt(toUSD(l.sum,d.cur,d.date)):"—"}</td>
    <td class="${fi("l"+i+".wallet")}"><select ${dis} onchange="edLine(${i},'wallet',this.value||null)">${optsWallets(l.wallet,d.date,{onlyEditable:!isAdmin(me())})}</select>${fe("l"+i+".wallet")}
      <div class="who">${l.wsrc==="rule"?`по правилу «${esc(nm(byId(DB.rules,l.rule))||"")}»`:l.wsrc==="manual"?"выбран вручную":"правило не сработало → «Без кошелька»"}</div></td>
    <td><select ${dis} onchange="edLine(${i},'dept',this.value)">${optsTreeActive(DB.depts,l.dept,d.date,"—")}</select></td>
    <td><select ${dis} onchange="edLine(${i},'cf',this.value)">${opts(activeOn(DB.cfTypes,d.date,l.cf),l.cf,{empty:"—"})}</select></td>
    <td><select ${dis} onchange="edLine(${i},'zone',this.value)">${opts(activeOn(DB.zones,d.date,l.zone),l.zone,{empty:"—"})}</select></td>
    <td><input type="text" ${dis} value="${esc(l.cpty)}" onchange="edLine(${i},'cpty',this.value)" style="width:120px"></td>
    <td><input type="text" ${dis} value="${esc(l.contract)}" onchange="ED.lines[${i}].contract=this.value" style="width:100px"></td>
    <td><input type="text" ${dis} value="${esc(l.purpose)}" onchange="ED.lines[${i}].purpose=this.value" style="width:160px"></td>
    <td>${ed&&d.lines.length>1?`<button class="btn sm" onclick="ED.lines.splice(${i},1);refreshModal()" aria-label="Удалить строку">✕</button>`:""}</td></tr>`).join("")}
    <tr class="tot"><td class="num">${fmt(docVisTotal(d))} ${esc(curCode(d.cur))}</td><td class="num">${rate?fmt(toUSD(docVisTotal(d),d.cur,d.date)):""}</td><td colspan="8"></td></tr></tbody></table></div>
  ${hiddenLinesNote(d)}
  ${ed?`<div class="row" style="margin-top:8px"><button class="btn sm" onclick="ED.lines.push({sum:null,wallet:null,wsrc:null,dept:'',cf:'',zone:'',cpty:'',contract:'',purpose:''});applyRules(ED);refreshModal()">Добавить строку</button>
    <button class="btn sm" onclick="ED.lines.forEach(l=>{if(l.wsrc!=='manual'){l.wallet=null;l.wsrc=null}});applyRules(ED);refreshModal()">Заполнить кошельки по правилам</button></div>`:""}
  </fieldset>${versionsBlock(d)}`;
}
function validateManual(d){
  const e = [], F = {}; const u = me(); const add = (k, m) => { e.push(m); if(k && !F[k]) F[k] = m; };
  const pe = periodError(d.date); if(pe) add("date", pe);
  if(!manualAllowed(d.date)) add("date", `С ${fmtD(DB.settings.switchDate)} ручной ввод отключён (ТР-72).`);
  if(d.type==="ПЕР"){
    [["from","Отправитель"],["to","Получатель"]].forEach(([s,t])=>{ const S = d[s];
      if(!S.org) add(s+".org", `${t}: не выбрана организация`); if(!S.acc) add(s+".acc", `${t}: не выбран счёт или касса`);
      if(!(S.sum>0)) add(s+".sum", `${t}: сумма должна быть больше нуля`);
      const a = acc(S.acc); if(a && !rateAt(a.cur,d.date)) add(s+".acc", `${t}: нет курса ${curCode(a.cur)} на ${fmtD(d.date)}`);
      if(S.wallet && walletClosedAt(S.wallet,d.date)) add(s+".wallet", `${t}: кошелёк закрыт (ТР-25)`);
      if(S.wallet && !isAdmin(u) && !canEditWallet(u,S.wallet) && !pickableWallets(u,d.date).some(w=>w.id===S.wallet)) add(s+".wallet", `${t}: кошелёк недоступен`); });
    if(d.from.acc && d.from.acc===d.to.acc) add("to.acc", "Счёт отправителя и получателя совпадают");
    const fa = acc(d.from.acc), ta = acc(d.to.acc);
    if(fa && ta && d.op==="Конвертация валюты" && fa.cur===ta.cur) add("", "Конвертация: валюты счетов должны различаться");
    if(fa && ta && d.op!=="Конвертация валюты" && fa.cur!==ta.cur) add("", "Переброска: валюты счетов различаются — выберите «Конвертация валюты»");
    if(!isAdmin(u) && ![d.from.wallet,d.to.wallet].some(w=>w && canEditWallet(u,w))) add("", "Казначей вводит документы по своим кошелькам: хотя бы одна сторона должна быть вашим кошельком");
  } else {
    if(!d.org) add("org", "Не выбрана организация"); if(!d.acc) add("acc", DOC_TYPES[d.type].cash?"Не выбрана касса":"Не выбран банковский счёт");
    if(d.acc && !rateAt(d.cur,d.date)) add("acc", `Нет курса ${curCode(d.cur)} на ${fmtD(d.date)} — загрузите курсы из 1С`);
    if(!d.lines.length) add("", "Нет строк расшифровки");
    d.lines.forEach((l,i)=>{ if(!(l.sum>0)) add(`l${i}.sum`, `Строка ${i+1}: сумма должна быть больше нуля`);
      if(l.wallet && walletClosedAt(l.wallet,d.date)) add(`l${i}.wallet`, `Строка ${i+1}: кошелёк закрыт (ТР-25)`);
      if(l.wallet && !canEditWallet(u,l.wallet)) add(`l${i}.wallet`, `Строка ${i+1}: кошелёк «${nm(wal(l.wallet))}» не ваш`); });
  }
  d._fe = F;
  return e;
}
/** Данные документа для сервера: только поля формы */
function manualPayload(d){
  const side = S => ({org:S.org, acc:S.acc, sum:S.sum, wallet:S.wallet||"", wsrc:S.wsrc, rule:S.rule||"", dept:S.dept||"", cf:S.cf||"", zone:S.zone||"", cpty:S.cpty||"", contract:S.contract||"", purpose:S.purpose||""});
  const p = {id: byId(DB.docs,d.id) ? d.id : "", type:d.type, op:d.op, no1c:d.no1c||"", date1c:d.date1c||"", date:d.date};
  if(d.type==="ПЕР"){ p.from = side(d.from); p.to = side(d.to); }
  else { p.org = d.org; p.acc = d.acc; p.lines = d.lines.map(side); }
  return p;
}
async function saveManual(){
  const d = ED; d._tried = true; EDerr = null; const errs = validateManual(d);
  if(errs.length){ refreshModal(); focusFirstError(); return; }
  const isNew = !byId(DB.docs, d.id);
  const r = await mutate("/api/docs/manual", {doc:manualPayload(d), link:d.link||null});
  if(!r.ok){ EDerr = r.errors; refreshModal(); return; }
  rememberPick(d); if(isNew) dropDraft(d.type);
  closeModal();
  toast(`${isNew?"Проведён":"Сохранён"} документ ${(r.result&&r.result.no)||d.no||""}`.trim(), {lvl:"ok"});
}
async function toggleDocDelete(){
  const id = ED.id, was = !!ED.deleted, no = ED.no1c||ED.no;
  const r = await mutate(`/api/docs/${encodeURIComponent(id)}/delete`);
  if(!r.ok){ EDerr = r.errors; refreshModal(); return; }
  closeModal();
  toast(was ? `Снята пометка удаления: ${no}` : `Документ ${no} помечен на удаление`, {action: async()=>{ const x = await mutate(`/api/docs/${encodeURIComponent(id)}/delete`); x.ok ? toast("Отменено", {lvl:"ok"}) : showErrors(x); }});
}
/* --- конвертация / переброска одной формой с двумя сторонами (ТР-69, МД-15) --- */
function sideCtx(S){ return {org:S.org, acc:S.acc, dept:S.dept, cf:S.cf, zone:S.zone, cpty:S.cpty}; }
function trSet(side, k, v){
  const S = ED[side]; S[k] = v;
  if(k==="org"){ S.acc = ""; const one = v && onlyAccount(v, null); if(one) S.acc = one.id; }
  if(k==="wallet"){ S.wsrc = v ? "manual" : null; }
  if(k==="sum" && side==="from"){ const fa = acc(ED.from.acc), ta = acc(ED.to.acc); if(fa && ta && fa.cur===ta.cur && (ED.to.sum===null || ED.to._mirror)){ ED.to.sum = v; ED.to._mirror = true; } }
  if(k==="sum" && side==="to") ED.to._mirror = false;
  if(["org","acc","dept","cf","zone","cpty"].includes(k) && S.wsrc!=="manual"){ const m = matchRule(sideCtx(S), ED.date); S.wallet = m.wallet; S.wsrc = m.wallet?"rule":null; S.rule = m.rule?m.rule.id:null; }
  if(k==="acc"){ const fa = acc(ED.from.acc), ta = acc(ED.to.acc); if(fa && ta && fa.cur===ta.cur && ED.to.sum===null && ED.from.sum){ ED.to.sum = ED.from.sum; ED.to._mirror = true; } }
  refreshModal();
}
/** Договоры займа для привязки: выдача — отправитель займодавец; погашение — отправитель заёмщик */
function linkContracts(kind, from, to){ return DB.contracts.filter(c => kind==="loan" ? (c.lender===from && c.borrower===to) : (c.lender===to && c.borrower===from)); }
async function quickContract(){
  const k = ED.link.kind; const [L,B] = k==="loan" ? [ED.from.wallet, ED.to.wallet] : [ED.to.wallet, ED.from.wallet];
  const r = await mutate("/api/contracts", {name:`Займ ${nm(wal(L))} → ${nm(wal(B))} от ${fmtD(ED.date)}`, lender:L, borrower:B});
  if(!r.ok){ EDerr = r.errors; refreshModal(); return; }
  ED.link.contract = r.result.id; refreshModal();
}
function linkedOpDraft(d){
  const k = d.link && d.link.kind; if(!k) return null; const a = acc(d.to.acc);
  return {id:uid("O"), no:"", date:d.date, kind:k, from:d.from.wallet, to:d.to.wallet, contract:(k==="loan"||k==="repay")?d.link.contract:"", comment:`Оформляет ${d.op.toLowerCase()} ${d.no||""}`.trim(),
    leg1:{org:d.to.org, acc:d.to.acc, sum:d.to.sum, rate:a?rateAt(a.cur,d.date):null}, leg2:{org:"",acc:"",sum:null,rate:null}, sameCur:true,
    author:CUR.u, created:new Date().toISOString(), posted:true, deleted:false, linkedDoc:d.id, versions:[]};
}
function transferBody(){
  const d = ED; const ed = edEditable(); const dis = ed ? "" : "disabled";
  const side = (s, title) => { const S = d[s]; const a = acc(S.acc); const rate = a ? rateAt(a.cur,d.date) : null;
    return `<fieldset class="leg ${s==="to"?"b":""}"><legend>${title}</legend><div class="stack">
      <label class="fld ${fi(s+".org")}"><span>Организация <em>*</em></span><select ${dis} onchange="trSet('${s}','org',this.value)">${opts(activeOn(DB.orgs,d.date,S.org),S.org)}</select>${fe(s+".org")}</label>
      <label class="fld ${fi(s+".acc")}"><span>Счёт или касса <em>*</em></span><select ${dis} onchange="trSet('${s}','acc',this.value)">${optsAccounts(S.org,S.acc)}</select>${fe(s+".acc")}</label>
      <label class="fld ${fi(s+".sum")}"><span>Сумма <em>*</em></span>${sumWithCur(ed?moneyInput({id:`tr_${s}`, value:S.sum, onchange:`trSet('${s}','sum',parseNum(this.value))`}):`<span class="num">${fmt(S.sum)}</span>`, a&&a.cur)}
        ${fe(s+".sum")||`<small>${S.sum>0&&rate?`= ${fmt(toUSD(S.sum,a.cur,d.date))} USD по курсу ${fmtRate(rate)}`:a&&!rate?`<span class="neg">нет курса на дату</span>`:""}</small>`}</label>
      <label class="fld ${fi(s+".wallet")}"><span>Кошелёк</span><select ${dis} onchange="trSet('${s}','wallet',this.value||null)">${optsWallets(S.wallet,d.date,{empty:"— без кошелька —"})}</select>
        ${fe(s+".wallet")||`<small>${S.wsrc==="rule"?`по правилу «${esc(nm(byId(DB.rules,S.rule))||"")}»`:S.wsrc==="manual"?"выбран вручную":""}</small>`}</label>
      <div class="grid2" style="grid-template-columns:1fr 1fr">
        <label class="fld"><span>Подразделение</span><select ${dis} onchange="trSet('${s}','dept',this.value)">${optsTreeActive(DB.depts,S.dept,d.date,"—")}</select></label>
        <label class="fld"><span>Тип расхода CF</span><select ${dis} onchange="trSet('${s}','cf',this.value)">${opts(activeOn(DB.cfTypes,d.date,S.cf),S.cf,{empty:"—"})}</select></label>
        <label class="fld"><span>Зона ответственности</span><select ${dis} onchange="trSet('${s}','zone',this.value)">${opts(activeOn(DB.zones,d.date,S.zone),S.zone,{empty:"—"})}</select></label>
        <label class="fld"><span>Контрагент</span><input type="text" ${dis} value="${esc(S.cpty||"")}" onchange="trSet('${s}','cpty',this.value)"></label>
        <label class="fld"><span>Договор</span><input type="text" ${dis} value="${esc(S.contract||"")}" onchange="ED['${s}'].contract=this.value"></label>
        <label class="fld"><span>Назначение платежа</span><input type="text" ${dis} value="${esc(S.purpose||"")}" onchange="ED['${s}'].purpose=this.value"></label>
      </div>
    </div></fieldset>`; };
  const fa = acc(d.from.acc), ta = acc(d.to.acc);
  const diffW = d.from.wallet && d.to.wallet && d.from.wallet!==d.to.wallet;
  const linked = DB.ops.find(o=>o.linkedDoc===d.id && !o.deleted);
  const L = d.link || {kind:"",contract:""};
  const lk = L.kind; const cons = (lk==="loan"||lk==="repay") ? linkContracts(lk, d.from.wallet, d.to.wallet) : [];
  const linkBlock = diffW && !linked && ed ? `<fieldset style="margin-top:12px"><legend>Внутренняя операция к этому платежу (ТР-57, ТР-69)</legend>
      <div class="grid2">
        <label class="fld"><span>Что это за перевод между кошельками</span><select onchange="ED.link.kind=this.value;ED.link.contract='';refreshModal()">
          <option value="">— оформить позже (попадёт в «Требует оформления»)</option>
          ${["loan","repay","funding","dividends"].map(k=>`<option value="${k}" ${lk===k?"selected":""}>${esc(OP_KINDS[k].name)}</option>`).join("")}</select></label>
        ${lk==="loan"||lk==="repay"?`<label class="fld"><span>Договор займа <em>*</em></span><div class="row"><select style="flex:1" onchange="ED.link.contract=this.value">${opts(cons,L.contract,{empty:"— выберите —"})}</select>
          <button class="btn sm" onclick="quickContract()">Создать договор</button></div></label>`:""}
      </div>
      ${lk?`<small class="muted">Операция проведётся вместе с платежом. Деньги уже переходят этим платежом, поэтому операция не меняет остатки повторно — она фиксирует характер перевода${lk==="loan"||lk==="repay"?" и долг по займу в USD":""}.</small>`:""}
    </fieldset>` : "";
  const allE = d._tried ? validateManual(d) : [];
  return `${lockReason()}${draftBanner(d,"restoreDocDraft()","dropDraft(ED.type);ED._draft=null;refreshModal()")}${errSummary(d, allE, EDerr)}
  ${d.deleted?`<div class="alert err">Документ помечен на удаление и не участвует в расчёте.</div>`:""}
  <p class="muted" style="margin-top:0">Одна операция — один ввод (ТР-69). В 1С это два документа (СБДС и ПБДС); при проведении здесь формируются две зеркальные записи: списание у отправителя и поступление у получателя.</p>
  <div class="grid2">
    <label class="fld"><span>Вид <em>*</em></span><select ${dis} onchange="edSet('op',this.value)">${MANUAL_OPS.ПЕР.map(o=>`<option value="${esc(o)}" ${o===d.op?"selected":""}>${esc(o)}</option>`).join("")}</select></label>
    <label class="fld ${fi("date")}"><span>Дата <em>*</em></span><input type="date" ${dis} value="${d.date}" onchange="ED.date=this.value;refreshModal()">${fe("date")}</label>
    <label class="fld"><span>Номер документа 1С, если уже есть</span><input type="text" ${dis} value="${esc(d.no1c)}" onchange="ED.no1c=this.value"></label>
    <label class="fld"><span>Дата документа 1С</span><input type="date" ${dis} value="${d.date1c||""}" onchange="ED.date1c=this.value"></label>
  </div>
  <div class="split" style="margin-top:12px">${side("from","Отправитель — списание")}${side("to","Получатель — поступление")}</div>
  ${fa && ta && d.from.sum>0 && d.to.sum>0 && fa.cur!==ta.cur ? `<div class="alert ok">Курс конвертации: 1 ${esc(curCode(fa.cur))} = ${fmtRate(d.to.sum/d.from.sum)} ${esc(curCode(ta.cur))}</div>`:""}
  ${diffW && !lk ? `<div class="alert warn">Кошельки сторон разные. Это допустимо, но пока к платежу не привязана внутренняя операция, он в списке «Требует оформления» и подсвечен казначеям обоих кошельков (ТР-57).
    ${linked?`<br>Привязана операция <a class="lnk" onclick="openOp('${linked.id}')">${esc(linked.no)}</a> — ${esc(OP_KINDS[linked.kind].name)}.`:""}</div>`:""}
  ${linkBlock}
  ${versionsBlock(d)}`;
}
/* ============================================================
   13. БЕЗ КОШЕЛЬКА (ТР-23), ТРЕБУЕТ ОФОРМЛЕНИЯ (ТР-57), ИЗМЕНЕНИЯ В ЗАКРЫТОМ ПЕРИОДЕ (ТР-56)
   ============================================================ */
async function assignWallet(docId, where, wid){
  const r = await mutate(`/api/docs/${encodeURIComponent(docId)}/wallets`, {changes:[{where:String(where), wallet:wid||""}]});
  if(!r.ok){ showErrors(r); render(); } else toast(`Кошелёк «${nm(wal(wid))}» назначен`, {lvl:"ok"});
}
async function rulesToEmpty(){
  const r = await mutate("/api/rules/apply-empty");
  if(!r.ok) return showErrors(r);
  alert(`Заполнено строк: ${r.result}`);
}
let NW_SEL = new Set(), NW_W = "";
function nwRows(){
  const rows = [];
  DB.docs.forEach(d=>{ if(!docCounts(d)) return;
    if(d.type==="ПЕР"){ ["from","to"].forEach(s=>{ if(!d[s].wallet) rows.push({d, where:s, sum:d[s].sum*(s==="from"?-1:1), cur:acc(d[s].acc)?.cur, org:d[s].org, acc:d[s].acc, l:d[s]}); }); }
    else d.lines.forEach((l,i)=>{ if(!l.wallet) rows.push({d, where:String(l.idx ?? i), sum:DOC_TYPES[d.type].sign*l.sum, cur:d.cur, org:d.org, acc:d.acc, l}); });
  });
  rows.forEach(r=>{ r.key = r.d.id+"|"+r.where; r.locked = !!periodError(r.d.date); });
  rows.sort((a,b)=>a.d.date<b.d.date?1:-1);
  return rows;
}
function nwToggle(key, on){ on ? NW_SEL.add(key) : NW_SEL.delete(key); render(); }
function nwAll(on){ const R = nwRows().slice(0,500).filter(r=>!r.locked); NW_SEL = on ? new Set(R.map(r=>r.key)) : new Set(); render(); }
async function nwAssign(){
  if(!NW_W){ toast("Выберите кошелёк, который назначить", {lvl:"err"}); return; }
  const rows = nwRows().filter(r=>NW_SEL.has(r.key)); if(!rows.length) return;
  const byDoc = {}; rows.forEach(r=>{ (byDoc[r.d.id] = byDoc[r.d.id]||[]).push({where:String(r.where), wallet:NW_W}); });
  busy(true); let ok = 0, bad = [];
  try{ for(const [id, changes] of Object.entries(byDoc)){
      const r = await apiRaw(`/api/docs/${encodeURIComponent(id)}/wallets`, {changes});
      if(r.ok) ok += changes.length; else { const d = byId(DB.docs,id); bad.push(`${d?(d.no1c||d.no):id}: ${r.errors.join("; ")}`); } }
    await reloadState();
  } finally { busy(false); }
  const w = nm(wal(NW_W)); NW_SEL = new Set(); render();
  if(ok) toast(`Кошелёк «${w}» назначен строкам: ${ok}`, {lvl:"ok"});
  if(bad.length) toast(`Не удалось назначить (${bad.length}):\n` + bad.slice(0,5).join("\n"), {lvl:"err"});
}
function viewNoWallet(){
  const u = me(); const rows = nwRows(); const can = canEnter(u);
  const shown = rows.slice(0,500); const keys = new Set(rows.map(r=>r.key)); NW_SEL = new Set([...NW_SEL].filter(k=>keys.has(k)));
  const selectable = shown.filter(r=>!r.locked); const n = NW_SEL.size; const allOn = selectable.length && selectable.every(r=>NW_SEL.has(r.key));
  const byCur = {}; rows.forEach(r=>byCur[r.cur]=(byCur[r.cur]||0)+r.sum);
  return `<h1>Без кошелька <span class="tzref">ТР-23</span></h1>
  <p class="lede">Строки, где правило автозаполнения не сработало. Они видны отдельной группой «Без кошелька» во всех отчётах и не теряются из итогов. Выберите кошелёк — изменение попадёт в версию документа и журнал аудита. Можно отметить несколько строк и назначить кошелёк всем сразу.</p>
  ${can && n ? `<div class="bulkbar" role="region" aria-label="Действия с отмеченными строками">
    <b>Отмечено строк: ${n}</b>
    <label class="fld"><span>Кошелёк</span><select onchange="NW_W=this.value">${optsWallets(NW_W,CUR.date,{onlyEditable:!isAdmin(u),empty:"— выберите —"})}</select></label>
    <button type="button" class="btn primary" onclick="nwAssign()">Назначить отмеченным</button>
    <button type="button" class="btn ghost" onclick="NW_SEL=new Set();render()">Снять отметки</button></div>` : ""}
  <div class="panel"><header><h2>${rows.length} ${plural(rows.length,"строка","строки","строк")}</h2>${Object.entries(byCur).map(([c,v])=>`<span class="tag">${fmtS(r2(v))} ${esc(curCode(c))}</span>`).join(" ")}<div style="flex:1"></div>
    ${isAdmin(u)?`<button class="btn" onclick="rulesToEmpty()">Применить правила ко всем</button>`:""}${exportBtn("tNoW","Без кошелька")}</header>
  <div class="body flush"><div class="tbl-wrap"><table id="tNoW" class="sortable list-t"><thead><tr>${can?`<th class="nosort chkcol"><input type="checkbox" aria-label="Отметить все" ${allOn?"checked":""} onchange="nwAll(this.checked)"></th>`:""}<th>Дата</th><th>Документ</th><th>Организация и счёт</th><th class="num">Сумма</th><th>Тип расхода CF</th><th>Контрагент</th><th class="nosort" style="min-width:200px">Кошелёк</th></tr></thead>
  <tbody>${shown.map(r=>`<tr class="${NW_SEL.has(r.key)?"sel":""}">${can?`<td class="chkcol">${r.locked?"":`<input type="checkbox" aria-label="Отметить строку" ${NW_SEL.has(r.key)?"checked":""} onchange="nwToggle('${r.key}',this.checked)">`}</td>`:""}
    <td class="nowrap">${fmtD(r.d.date)}</td><td><a class="lnk" onclick="openDoc('${r.d.id}')">${r.d.type} ${esc(r.d.no1c||r.d.no)}</a>${r.l.purpose?`<div class="sub">${esc(r.l.purpose)}</div>`:""}</td>
    <td>${esc(nm(org(r.org)))}<div class="sub">${esc(nm(acc(r.acc)))}${r.l.dept?` · ${esc(refName(DB.depts,r.l.dept))}`:""}</div></td>
    <td class="num ${r.sum<0?"neg":"pos"}">${fmtS(r.sum)}<div class="sub">${esc(curCode(r.cur))}</div></td><td>${esc(refName(DB.cfTypes,r.l.cf))}</td><td>${esc(r.l.cpty||"")}</td>
    <td>${can&&!r.locked?`<select onchange="assignWallet('${r.d.id}','${r.where}',this.value)">${optsWallets(null,r.d.date,{onlyEditable:!isAdmin(u),empty:"— выбрать —"})}</select>`:`<span class="muted">${r.locked?"период закрыт":"—"}</span>`}</td></tr>`).join("") || `<tr><td colspan="8" class="empty-cell">Все строки разнесены по кошелькам.</td></tr>`}</tbody></table></div></div></div>`;
}
function formalizeDoc(id){
  const d = byId(DB.docs,id); if(!d) return;
  newOp({kind:"loan", from:d.from.wallet, to:d.to.wallet, date:d.date, linkedDoc:d.id, leg1:{org:d.to.org, acc:d.to.acc, sum:d.to.sum, rate:d.to.rate||rateAt(acc(d.to.acc).cur,d.date)}});
}
function viewFormalize(){
  const u = me(); const list = needsFormalizing().filter(d=>isAdmin(u)||treasurersOf(d.from.wallet).includes(u.id)||treasurersOf(d.to.wallet).includes(u.id)||docVisible(d,u));
  return `<h1>Требует оформления <span class="tzref">ТР-57</span></h1>
  <p class="lede">Платежи между организациями группы, где у списания и поступления разные кошельки. Деньги уже перешли от одного кошелька к другому; привяжите внутреннюю операцию, чтобы зафиксировать, что это — займ, погашение, финансирование или дивиденды. Привязанная операция не меняет остатки повторно, но учитывается в долгах по займам.</p>
  <div class="panel"><div class="body flush"><table><thead><tr><th>Дата</th><th>Документ</th><th>Отправитель</th><th>Получатель</th><th class="num">Сумма</th><th></th></tr></thead>
  <tbody>${list.map(d=>`<tr><td>${fmtD(d.date)}</td><td><a class="lnk" onclick="openDoc('${d.id}')">${esc(d.no)}</a> <span class="muted">${esc(d.op)}</span></td>
    <td>${esc(nm(wal(d.from.wallet)))}<br><span class="muted">${esc(nm(acc(d.from.acc)))}</span></td><td>${esc(nm(wal(d.to.wallet)))}<br><span class="muted">${esc(nm(acc(d.to.acc)))}</span></td>
    <td class="num">${fmt(d.from.sum)} ${esc(curCode(acc(d.from.acc)?.cur))}</td>
    <td>${canEnter(u)?`<button class="btn sm primary" onclick="formalizeDoc('${d.id}')">Оформить</button>`:""}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Нет платежей, требующих оформления</td></tr>`}</tbody></table></div></div>`;
}
function viewClosedCh(){
  const u = me(); let changed = false;
  DB.closedChanges.forEach(c=>{ c.seen = c.seen||[]; if(!c.seen.includes(u.id)){ c.seen.push(u.id); changed = true; } });
  if(changed) setTimeout(()=>{ apiRaw("/api/closed-changes/seen", {}).then(()=>reloadState()).then(()=>{ renderNav(); renderTop(); }); }, 0);
  return `<h1>Изменения в закрытом периоде <span class="tzref">ТР-56</span></h1>
  <p class="lede">1С — мастер-система: изменения её документов в закрытом периоде принимаются, но выводятся сюда администратору и казначеям кошельков.</p>
  <div class="panel"><div class="body flush"><table><thead><tr><th>Когда получено</th><th>Документ</th><th>Дата документа</th><th>Что изменилось</th></tr></thead>
  <tbody>${DB.closedChanges.slice().reverse().map(c=>`<tr><td>${fmtDT(c.t)}</td><td>${byId(DB.docs,c.docId)?`<a class="lnk" onclick="openDoc('${c.docId}')">${esc(c.docNo)}</a>`:esc(c.docNo)}</td><td>${fmtD(c.date)}</td><td style="font-size:11px" class="notr">${esc(c.diff)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Изменений нет</td></tr>`}</tbody></table></div></div>`;
}

/* ============================================================
   14. ВНУТРЕННИЕ ОПЕРАЦИИ (раздел 6)
   ============================================================ */
const OF = {kind:"", from:"", to:"", state:""};
function opVisible(o, u){ u = u||me(); const V = visibleWallets(u); return isAdmin(u) || V.has(o.from) || V.has(o.to); }
function opState(o){
  if(o.deleted) return `<span class="tag off">помечена на удаление</span>`;
  if(!o.posted) return `<span class="tag warn">черновик${o.kind==="exchange"&&!opComplete(o)?" — нет второй ноги":""}</span>`;
  if(o.linkedDoc) return `<span class="tag">оформляет платёж</span>`;
  return `<span class="tag ok">проведена</span>`;
}
function viewOps(){
  const u = me();
  let list = DB.ops.filter(o=>opVisible(o,u));
  if(OF.kind) list = list.filter(o=>o.kind===OF.kind);
  if(OF.from) list = list.filter(o=>o.date>=OF.from); if(OF.to) list = list.filter(o=>o.date<=OF.to);
  if(OF.state==="draft") list = list.filter(o=>!o.posted && !o.deleted); else if(OF.state==="del") list = list.filter(o=>o.deleted);
  list.sort((a,b)=>a.date<b.date?1:-1);
  return `<h1>Внутренние операции</h1>
  <p class="lede">Движения между кошельками без платежа в 1С. Деньги остаются на том же счёте, меняется только кошелёк-владелец (ТР-27). Вводит казначей, подтверждение не нужно, правка открыта до закрытия периода.</p>
  <div class="toolbar">
    <label class="fld"><span>Вид</span><select onchange="OF.kind=this.value;render()"><option value="">Все виды</option>${Object.entries(OP_KINDS).map(([k,t])=>`<option value="${k}" ${OF.kind===k?"selected":""}>${esc(t.name)}</option>`).join("")}</select></label>
    <label class="fld"><span>Дата с</span><input type="date" value="${OF.from}" onchange="OF.from=this.value;render()"></label>
    <label class="fld"><span>по</span><input type="date" value="${OF.to}" onchange="OF.to=this.value;render()"></label>
    <div class="fld"><span>Состояние</span>${seg(OF.state,[["","Все"],["draft","Черновики"],["del","На удаление"]],"OF.state")}</div>
    <div class="grow"></div>
    ${canEnter(u)?`<button type="button" class="btn primary" onclick="newOp()">Новая операция</button><button type="button" class="btn" onclick="newOp({kind:'exchange'})">Обмен на двух счетах</button>`:""}
    ${exportBtn("tOps","Внутренние операции")}
  </div>
  <div class="panel"><header><h2>${list.length} ${plural(list.length,"операция","операции","операций")}</h2></header><div class="body flush"><div class="tbl-wrap"><table id="tOps" class="list-t sortable"><thead><tr><th>Дата</th><th>Операция</th><th>Откуда → куда</th><th>Счёт или касса</th><th class="num">Сумма</th><th class="num">USD</th><th>Состояние</th></tr></thead>
  <tbody>${list.map(o=>{ const L = opLegs(o);
    return `<tr class="clickable ${opCounts(o)||(o.linkedDoc&&!o.deleted)?"":"excl"}" onclick="openOp('${o.id}')"><td class="nowrap">${fmtD(o.date)}</td>
    <td><a class="lnk">${esc(o.no||"черновик")}</a><div class="sub"><span>${esc(OP_KINDS[o.kind].name)}</span>${o.contract?` · <span>${esc(nm(contract(o.contract)))}</span>`:""}</div></td>
    <td>${esc(nm(wal(o.from)))} <span class="muted">→</span> ${esc(nm(wal(o.to)))}<div class="sub">${esc(nm(usr(o.author)))}</div></td>
    <td>${L.map(l=>`${l.n===2?"нога 2: ":o.kind==="exchange"?"нога 1: ":""}${esc(nm(acc(l.acc)))}`).join("<br>")}</td>
    <td class="num">${L.map(l=>`${fmt(l.sum)} <span class="muted">${esc(curCode(l.cur))}</span>`).join("<br>")}</td><td class="num">${L.map(l=>fmt(l.usd)).join("<br>")}</td>
    <td>${opState(o)}</td></tr>`; }).join("") || `<tr><td colspan="7" class="empty-cell">Операций нет${canEnter(u)?`<br><button type="button" class="btn sm primary" style="margin-top:10px" onclick="newOp()">Создать первую операцию</button>`:""}</td></tr>`}</tbody></table></div></div></div>`;
}

let OE = null, OEerr = null, OEwarn = null;
function newOp(pre){
  const u = me(); if(!canEnter(u)) return;
  OE = Object.assign({id:uid("O"), no:"", date:CUR.date, kind:"loan", from:null, to:null, contract:"", comment:"",
    leg1:{org:"",acc:"",sum:null,rate:null}, leg2:{org:"",acc:"",sum:null,rate:null}, sameCur:true,
    author:u.id, created:new Date().toISOString(), posted:false, deleted:false, linkedDoc:null, versions:[]}, clone(pre||{}));
  if(OE.leg1 && OE.leg1.acc && !OE.leg1.org) OE.leg1.org = acc(OE.leg1.acc)?.org || "";
  if(!isAdmin(u) && !OE.from){ const own = [...ownWallets(u)].filter(id=>!walletClosedAt(id,OE.date)); if(own.length===1) OE.from = own[0]; }
  if(!OE.leg1.org){ const L = lastPick("op"); const activeOrgs = DB.orgs.filter(o=>isActiveAt(o,OE.date));
    if(L && activeOrgs.some(o=>o.id===L.org)){ OE.leg1.org = L.org; const a = acc(L.acc); if(a && a.org===L.org && isActiveAt(a,OE.date)) OE.leg1.acc = L.acc; }
    else if(activeOrgs.length===1) OE.leg1.org = activeOrgs[0].id;
    if(OE.leg1.org && !OE.leg1.acc){ const one = onlyAccount(OE.leg1.org, null); if(one) OE.leg1.acc = one.id; }
    const a = acc(OE.leg1.acc); if(a && !OE.leg1.rate) OE.leg1.rate = rateAt(a.cur, OE.date); }
  if(!pre || !pre.linkedDoc){ const dr = readDraft("op"); if(dr && hasContent(dr)) OE._draft = dr; }
  OEerr = null; OEwarn = null; openOpModal();
}
function saveOpDraft(){ if(!OE || byId(DB.ops,OE.id) || OE.linkedDoc || !hasContent(OE)) return; try{ localStorage.setItem(draftKey("op"), JSON.stringify(cleanDraft(OE))); }catch(e){} }
function restoreOpDraft(){ const d = OE._draft; delete d._saved; OE = Object.assign(d, {id:uid("O")}); MODAL.title = `${esc(OP_KINDS[OE.kind].name)} (новая)`; refreshModal(); }
function openOp(id){ const o = byId(DB.ops,id); if(!o) return; OE = clone(o); OEerr=null; OEwarn=null; openOpModal(); }
function opEditable(){
  const u = me(); const o = OE; if(!canEnter(u)) return false;
  if(periodError(o.date)) return false;
  const orig = byId(DB.ops,o.id);
  if(orig && !isAdmin(u) && !canEditWallet(u,orig.from) && !canEditWallet(u,orig.to)) return false;
  return true;
}
function openOpModal(){
  openModal({width:1080, title:`${esc(OP_KINDS[OE.kind].name)} ${OE.no?`№ ${esc(OE.no)}`:"(новая)"}`, body:opBody, footer:opFooter,
    submit:()=>{ if(opEditable() && !OE.deleted) saveOp(true); }, submitLabel:"провести", onRender:saveOpDraft, onChange:saveOpDraft});
}
function oeSet(k, v){
  OE[k] = v;
  if(k==="kind"){ MODAL.title = `${esc(OP_KINDS[v].name)} ${OE.no?`№ ${esc(OE.no)}`:"(новая)"}`; if(v!=="loan"&&v!=="repay") OE.contract = ""; }
  if(k==="date"){ ["leg1","leg2"].forEach(L=>{ const a = acc(OE[L].acc); if(a && OE[L]._autoRate!==false) OE[L].rate = rateAt(a.cur, v); }); }
  if(["from","to","kind"].includes(k) && (OE.kind==="loan"||OE.kind==="repay")){
    const c = contract(OE.contract); const [L,B] = OE.kind==="loan" ? [OE.from,OE.to] : [OE.to,OE.from];
    if(!c || c.lender!==L || c.borrower!==B){ const m = DB.contracts.filter(x=>x.lender===L && x.borrower===B); OE.contract = m.length===1 ? m[0].id : ""; }
  }
  refreshModal();
}
function legSet(L, k, v){
  const G = OE[L]; G[k] = v;
  if(k==="org"){ G.acc = ""; const one = v && onlyAccount(v, null); if(one && (!L.startsWith("leg2") || !OE.sameCur || !acc(OE.leg1.acc) || one.cur===acc(OE.leg1.acc).cur)){ G.acc = one.id; G.rate = rateAt(one.cur, OE.date); G._autoRate = true; } }
  if(k==="acc"){ const a = acc(v); G.rate = a ? rateAt(a.cur, OE.date) : null; G._autoRate = true;
    if(L==="leg1" && OE.kind==="exchange" && OE.sameCur){ const b = acc(OE.leg2.acc); if(b && a && b.cur!==a.cur){ OE.leg2.acc=""; OE.leg2.rate=null; } } }
  if(k==="rate") G._autoRate = false;
  refreshModal();
}
function legBlock(L, title, {curFilter=null, cls=""}={}){
  const G = OE[L]; const a = acc(G.acc); const ed = opEditable(); const dis = ed?"":"disabled";
  const erp = a ? rateAt(a.cur, OE.date) : null;
  return `<fieldset class="leg ${cls}"><legend>${title}</legend><div class="grid2">
    <label class="fld"><span>Организация <em>*</em></span><select ${dis} onchange="legSet('${L}','org',this.value)">${opts(DB.orgs,G.org)}</select></label>
    <label class="fld ${fi(L+".acc",OE)}"><span>Счёт или касса <em>*</em></span><select ${dis} onchange="legSet('${L}','acc',this.value)">${optsAccounts(G.org,G.acc,{curId:curFilter})}</select>
      ${fe(L+".acc",OE)||(curFilter?`<small>Только счета в ${esc(curCode(curFilter))} — «Обмен в одной валюте» (ТР-77, МД-19)</small>`:"")}</label>
    <label class="fld ${fi(L+".sum",OE)}"><span>Сумма <em>*</em></span>${sumWithCur(ed?moneyInput({id:`${L}_sum`, value:G.sum, onchange:`legSet('${L}','sum',parseNum(this.value))`}):`<span class="num">${fmt(G.sum)}</span>`, a&&a.cur)}${fe(L+".sum",OE)}</label>
    <label class="fld ${fi(L+".rate",OE)}"><span>Курс: ${a?esc(curCode(a.cur)):"единиц валюты"} за 1 USD <em>*</em></span>
      ${a && isUSD(a.cur) ? `<input type="text" readonly value="1">` : ed ? moneyInput({id:`${L}_rate`, value:G.rate, dec:6, placeholder:"3,6725", onchange:`legSet('${L}','rate',parseNum(this.value))`}) : `<span class="num">${fmtRate(G.rate)}</span>`}
      <small>${erp?`Курс ERP на ${fmtD(OE.date)}: ${fmtRate(erp)}${G.rate&&Math.abs(G.rate-erp)>1e-9?` · <a class="lnk" onclick="legSet('${L}','rate',${erp})">подставить</a>`:""}`:a?`<span class="neg">нет курса ERP на дату — введите вручную</span>`:""}
      ${G.sum>0&&G.rate>0?` · <b>${fmt(r2(G.sum/G.rate))} USD</b>`:""}</small>${fe(L+".rate",OE)}</label>
  </div></fieldset>`;
}
function opBody(){
  const o = OE; const u = me(); const ed = opEditable(); const dis = ed?"":"disabled"; const K = OP_KINDS[o.kind];
  const loan = o.kind==="loan"||o.kind==="repay";
  const fromFilter = o.kind==="funding" ? w=>w.head : null;
  const toFilter = o.kind==="dividends" ? w=>w.head : null;
  const legs = opLegs(o);
  const linked = o.linkedDoc ? byId(DB.docs,o.linkedDoc) : null;
  const l1a = acc(o.leg1.acc);
  const reason = !canEnter(u) ? "Ваша роль — только просмотр." : periodError(o.date) || (!ed ? "Операция по чужим кошелькам — только просмотр." : "");
  const allE = o._tried ? validateOp(o, o._post).e : [];
  return `${reason?`<div class="alert warn">${esc(reason)}</div>`:""}${draftBanner(o,"restoreOpDraft()","dropDraft('op');OE._draft=null;refreshModal()")}
  ${errSummary(o, allE, OEerr)}
  ${OEwarn?`<div class="alert warn"><b>Проверьте перед проведением:</b><ul>${OEwarn.map(e=>`<li>${esc(e)}</li>`).join("")}</ul>Если всё верно, нажмите «Провести всё равно».</div>`:""}
  ${o.deleted?`<div class="alert err">Операция помечена на удаление и не участвует в расчёте (ТР-74).</div>`:""}
  ${linked?`<div class="alert ok">Оформляет платёж <a class="lnk" onclick="openDoc('${linked.id}')">${esc(linked.no)}</a> от ${fmtD(linked.date)} (${esc(nm(wal(linked.from.wallet)))} → ${esc(nm(wal(linked.to.wallet)))}). Деньги уже перешли этим платежом, поэтому операция не меняет остатки ещё раз — она фиксирует характер перевода и долг по займу (ТР-57).</div>`:""}
  <div class="grid2">
    <label class="fld"><span>Вид операции <em>*</em></span><select ${dis} onchange="oeSet('kind',this.value)">${Object.entries(OP_KINDS).filter(([k])=>!linked||["loan","repay","funding","dividends"].includes(k)).map(([k,t])=>`<option value="${k}" ${o.kind===k?"selected":""}>${esc(t.name)}</option>`).join("")}</select></label>
    <label class="fld ${fi("date",o)}"><span>Дата <em>*</em></span><input type="date" ${dis} value="${o.date}" onchange="oeSet('date',this.value)">${fe("date",o)}</label>
    <label class="fld ${fi("from",o)}"><span>${esc(K.from)} <em>*</em></span><select ${dis} onchange="oeSet('from',this.value||null)">${optsWallets(o.from,o.date,{empty:"— выберите —",filter:fromFilter})}</select>
      ${fe("from",o)||(o.kind==="funding"?`<small>Только головной кошелёк</small>`:"")}</label>
    <label class="fld ${fi("to",o)}"><span>${esc(K.to)} <em>*</em></span><select ${dis} onchange="oeSet('to',this.value||null)">${optsWallets(o.to,o.date,{empty:"— выберите —",filter:toFilter})}</select>
      ${fe("to",o)||(o.kind==="dividends"?`<small>Только головной кошелёк</small>`:"")}</label>
    ${loan?`<label class="fld ${fi("contract",o)}"><span>Договор займа <em>*</em></span><div class="row"><select style="flex:1" ${dis} onchange="oeSet('contract',this.value)">${opts(DB.contracts.filter(c=>o.kind==="loan"?(c.lender===o.from&&c.borrower===o.to):(c.lender===o.to&&c.borrower===o.from)),o.contract,{empty:"— выберите —"})}</select>
      ${ed?`<button class="btn sm" onclick="openContract(null,true)">Новый</button>`:""}</div>${fe("contract",o)||`<small>Долг ведётся в USD по договору (ТР-28, ТР-40)</small>`}</label>`:""}
    ${o.kind==="exchange"?`<label class="fld"><span>Вид обмена</span><select ${dis} onchange="OE.sameCur=this.value==='1';if(OE.sameCur){const a=acc(OE.leg1.acc),b=acc(OE.leg2.acc);if(a&&b&&a.cur!==b.cur){OE.leg2.acc='';}}refreshModal()"><option value="1" ${o.sameCur?"selected":""}>Обмен в одной валюте</option><option value="0" ${!o.sameCur?"selected":""}>Обмен в разной валюте</option></select></label>`:""}
    <label class="fld" style="grid-column:1/-1"><span>Комментарий</span><input type="text" ${dis} value="${esc(o.comment)}" onchange="OE.comment=this.value"></label>
  </div>
  <p class="muted">Поля «Подразделение» нет: достаточно кошелька-отправителя и кошелька-получателя (ТР-26, МД-16).</p>
  ${o.kind==="exchange" ? `
    <p class="muted" style="margin:4px 0 8px">Один документ с двумя ногами (ТР-76). Нога 1 — на счёте А кошелёк X отдаёт кошельку Y; нога 2 — на счёте Б кошелёк Y отдаёт взамен кошельку X. Документ не проводится, пока не заполнены обе ноги.</p>
    ${legBlock("leg1", `Нога 1 · счёт А · <b>${esc(o.from?wname(o.from):"X")}</b> → <b>${esc(o.to?wname(o.to):"Y")}</b>`)}
    ${legBlock("leg2", `Нога 2 · счёт Б · <b>${esc(o.to?wname(o.to):"Y")}</b> → <b>${esc(o.from?wname(o.from):"X")}</b>`, {cls:"b", curFilter: o.sameCur && l1a ? l1a.cur : null})}`
  : legBlock("leg1", linked ? "Сумма займа / перевода (для учёта долга)" : "Счёт или касса — деньги остаются на нём, меняется владелец (ТР-27)")}
  ${legs.length?`<div class="alert ok">${legs.map(l=>`${l.n===2?"Нога 2":"Проводка"}: ${esc(nm(acc(l.acc)))} — ${esc(nm(wal(l.from)))} −${fmt(l.sum)} ${esc(curCode(l.cur))}, ${esc(nm(wal(l.to)))} +${fmt(l.sum)} ${esc(curCode(l.cur))} · ${fmt(l.usd)} USD`).join("<br>")}${linked?"<br><i>Остатки не меняются — платёж уже проведён.</i>":""}</div>`:""}
  <p class="who">Автор: ${esc(nm(usr(o.author)))} · создана ${fmtDT(o.created)}</p>
  ${versionsBlock(o)}`;
}
function opFooter(){
  const o = OE; const ed = opEditable(); const orig = byId(DB.ops,o.id);
  return `${orig && ed ? `<button class="btn danger" style="margin-right:auto" onclick="toggleOpDelete()">${o.deleted?"Снять пометку удаления":"Пометить на удаление"}</button>`:""}
    ${ed && !orig && !o.linkedDoc ? `<span class="muted draft-hint">Черновик сохраняется автоматически</span>`:""}
    <button class="btn" onclick="closeModal()">${ed?"Отмена":"Закрыть"}</button>
    ${ed && !o.deleted ? `${o.kind==="exchange"?`<button class="btn" onclick="saveOp(false)">Записать черновик</button>`:""}<button class="btn primary" onclick="${OEwarn?"OE._warnOk=true;":""}saveOp(true)">${OEwarn?"Провести всё равно":"Провести"}</button>`:""}`;
}
function validateOp(o, post){
  const e = [], w = [], F = {}; const u = me(); const K = OP_KINDS[o.kind]; const add = (k, m) => { e.push(m); if(k && !F[k]) F[k] = m; };
  const pe = periodError(o.date); if(pe) add("date", pe);
  if(!o.from) add("from", `Не выбран ${K.from.toLowerCase()}`); if(!o.to) add("to", `Не выбран ${K.to.toLowerCase()}`);
  if(o.from && o.from===o.to) add("to", "Отправитель и получатель совпадают");
  if(o.from && walletClosedAt(o.from,o.date) && o.kind!=="closeDiv") add("from", `Кошелёк «${nm(wal(o.from))}» закрыт (ТР-25)`);
  if(o.to && walletClosedAt(o.to,o.date)) add("to", `Кошелёк «${nm(wal(o.to))}» закрыт (ТР-25)`);
  if(o.kind==="funding" && o.from && !wal(o.from).head) add("from", "Безвозмездное финансирование выдаёт только головной кошелёк");
  if(o.kind==="dividends" && o.to && !wal(o.to).head) add("to", "Дивиденды получает только головной кошелёк");
  if((o.kind==="loan"||o.kind==="repay") && !o.contract) add("contract", "Не выбран договор займа");
  if(!isAdmin(u) && ![o.from,o.to].some(x=>x && canEditWallet(u,x))) add("", "Казначей вводит операции по своим кошелькам: одна из сторон должна быть вашим кошельком");
  const chk = (L, t) => { const G = o[L]; if(!G.acc) add(L+".acc", `${t}: не выбран счёт или касса`); if(!(G.sum>0)) add(L+".sum", `${t}: сумма должна быть больше нуля`); if(!(G.rate>0)) add(L+".rate", `${t}: не указан курс к USD`); };
  if(post || o.kind!=="exchange") chk("leg1", o.kind==="exchange"?"Нога 1":"Счёт");
  if(o.kind==="exchange" && post) chk("leg2", "Нога 2 (документ не проводится без второй ноги)");
  if(o.kind==="exchange"){ const a = acc(o.leg1.acc), b = acc(o.leg2.acc);
    if(a && b && a.id===b.id) add("leg2.acc", "Ноги обмена должны быть на разных счетах");
    if(a && b && o.sameCur && a.cur!==b.cur) add("leg2.acc", "Обмен в одной валюте: валюта счёта Б должна совпадать с валютой счёта А (ТР-77)"); }
  if(!o.linkedDoc && post){ // предупреждение о минусе (разрешён, ТР-24)
    opLegs(o).forEach(L=>{ const cur = facts().filter(f=>f.wallet===L.from && f.acc===L.acc && f.date<=o.date && !(f.src.k==="op"&&f.src.id===o.id)).reduce((s,f)=>s+f.sum,0);
      if(cur - L.sum < -0.005) w.push(`У кошелька «${nm(wal(L.from))}» на счёте «${nm(acc(L.acc))}» станет отрицательный остаток: ${fmt(r2(cur-L.sum))} ${curCode(L.cur)}. Это разрешено, казначей и администратор получат уведомление (ТР-24).`); });
  }
  o._fe = F;
  return {e, w};
}
function opPayload(o){
  const leg = L => ({acc:L.acc||"", sum:L.sum, rate:L.rate});
  return {id: byId(DB.ops,o.id) ? o.id : "", kind:o.kind, date:o.date, from:o.from||"", to:o.to||"", contract:o.contract||"", comment:o.comment||"",
    leg1:leg(o.leg1||{}), leg2:leg(o.leg2||{}), sameCur:!!o.sameCur, linkedDoc:o.linkedDoc||""};
}
async function saveOp(post){
  const o = OE; o._tried = true; o._post = post; OEerr = null; const {e, w} = validateOp(o, post);
  if(e.length){ OEwarn = null; refreshModal(); focusFirstError(); return; }
  if(w.length && !o._warnOk){ OEwarn = w; refreshModal(); return; }
  const isNew = !byId(DB.ops, o.id);
  const r = await mutate("/api/ops", {op:opPayload(o), post});
  if(!r.ok){ OEerr = r.errors; refreshModal(); return; }
  if(isNew && !o.linkedDoc){ dropDraft("op"); try{ localStorage.setItem("wallets-last-op", JSON.stringify({org:o.leg1.org, acc:o.leg1.acc})); }catch(x){} }
  OEwarn = null; closeModal();
  toast(`Операция ${(r.result&&r.result.no)||o.no||""} ${post||o.kind!=="exchange"?"проведена":"записана как черновик"}`, {lvl:"ok"});
}
async function toggleOpDelete(){
  const id = OE.id, was = !!OE.deleted, no = OE.no;
  const r = await mutate(`/api/ops/${encodeURIComponent(id)}/delete`);
  if(!r.ok){ OEerr = r.errors; refreshModal(); return; }
  closeModal();
  toast(was ? `Снята пометка удаления: ${no}` : `Операция ${no} помечена на удаление`, {action: async()=>{ const x = await mutate(`/api/ops/${encodeURIComponent(id)}/delete`); x.ok ? toast("Отменено", {lvl:"ok"}) : showErrors(x); }});
}
/* --- договор займа --- */
let CE = null;
function openContract(id, fromOp){
  const back = fromOp ? {OE:clone(OE)} : null;
  const [L,B] = fromOp ? (OE.kind==="loan"?[OE.from,OE.to]:[OE.to,OE.from]) : [null,null];
  CE = id ? clone(contract(id)) : {id:uid("C"), name:"", lender:L, borrower:B, created:new Date().toISOString()};
  const reopen = () => { if(back){ OE = back.OE; } closeModal(); };
  openModal({title:"Договор займа между кошельками", width:640, body:()=>`<div class="stack">
    <label class="fld"><span>Наименование <em>*</em></span><input type="text" id="ceName" value="${esc(CE.name)}" onchange="CE.name=this.value"></label>
    <label class="fld"><span>Займодавец <em>*</em></span><select onchange="CE.lender=this.value">${optsWallets(CE.lender,CUR.date,{empty:"— выберите —"})}</select></label>
    <label class="fld"><span>Заёмщик <em>*</em></span><select onchange="CE.borrower=this.value">${optsWallets(CE.borrower,CUR.date,{empty:"— выберите —"})}</select></label>
    <span class="muted">Валюта долга — USD. Проценты и графики не ведутся (ТР-29).</span></div>`,
    footer:()=>`<button class="btn" id="ceCancel">Отмена</button><button class="btn primary" id="ceSave">Сохранить</button>`});
  $("#ceCancel").onclick = reopen;
  $("#ceSave").onclick = async () => {
    CE.name = $("#ceName").value.trim();
    if(!CE.name || !CE.lender || !CE.borrower || CE.lender===CE.borrower){ toast("Заполните наименование и два разных кошелька", {lvl:"err"}); return; }
    const r = await mutate("/api/contracts", {name:CE.name, lender:CE.lender, borrower:CE.borrower});
    if(!r.ok) return showErrors(r);
    if(back){ back.OE.contract = r.result.id; }
    reopen();
  };
}
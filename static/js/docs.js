"use strict";
/* ============================================================
   12. ДОКУМЕНТЫ: СПИСОК, ПРОСМОТР, РУЧНОЙ ВВОД (раздел 3а)
   ============================================================ */
const DF = {src:"", type:"", org:"", from:"", to:"", q:"", state:""};
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
  list.sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0);
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
function viewDocs(){
  const u = me(); const list = docsFiltered();
  const shown = list.slice(0,DOCLIM);
  const can = canEnter(u);
  const sw = DB.settings.switchDate;
  return `<h1>Документы</h1>
  <p class="lede">Расходы (СБДС, РКО) приходят из 1С — файлом, позже через шлюз; здесь у них можно только назначить кошелёк. Поступления, конвертации и переброски пока вводятся вручную (ТР-68).${sw?` С ${fmtD(sw)} ручной ввод отключён — данные приходят из 1С (ТР-72).`:""}</p>
  <div class="panel"><div class="body filters">
    <label class="fld"><span>Источник</span><select onchange="DF.src=this.value;render()"><option value="">Все</option><option value="file" ${DF.src==="file"?"selected":""}>Из файла 1С</option><option value="manual" ${DF.src==="manual"?"selected":""}>Ручной ввод</option></select></label>
    <label class="fld"><span>Тип</span><select onchange="DF.type=this.value;render()"><option value="">Все</option>${Object.entries(DOC_TYPES).map(([k,t])=>`<option value="${k}" ${DF.type===k?"selected":""}>${k} — ${esc(t.name)}</option>`).join("")}</select></label>
    <label class="fld"><span>Организация</span><select onchange="DF.org=this.value;render()">${opts(DB.orgs,DF.org,{empty:"Все"})}</select></label>
    <label class="fld"><span>С</span><input type="date" value="${DF.from}" onchange="DF.from=this.value;render()"></label>
    <label class="fld"><span>По</span><input type="date" value="${DF.to}" onchange="DF.to=this.value;render()"></label>
    <label class="fld"><span>Состояние</span><select onchange="DF.state=this.value;render()"><option value="">Все</option><option value="in" ${DF.state==="in"?"selected":""}>В расчёте</option><option value="out" ${DF.state==="out"?"selected":""}>Вне расчёта</option></select></label>
    <label class="fld"><span>Поиск</span><input type="text" value="${esc(DF.q)}" placeholder="номер, GUID, контрагент" onchange="DF.q=this.value;render()"></label>
  </div></div>
  <div class="panel"><header><h2>${list.length} документов${list.length>DOCLIM?` (показаны первые ${DOCLIM})`:""}</h2><div style="flex:1"></div>
    ${can?`<button class="btn primary" onclick="newDoc('ПБДС')">Поступление на счёт</button><button class="btn" onclick="newDoc('ПКО')">Поступление в кассу</button><button class="btn" onclick="newDoc('ПЕР')">Конвертация / переброска</button>`:""}
    <button class="btn" onclick="exportDocs()">Выгрузить в Excel (все ${list.length})</button></header>
  <div class="body flush"><div class="tbl-wrap"><table id="tDocs">
    <thead><tr><th>Дата</th><th>Тип</th><th>Номер</th><th>Хоз. операция</th><th>Организация</th><th>Счёт или касса</th><th class="num">Сумма</th><th>Вал.</th><th>Кошелёк</th><th>Источник</th><th>Состояние</th></tr></thead>
    <tbody>${shown.map(d=>{ const P = d.type==="ПЕР";
      return `<tr class="clickable ${docCounts(d)?"":"excl"}" onclick="openDoc('${d.id}')"><td>${fmtD(d.date)}</td><td>${d.type}</td><td><a class="lnk">${esc(d.no1c||d.no)}</a></td><td>${esc(d.op||"")}</td>
      <td>${P?`${esc(nm(org(d.from.org)))} → ${esc(nm(org(d.to.org)))}`:esc(nm(org(d.org)))}</td>
      <td>${P?`${esc(nm(acc(d.from.acc)))} → ${esc(nm(acc(d.to.acc)))}`:esc(nm(acc(d.acc)))}</td>
      <td class="num ${DOC_TYPES[d.type].sign<0?"neg":DOC_TYPES[d.type].sign>0?"pos":""}">${P?fmt(d.from.sum):fmtS(DOC_TYPES[d.type].sign*docVisTotal(d))}</td>
      <td>${P?`${esc(curCode(acc(d.from.acc)?.cur))}→${esc(curCode(acc(d.to.acc)?.cur))}`:esc(curCode(d.cur))}</td>
      <td>${esc(docWallets(d))}</td><td>${d.source==="file"?"файл 1С":"вручную"}</td><td>${docStateTag(d)}${d.type==="СБДС"&&!d.bankDone&&docCounts(d)?` <span class="tag warn">не исполнен банком</span>`:""}</td></tr>`; }).join("")
      || `<tr><td colspan="11" class="muted">Документов нет</td></tr>`}</tbody></table></div>
    ${list.length>DOCLIM?`<div class="body row"><button class="btn" onclick="DOCLIM+=500;render()">Показать ещё 500</button><button class="btn" onclick="DOCLIM=1e9;render()">Показать все</button></div>`:""}</div></div>`;
}

/* --- просмотр / редактирование --- */
let ED = null, EDerr = null;
function newDoc(type){
  const u = me(); if(!canEnter(u)) return;
  const base = {id:uid("D"), no:"", source:"manual", type, op:MANUAL_OPS[type][0], no1c:"", date1c:"", date:CUR.date, status:"Проведён",
    author:u.id, created:new Date().toISOString(), deleted:false, excluded:false, versions:[], lines:[]};
  const side = () => ({org:"",acc:"",sum:null,wallet:null,wsrc:null,dept:"",cf:"",zone:"",cpty:"",contract:"",purpose:""});
  if(type==="ПЕР"){ Object.assign(base, {from:side(), to:side()}); base.link = {kind:"", contract:""}; }
  else { Object.assign(base, {org:"", acc:"", cur:"", lines:[{sum:null, wallet:null, wsrc:null, dept:"", cf:"", zone:"", cpty:"", contract:"", purpose:""}]}); }
  ED = base; EDerr = null; openDocModal(true);
}
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
  closeModal();
}
/* --- ручной ПБДС / ПКО --- */
function edSet(k, v){ ED[k] = v;
  if(k==="org"){ ED.acc=""; ED.cur=""; }
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
  return `${lockReason()}${EDerr?`<div class="alert err"><ul>${EDerr.map(e=>`<li>${esc(e)}</li>`).join("")}</ul></div>`:""}
  ${d.deleted?`<div class="alert err">Документ помечен на удаление и не участвует в расчёте.</div>`:""}
  <div class="grid2">
    <label class="fld"><span>Хозяйственная операция <em>*</em></span><select ${dis} onchange="edSet('op',this.value)">${MANUAL_OPS[d.type].map(o=>`<option value="${esc(o)}" ${o===d.op?"selected":""}>${esc(o)}</option>`).join("")}</select></label>
    <label class="fld"><span>Дата поступления <em>*</em></span><input type="date" ${dis} value="${d.date}" onchange="edSet('date',this.value)"></label>
    <label class="fld"><span>Организация <em>*</em></span><select ${dis} onchange="edSet('org',this.value)">${opts(DB.orgs.filter(o=>isActiveAt(o,d.date)||o.id===d.org),d.org)}</select></label>
    <label class="fld"><span>${cash?"Касса":"Банковский счёт"} <em>*</em></span><select ${dis} onchange="edSet('acc',this.value)">${optsAccounts(d.org,d.acc,{cash})}</select>
      <small>Список зависит от организации (МД-05)</small></label>
    <label class="fld"><span>Номер документа 1С, если уже есть</span><input type="text" ${dis} value="${esc(d.no1c)}" onchange="ED.no1c=this.value"></label>
    <label class="fld"><span>Дата документа 1С</span><input type="date" ${dis} value="${d.date1c||""}" onchange="ED.date1c=this.value"></label>
  </div>
  <div class="row" style="margin:6px 0 10px"><span class="muted">Валюта: <span class="cur">${esc(d.cur?curCode(d.cur):"—")}</span> из счёта · курс ERP на ${fmtD(d.date)}: ${rate?`${fmtRate(rate)} ${esc(curCode(d.cur))} за 1 USD`:d.cur?`<span class="neg">нет курса</span>`:"—"}</span></div>
  <fieldset><legend>Расшифровка — кошелёк по каждой строке</legend>
  <div class="tbl-wrap" style="max-height:none"><table><thead><tr><th style="min-width:170px">Сумма</th><th class="num">USD</th><th style="min-width:190px">Кошелёк</th><th>Подразделение</th><th>Тип расхода CF</th><th>Зона</th><th>Контрагент</th><th>Договор</th><th>Назначение</th><th></th></tr></thead>
  <tbody>${d.lines.map((l,i)=>!lineVisible(l.wallet)?"":`<tr>
    <td>${sumWithCur(ed?moneyInput({id:`ln${i}`, value:l.sum, onchange:`edLine(${i},'sum',parseNum(this.value))`}):`<span class="num">${fmt(l.sum)}</span>`, d.cur)}</td>
    <td class="num muted">${l.sum>0&&rate?fmt(toUSD(l.sum,d.cur,d.date)):"—"}</td>
    <td><select ${dis} onchange="edLine(${i},'wallet',this.value||null)">${optsWallets(l.wallet,d.date,{onlyEditable:!isAdmin(me())})}</select>
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
  const e = []; const u = me();
  const pe = periodError(d.date); if(pe) e.push(pe);
  if(!manualAllowed(d.date)) e.push(`С ${fmtD(DB.settings.switchDate)} ручной ввод отключён (ТР-72).`);
  if(d.type==="ПЕР"){
    [["from","Отправитель"],["to","Получатель"]].forEach(([s,t])=>{ const S = d[s];
      if(!S.org) e.push(`${t}: не выбрана организация`); if(!S.acc) e.push(`${t}: не выбран счёт или касса`);
      if(!(S.sum>0)) e.push(`${t}: сумма должна быть больше нуля`);
      const a = acc(S.acc); if(a && !rateAt(a.cur,d.date)) e.push(`${t}: нет курса ${curCode(a.cur)} на ${fmtD(d.date)}`);
      if(S.wallet && walletClosedAt(S.wallet,d.date)) e.push(`${t}: кошелёк закрыт (ТР-25)`);
      if(S.wallet && !isAdmin(u) && !canEditWallet(u,S.wallet) && !pickableWallets(u,d.date).some(w=>w.id===S.wallet)) e.push(`${t}: кошелёк недоступен`); });
    if(d.from.acc && d.from.acc===d.to.acc) e.push("Счёт отправителя и получателя совпадают");
    const fa = acc(d.from.acc), ta = acc(d.to.acc);
    if(fa && ta && d.op==="Конвертация валюты" && fa.cur===ta.cur) e.push("Конвертация: валюты счетов должны различаться");
    if(fa && ta && d.op!=="Конвертация валюты" && fa.cur!==ta.cur) e.push("Переброска: валюты счетов различаются — выберите «Конвертация валюты»");
    if(!isAdmin(u) && ![d.from.wallet,d.to.wallet].some(w=>w && canEditWallet(u,w))) e.push("Казначей вводит документы по своим кошелькам: хотя бы одна сторона должна быть вашим кошельком");
  } else {
    if(!d.org) e.push("Не выбрана организация"); if(!d.acc) e.push(DOC_TYPES[d.type].cash?"Не выбрана касса":"Не выбран банковский счёт");
    if(d.acc && !rateAt(d.cur,d.date)) e.push(`Нет курса ${curCode(d.cur)} на ${fmtD(d.date)} — загрузите курсы из 1С`);
    if(!d.lines.length) e.push("Нет строк расшифровки");
    d.lines.forEach((l,i)=>{ if(!(l.sum>0)) e.push(`Строка ${i+1}: сумма должна быть больше нуля`);
      if(l.wallet && walletClosedAt(l.wallet,d.date)) e.push(`Строка ${i+1}: кошелёк закрыт (ТР-25)`);
      if(l.wallet && !canEditWallet(u,l.wallet)) e.push(`Строка ${i+1}: кошелёк «${nm(wal(l.wallet))}» не ваш`); });
  }
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
  const d = ED; const errs = validateManual(d);
  if(errs.length){ EDerr = errs; refreshModal(); return; }
  const r = await mutate("/api/docs/manual", {doc:manualPayload(d), link:d.link||null});
  if(!r.ok){ EDerr = r.errors; refreshModal(); return; }
  closeModal();
}
async function toggleDocDelete(){
  const r = await mutate(`/api/docs/${encodeURIComponent(ED.id)}/delete`);
  if(!r.ok){ EDerr = r.errors; refreshModal(); return; }
  closeModal();
}
/* --- конвертация / переброска одной формой с двумя сторонами (ТР-69, МД-15) --- */
function sideCtx(S){ return {org:S.org, acc:S.acc, dept:S.dept, cf:S.cf, zone:S.zone, cpty:S.cpty}; }
function trSet(side, k, v){
  const S = ED[side]; S[k] = v;
  if(k==="org"){ S.acc = ""; }
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
      <label class="fld"><span>Организация <em>*</em></span><select ${dis} onchange="trSet('${s}','org',this.value)">${opts(activeOn(DB.orgs,d.date,S.org),S.org)}</select></label>
      <label class="fld"><span>Счёт или касса <em>*</em></span><select ${dis} onchange="trSet('${s}','acc',this.value)">${optsAccounts(S.org,S.acc)}</select></label>
      <label class="fld"><span>Сумма <em>*</em></span>${sumWithCur(ed?moneyInput({id:`tr_${s}`, value:S.sum, onchange:`trSet('${s}','sum',parseNum(this.value))`}):`<span class="num">${fmt(S.sum)}</span>`, a&&a.cur)}
        <small>${S.sum>0&&rate?`= ${fmt(toUSD(S.sum,a.cur,d.date))} USD по курсу ${fmtRate(rate)}`:a&&!rate?`<span class="neg">нет курса на дату</span>`:""}</small></label>
      <label class="fld"><span>Кошелёк</span><select ${dis} onchange="trSet('${s}','wallet',this.value||null)">${optsWallets(S.wallet,d.date,{empty:"— без кошелька —"})}</select>
        <small>${S.wsrc==="rule"?`по правилу «${esc(nm(byId(DB.rules,S.rule))||"")}»`:S.wsrc==="manual"?"выбран вручную":""}</small></label>
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
  return `${lockReason()}${EDerr?`<div class="alert err"><ul>${EDerr.map(e=>`<li>${esc(e)}</li>`).join("")}</ul></div>`:""}
  ${d.deleted?`<div class="alert err">Документ помечен на удаление и не участвует в расчёте.</div>`:""}
  <p class="muted" style="margin-top:0">Одна операция — один ввод (ТР-69). В 1С это два документа (СБДС и ПБДС); при проведении здесь формируются две зеркальные записи: списание у отправителя и поступление у получателя.</p>
  <div class="grid2">
    <label class="fld"><span>Вид <em>*</em></span><select ${dis} onchange="edSet('op',this.value)">${MANUAL_OPS.ПЕР.map(o=>`<option value="${esc(o)}" ${o===d.op?"selected":""}>${esc(o)}</option>`).join("")}</select></label>
    <label class="fld"><span>Дата <em>*</em></span><input type="date" ${dis} value="${d.date}" onchange="ED.date=this.value;refreshModal()"></label>
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
  if(!r.ok){ showErrors(r); render(); }
}
async function rulesToEmpty(){
  const r = await mutate("/api/rules/apply-empty");
  if(!r.ok) return showErrors(r);
  alert(`Заполнено строк: ${r.result}`);
}
function viewNoWallet(){
  const u = me(); const rows = [];
  DB.docs.forEach(d=>{ if(!docCounts(d)) return;
    if(d.type==="ПЕР"){ ["from","to"].forEach(s=>{ if(!d[s].wallet) rows.push({d, where:s, sum:d[s].sum*(s==="from"?-1:1), cur:acc(d[s].acc)?.cur, org:d[s].org, acc:d[s].acc, l:{}}); }); }
    else d.lines.forEach((l,i)=>{ if(!l.wallet) rows.push({d, where:String(l.idx ?? i), sum:DOC_TYPES[d.type].sign*l.sum, cur:d.cur, org:d.org, acc:d.acc, l}); });
  });
  rows.sort((a,b)=>a.d.date<b.d.date?1:-1);
  const byCur = {}; rows.forEach(r=>byCur[r.cur]=(byCur[r.cur]||0)+r.sum);
  return `<h1>Без кошелька <span class="tzref">ТР-23</span></h1>
  <p class="lede">Строки, где правило автозаполнения не сработало. Они видны отдельной группой «Без кошелька» во всех отчётах и не теряются из итогов. Выберите кошелёк — изменение попадёт в версию документа и журнал аудита.</p>
  <div class="panel"><header><h2>${rows.length} строк</h2>${Object.entries(byCur).map(([c,v])=>`<span class="tag">${fmtS(r2(v))} ${esc(curCode(c))}</span>`).join(" ")}<div style="flex:1"></div>
    ${isAdmin(u)?`<button class="btn" onclick="rulesToEmpty()">Применить правила ко всем</button>`:""}${exportBtn("tNoW","Без кошелька")}</header>
  <div class="body flush"><div class="tbl-wrap"><table id="tNoW"><thead><tr><th>Дата</th><th>Документ</th><th>Организация</th><th>Счёт или касса</th><th class="num">Сумма</th><th>Вал.</th><th>Подразделение</th><th>Тип расхода CF</th><th>Зона</th><th>Контрагент</th><th>Назначение</th><th style="min-width:200px">Кошелёк</th></tr></thead>
  <tbody>${rows.slice(0,500).map(r=>{ const locked = periodError(r.d.date);
    return `<tr><td>${fmtD(r.d.date)}</td><td><a class="lnk" onclick="openDoc('${r.d.id}')">${r.d.type} ${esc(r.d.no1c||r.d.no)}</a></td><td>${esc(nm(org(r.org)))}</td><td>${esc(nm(acc(r.acc)))}</td>
    <td class="num ${r.sum<0?"neg":"pos"}">${fmtS(r.sum)}</td><td>${esc(curCode(r.cur))}</td><td>${esc(refName(DB.depts,r.l.dept))}</td><td>${esc(refName(DB.cfTypes,r.l.cf))}</td><td>${esc(refName(DB.zones,r.l.zone))}</td><td>${esc(r.l.cpty||"")}</td><td style="font-size:11px">${esc(r.l.purpose||"")}</td>
    <td>${canEnter(u)&&!locked?`<select onchange="assignWallet('${r.d.id}','${r.where}',this.value)">${optsWallets(null,r.d.date,{onlyEditable:!isAdmin(u),empty:"— выбрать —"})}</select>`:`<span class="muted">${locked?"период закрыт":"—"}</span>`}</td></tr>`; }).join("") || `<tr><td colspan="12" class="muted">Все строки разнесены по кошелькам</td></tr>`}</tbody></table></div></div></div>`;
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
  <div class="panel"><div class="body filters">
    <label class="fld"><span>Вид</span><select onchange="OF.kind=this.value;render()"><option value="">Все</option>${Object.entries(OP_KINDS).map(([k,t])=>`<option value="${k}" ${OF.kind===k?"selected":""}>${esc(t.name)}</option>`).join("")}</select></label>
    <label class="fld"><span>С</span><input type="date" value="${OF.from}" onchange="OF.from=this.value;render()"></label>
    <label class="fld"><span>По</span><input type="date" value="${OF.to}" onchange="OF.to=this.value;render()"></label>
    <label class="fld"><span>Состояние</span><select onchange="OF.state=this.value;render()"><option value="">Все</option><option value="draft" ${OF.state==="draft"?"selected":""}>Черновики</option><option value="del" ${OF.state==="del"?"selected":""}>Помеченные на удаление</option></select></label>
    <div style="flex:1"></div>
    ${canEnter(u)?`<button class="btn primary" onclick="newOp()">Новая операция</button><button class="btn" onclick="newOp({kind:'exchange'})">Обмен на двух счетах</button>`:""}
    ${exportBtn("tOps","Внутренние операции")}
  </div></div>
  <div class="panel"><div class="body flush"><div class="tbl-wrap"><table id="tOps"><thead><tr><th>Дата</th><th>Номер</th><th>Вид</th><th>Отправитель</th><th>Получатель</th><th>Счёт или касса</th><th class="num">Сумма</th><th>Вал.</th><th class="num">USD</th><th>Договор</th><th>Автор</th><th>Состояние</th></tr></thead>
  <tbody>${list.map(o=>{ const L = opLegs(o);
    return `<tr class="clickable ${opCounts(o)||(o.linkedDoc&&!o.deleted)?"":"excl"}" onclick="openOp('${o.id}')"><td>${fmtD(o.date)}</td><td><a class="lnk">${esc(o.no)}</a></td><td>${esc(OP_KINDS[o.kind].name)}</td>
    <td>${esc(nm(wal(o.from)))}</td><td>${esc(nm(wal(o.to)))}</td><td>${L.map(l=>`${l.n===2?"нога 2: ":o.kind==="exchange"?"нога 1: ":""}${esc(nm(acc(l.acc)))}`).join("<br>")}</td>
    <td class="num">${L.map(l=>fmt(l.sum)).join("<br>")}</td><td>${L.map(l=>esc(curCode(l.cur))).join("<br>")}</td><td class="num">${L.map(l=>fmt(l.usd)).join("<br>")}</td>
    <td>${esc(nm(contract(o.contract))||"")}</td><td>${esc(nm(usr(o.author)))}</td><td>${opState(o)}</td></tr>`; }).join("") || `<tr><td colspan="12" class="muted">Операций нет</td></tr>`}</tbody></table></div></div></div>`;
}

let OE = null, OEerr = null, OEwarn = null;
function newOp(pre){
  const u = me(); if(!canEnter(u)) return;
  OE = Object.assign({id:uid("O"), no:"", date:CUR.date, kind:"loan", from:null, to:null, contract:"", comment:"",
    leg1:{org:"",acc:"",sum:null,rate:null}, leg2:{org:"",acc:"",sum:null,rate:null}, sameCur:true,
    author:u.id, created:new Date().toISOString(), posted:false, deleted:false, linkedDoc:null, versions:[]}, clone(pre||{}));
  if(OE.leg1 && OE.leg1.acc && !OE.leg1.org) OE.leg1.org = acc(OE.leg1.acc)?.org || "";
  if(!isAdmin(u) && !OE.from){ const own = [...ownWallets(u)].filter(id=>!walletClosedAt(id,OE.date)); if(own.length===1) OE.from = own[0]; }
  OEerr = null; OEwarn = null; openOpModal();
}
function openOp(id){ const o = byId(DB.ops,id); if(!o) return; OE = clone(o); OEerr=null; OEwarn=null; openOpModal(); }
function opEditable(){
  const u = me(); const o = OE; if(!canEnter(u)) return false;
  if(periodError(o.date)) return false;
  const orig = byId(DB.ops,o.id);
  if(orig && !isAdmin(u) && !canEditWallet(u,orig.from) && !canEditWallet(u,orig.to)) return false;
  return true;
}
function openOpModal(){
  openModal({width:1080, title:`${esc(OP_KINDS[OE.kind].name)} ${OE.no?`№ ${esc(OE.no)}`:"(новая)"}`, body:opBody, footer:opFooter});
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
  if(k==="org") G.acc = "";
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
    <label class="fld"><span>Счёт или касса <em>*</em></span><select ${dis} onchange="legSet('${L}','acc',this.value)">${optsAccounts(G.org,G.acc,{curId:curFilter})}</select>
      ${curFilter?`<small>Только счета в ${esc(curCode(curFilter))} — «Обмен в одной валюте» (ТР-77, МД-19)</small>`:""}</label>
    <label class="fld"><span>Сумма <em>*</em></span>${sumWithCur(ed?moneyInput({id:`${L}_sum`, value:G.sum, onchange:`legSet('${L}','sum',parseNum(this.value))`}):`<span class="num">${fmt(G.sum)}</span>`, a&&a.cur)}</label>
    <label class="fld"><span>Курс: ${a?esc(curCode(a.cur)):"единиц валюты"} за 1 USD <em>*</em></span>
      ${a && isUSD(a.cur) ? `<input type="text" readonly value="1">` : ed ? moneyInput({id:`${L}_rate`, value:G.rate, dec:6, placeholder:"3,6725", onchange:`legSet('${L}','rate',parseNum(this.value))`}) : `<span class="num">${fmtRate(G.rate)}</span>`}
      <small>${erp?`Курс ERP на ${fmtD(OE.date)}: ${fmtRate(erp)}${G.rate&&Math.abs(G.rate-erp)>1e-9?` · <a class="lnk" onclick="legSet('${L}','rate',${erp})">подставить</a>`:""}`:a?`<span class="neg">нет курса ERP на дату — введите вручную</span>`:""}
      ${G.sum>0&&G.rate>0?` · <b>${fmt(r2(G.sum/G.rate))} USD</b>`:""}</small></label>
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
  return `${reason?`<div class="alert warn">${esc(reason)}</div>`:""}
  ${OEerr?`<div class="alert err"><ul>${OEerr.map(e=>`<li>${esc(e)}</li>`).join("")}</ul></div>`:""}
  ${OEwarn?`<div class="alert warn"><ul>${OEwarn.map(e=>`<li>${esc(e)}</li>`).join("")}</ul></div>`:""}
  ${o.deleted?`<div class="alert err">Операция помечена на удаление и не участвует в расчёте (ТР-74).</div>`:""}
  ${linked?`<div class="alert ok">Оформляет платёж <a class="lnk" onclick="openDoc('${linked.id}')">${esc(linked.no)}</a> от ${fmtD(linked.date)} (${esc(nm(wal(linked.from.wallet)))} → ${esc(nm(wal(linked.to.wallet)))}). Деньги уже перешли этим платежом, поэтому операция не меняет остатки ещё раз — она фиксирует характер перевода и долг по займу (ТР-57).</div>`:""}
  <div class="grid2">
    <label class="fld"><span>Вид операции <em>*</em></span><select ${dis} onchange="oeSet('kind',this.value)">${Object.entries(OP_KINDS).filter(([k])=>!linked||["loan","repay","funding","dividends"].includes(k)).map(([k,t])=>`<option value="${k}" ${o.kind===k?"selected":""}>${esc(t.name)}</option>`).join("")}</select></label>
    <label class="fld"><span>Дата <em>*</em></span><input type="date" ${dis} value="${o.date}" onchange="oeSet('date',this.value)"></label>
    <label class="fld"><span>${esc(K.from)} <em>*</em></span><select ${dis} onchange="oeSet('from',this.value||null)">${optsWallets(o.from,o.date,{empty:"— выберите —",filter:fromFilter})}</select>
      ${o.kind==="funding"?`<small>Только головной кошелёк</small>`:""}</label>
    <label class="fld"><span>${esc(K.to)} <em>*</em></span><select ${dis} onchange="oeSet('to',this.value||null)">${optsWallets(o.to,o.date,{empty:"— выберите —",filter:toFilter})}</select>
      ${o.kind==="dividends"?`<small>Только головной кошелёк</small>`:""}</label>
    ${loan?`<label class="fld"><span>Договор займа <em>*</em></span><div class="row"><select style="flex:1" ${dis} onchange="oeSet('contract',this.value)">${opts(DB.contracts.filter(c=>o.kind==="loan"?(c.lender===o.from&&c.borrower===o.to):(c.lender===o.to&&c.borrower===o.from)),o.contract,{empty:"— выберите —"})}</select>
      ${ed?`<button class="btn sm" onclick="openContract(null,true)">Новый</button>`:""}</div><small>Долг ведётся в USD по договору (ТР-28, ТР-40)</small></label>`:""}
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
    <button class="btn" onclick="closeModal()">${ed?"Отмена":"Закрыть"}</button>
    ${ed && !o.deleted ? `${o.kind==="exchange"?`<button class="btn" onclick="saveOp(false)">Записать черновик</button>`:""}<button class="btn primary" onclick="saveOp(true)">Провести</button>`:""}`;
}
function validateOp(o, post){
  const e = [], w = []; const u = me(); const K = OP_KINDS[o.kind];
  const pe = periodError(o.date); if(pe) e.push(pe);
  if(!o.from) e.push(`Не выбран ${K.from.toLowerCase()}`); if(!o.to) e.push(`Не выбран ${K.to.toLowerCase()}`);
  if(o.from && o.from===o.to) e.push("Отправитель и получатель совпадают");
  if(o.from && walletClosedAt(o.from,o.date) && o.kind!=="closeDiv") e.push(`Кошелёк «${nm(wal(o.from))}» закрыт (ТР-25)`);
  if(o.to && walletClosedAt(o.to,o.date)) e.push(`Кошелёк «${nm(wal(o.to))}» закрыт (ТР-25)`);
  if(o.kind==="funding" && o.from && !wal(o.from).head) e.push("Безвозмездное финансирование выдаёт только головной кошелёк");
  if(o.kind==="dividends" && o.to && !wal(o.to).head) e.push("Дивиденды получает только головной кошелёк");
  if((o.kind==="loan"||o.kind==="repay") && !o.contract) e.push("Не выбран договор займа");
  if(!isAdmin(u) && ![o.from,o.to].some(x=>x && canEditWallet(u,x))) e.push("Казначей вводит операции по своим кошелькам: одна из сторон должна быть вашим кошельком");
  const chk = (G, t) => { if(!G.acc) e.push(`${t}: не выбран счёт или касса`); if(!(G.sum>0)) e.push(`${t}: сумма должна быть больше нуля`); if(!(G.rate>0)) e.push(`${t}: не указан курс к USD`); };
  if(post || o.kind!=="exchange") chk(o.leg1, o.kind==="exchange"?"Нога 1":"Счёт");
  if(o.kind==="exchange" && post) chk(o.leg2, "Нога 2 (документ не проводится без второй ноги)");
  if(o.kind==="exchange"){ const a = acc(o.leg1.acc), b = acc(o.leg2.acc);
    if(a && b && a.id===b.id) e.push("Ноги обмена должны быть на разных счетах");
    if(a && b && o.sameCur && a.cur!==b.cur) e.push("Обмен в одной валюте: валюта счёта Б должна совпадать с валютой счёта А (ТР-77)"); }
  if(!o.linkedDoc && post){ // предупреждение о минусе (разрешён, ТР-24)
    opLegs(o).forEach(L=>{ const cur = facts().filter(f=>f.wallet===L.from && f.acc===L.acc && f.date<=o.date && !(f.src.k==="op"&&f.src.id===o.id)).reduce((s,f)=>s+f.sum,0);
      if(cur - L.sum < -0.005) w.push(`У кошелька «${nm(wal(L.from))}» на счёте «${nm(acc(L.acc))}» станет отрицательный остаток: ${fmt(r2(cur-L.sum))} ${curCode(L.cur)}. Это разрешено, казначей и администратор получат уведомление (ТР-24).`); });
  }
  return {e, w};
}
function opPayload(o){
  const leg = L => ({acc:L.acc||"", sum:L.sum, rate:L.rate});
  return {id: byId(DB.ops,o.id) ? o.id : "", kind:o.kind, date:o.date, from:o.from||"", to:o.to||"", contract:o.contract||"", comment:o.comment||"",
    leg1:leg(o.leg1||{}), leg2:leg(o.leg2||{}), sameCur:!!o.sameCur, linkedDoc:o.linkedDoc||""};
}
async function saveOp(post){
  const o = OE; const {e, w} = validateOp(o, post);
  if(e.length){ OEerr = e; OEwarn = null; refreshModal(); return; }
  if(w.length && !OEwarn){ OEwarn = w; OEerr = null; refreshModal(); if(!confirm(w.join("\n\n")+"\n\nПровести всё равно?")) return; }
  const r = await mutate("/api/ops", {op:opPayload(o), post});
  if(!r.ok){ OEerr = r.errors; refreshModal(); return; }
  closeModal();
}
async function toggleOpDelete(){
  const r = await mutate(`/api/ops/${encodeURIComponent(OE.id)}/delete`);
  if(!r.ok){ OEerr = r.errors; refreshModal(); return; }
  closeModal();
}
/* --- договор займа --- */
let CE = null;
function openContract(id, fromOp){
  const back = fromOp ? {OE:clone(OE)} : null;
  const [L,B] = fromOp ? (OE.kind==="loan"?[OE.from,OE.to]:[OE.to,OE.from]) : [null,null];
  CE = id ? clone(contract(id)) : {id:uid("C"), name:"", lender:L, borrower:B, created:new Date().toISOString()};
  const reopen = () => { if(back){ OE = back.OE; openOpModal(); } else closeModal(); };
  openModal({title:"Договор займа между кошельками", width:640, body:()=>`<div class="stack">
    <label class="fld"><span>Наименование <em>*</em></span><input type="text" id="ceName" value="${esc(CE.name)}" onchange="CE.name=this.value"></label>
    <label class="fld"><span>Займодавец <em>*</em></span><select onchange="CE.lender=this.value">${optsWallets(CE.lender,CUR.date,{empty:"— выберите —"})}</select></label>
    <label class="fld"><span>Заёмщик <em>*</em></span><select onchange="CE.borrower=this.value">${optsWallets(CE.borrower,CUR.date,{empty:"— выберите —"})}</select></label>
    <span class="muted">Валюта долга — USD. Проценты и графики не ведутся (ТР-29).</span></div>`,
    footer:()=>`<button class="btn" id="ceCancel">Отмена</button><button class="btn primary" id="ceSave">Сохранить</button>`});
  $("#ceCancel").onclick = reopen;
  $("#ceSave").onclick = async () => {
    CE.name = $("#ceName").value.trim();
    if(!CE.name || !CE.lender || !CE.borrower || CE.lender===CE.borrower){ alert("Заполните наименование и два разных кошелька"); return; }
    const r = await mutate("/api/contracts", {name:CE.name, lender:CE.lender, borrower:CE.borrower});
    if(!r.ok) return showErrors(r);
    if(back){ back.OE.contract = r.result.id; }
    reopen();
  };
}

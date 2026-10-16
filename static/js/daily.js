"use strict";
/* ============================================================
   23. DAILY BALANCE (раздел 7, ТР-91…ТР-105)
   Б — остаток по банку на утро D; П — исходящие в пути; К — сумма кошельков по позиции на конец D−1.
   Расхождение = (Б − П) − К. Валюты не суммируются; USD в сверке не участвует (ТР-58).
   Все данные приходят с сервера уже отфильтрованными по правам (ТР-104).
   ============================================================ */
const DBV = {date:"", my:null, morning:null, cmpView:null, recon:null, loading:{}, ver:{},
  mode:"morning", state:"submit", cmp:"", flat:false, org:"", cur:"", q:"", st:"", open:{}, data:null, saveT:null, savedAt:"", saveErr:""};
const DB_ST = {ok:["Сходится","ok"], diff:["Расхождение","off"], noreport:["Нет отчёта","warn"], noaccess:["Нет доступа к банку","warn"], explained:["Объяснено","info"]};
const fmtT = t => t ? `${fmtD(t.slice(0,10))} ${t.slice(11,16)}` : "—";
const hm = t => t ? t.slice(11,16) : "";
const dbDate = () => DBV.date || DB.dbCurrent || todayISO();
const posOf = id => (DB.dbPositions||[]).find(p=>p.id===id);
const dbPosLabel = r => `${nm(acc(r.acc))} · ${curCode(r.cur)}`;
function dbCanAct(){ const u = me(); return isAdmin(u) || has(u,"finControl"); }
function dbSees(){ return !!(DB.perms && (DB.perms.dbFull || (DB.dbPositions||[]).length)); }

/** Загрузка окна с сервера; перечитывается при смене даты/режима и после любых изменений данных */
async function dbLoad(kind, force){
  const d = dbDate();
  const q = kind==="morning" ? `date=${d}&mode=${DBV.mode}` : kind==="recon" ? `date=${d}&state=${DBV.state}` : `date=${d}`;
  const key = kind+"|"+q+"|"+DB.version;
  if(!force && (DBV.ver[kind]===key || DBV.loading[kind]===key)) return;
  DBV.loading[kind] = key;
  const r = await apiRaw(`/api/db/${kind}?${q}`);
  DBV.loading[kind] = null;
  if(!r.ok){ showErrors(r); return; }
  DBV[kind] = r.view; DBV.ver[kind] = key;
  if(kind==="my" && DBV.dataDate!==r.view.date){ DBV.data = null; DBV.savedAt = ""; DBV.dataDate = r.view.date; }
  if(kind==="morning" && DBV.cmp){ const c = await apiRaw(`/api/db/morning?date=${DBV.cmp}&mode=${DBV.mode}`); DBV.cmpView = c.ok ? c.view : null; }
  render();
}
function dbNeed(kind){
  const d = dbDate(); const v = DBV[kind];
  const want = kind==="morning" ? `date=${d}&mode=${DBV.mode}` : kind==="recon" ? `date=${d}&state=${DBV.state}` : `date=${d}`;
  if(DBV.ver[kind] !== kind+"|"+want+"|"+DB.version){ dbLoad(kind); }
  return v && v.date===d ? v : null;
}
function dbSetDate(d){ DBV.date = d || ""; render(); }
function dbDateBar(extra=""){
  const d = dbDate();
  return `<div class="filters"><label class="fld"><span>Рабочий день D</span><input type="date" value="${d}" onchange="dbSetDate(this.value)"></label>
    ${d!==DB.dbCurrent?`<button class="btn sm" onclick="dbSetDate('')">Текущий: ${fmtD(DB.dbCurrent)}</button>`:""}${extra}</div>`;
}
const dbLoadingHtml = t => `<h1>${t}</h1><div class="panel"><div class="body muted">Загрузка…</div></div>`;

/* ---------------- 1. Окно казначея «Мой отчёт» (ТР-92…ТР-97) ---------------- */
function dbRowData(pid){
  const v = DBV.my; if(!DBV.data) DBV.data = clone(v.draft||{});
  if(!DBV.data[pid]) DBV.data[pid] = {b:null, noAccess:false, pDocs:[], pManual:[], incoming:null, incomingComment:"", comment:"", pTouched:false};
  const r = DBV.data[pid]; const row = v.rows.find(x=>x.pos===pid);
  if(!r.pTouched && row) r.pDocs = row.pCand.map(x=>x.doc);   // П предзаполняется программой, казначей подтверждает
  return r;
}
function dbCalc(row, r){
  const p = r2(row.pCand.filter(x=>r.pDocs.includes(x.doc)).reduce((t,x)=>t+x.sum,0) + (r.pManual||[]).reduce((t,m)=>t+(isFinite(m.sum)?m.sum:0),0));
  const b = r.noAccess ? (row.prev ? row.prev.b : null) : r.b;
  const bp = b===null || b===undefined ? null : r2(b-p);
  return {p, b, bp, usd: bp!==null && row.rate ? r2(bp/row.rate) : null, diff: !r.noAccess && bp!==null ? r2(bp-row.k) : null};
}
function dbEdit(pid, f, v){
  const r = dbRowData(pid);
  if(f==="pDoc"){ r.pTouched = true; r.pDocs = v.on ? [...new Set([...r.pDocs, v.doc])] : r.pDocs.filter(x=>x!==v.doc); }
  else r[f] = v;
  dbAutosave(); render();
}
function dbManual(pid, i, f, v){ const r = dbRowData(pid); if(i<0){ r.pManual.push({sum:null, comment:""}); } else if(f===null){ r.pManual.splice(i,1); } else r.pManual[i][f] = v; dbAutosave(); render(); }
function dbAutosave(){
  clearTimeout(DBV.saveT); DBV.saveErr = "";
  DBV.saveT = setTimeout(async ()=>{
    const r = await apiRaw("/api/db/draft", {date:DBV.my.date, data:DBV.data});
    if(r.ok){ DBV.savedAt = r.result.updated; } else DBV.saveErr = r.errors.join("; ");
    const el = $("#dbSaved"); if(el){ el.innerHTML = dbSavedText(); translateDom(el); }
  }, 700);
}
function dbSavedText(){ return DBV.saveErr ? `<span class="neg">Черновик не сохранён: ${esc(DBV.saveErr)}</span>` : DBV.savedAt ? `<span class="muted">Черновик сохранён на сервере · ${fmtDT(DBV.savedAt)}</span>` : `<span class="muted">Черновик сохраняется на сервере автоматически</span>`; }
const DB_STATUS = {draft:["Черновик",""], submitted:["Сдан","ok"], overdue:["Просрочен","off"]};

function viewDbMy(){
  const T = `Daily Balance · мой отчёт`;
  const v = dbNeed("my"); if(!v) return dbLoadingHtml(T);
  const sub = v.status==="submitted"; const rep = v.report;
  if(!sub && DBV.savedAt==="" && v.draftSaved) DBV.savedAt = v.draftSaved;
  const [stN, stC] = DB_STATUS[v.status];
  const head = `<h1>${T} <span class="tzref">ТР-92…97</span></h1>
  <p class="lede">Каждое рабочее утро введите фактический остаток по банку (Б) по каждой своей позиции — счёт × валюта — и подтвердите исходящие в пути (П): программа предзаполнила список проведённых СБДС, которые банк ещё не исполнил. Расхождение = (Б − П) − К, где К — сумма кошельков по позиции на конец предыдущего дня. Сдать до ${esc(DB.settings.dbTime||"10:30")} МСК; позже — можно, опоздание фиксируется. Сданный отчёт не меняется: днём можно добавить обновление остатка.</p>
  ${dbDateBar(`<div class="fld"><span>Статус</span><span class="tag ${stC} big">${stN}${sub?` · ${fmtT(rep.t)}${rep.late?" · с опозданием":""}`:""}</span></div>
    <div class="fld"><span>Срок</span><b>${fmtD(v.date)} ${hm(v.deadline)} МСК</b></div>`)}`;
  if(!v.workday) return head + `<div class="alert info">${fmtD(v.date)} — нерабочий день по календарю Daily Balance. Отчёт сдаётся только в рабочие дни (ТР-94).</div>`;
  if(!v.rows.length) return head + `<div class="alert warn">Вы не назначены ответственным ни за одну позицию Daily Balance. Ответственного назначает администратор в настройках Daily Balance.</div>`;
  if(sub) return head + dbSubmitted(v);
  const rows = v.rows.map(row=>({row, r:dbRowData(row.pos)}));
  const ready = rows.every(({r})=>r.noAccess || (r.b!==null && r.b!==undefined && isFinite(r.b)));
  const missing = rows.filter(({r})=>!(r.noAccess || (r.b!==null && r.b!==undefined && isFinite(r.b)))).length;
  return head + (v.status==="overdue"?`<div class="alert err">Отчёт за ${fmtD(v.date)} просрочен: контрольное время ${esc(DB.settings.dbTime||"10:30")} МСК прошло. Сдать можно и сейчас — опоздание будет зафиксировано.</div>`:"") +
  rows.map(({row, r})=>dbMyCard(row, r)).join("") +
  `<div class="panel sticky-foot"><div class="body row">
    <button class="btn primary" ${ready?"":"disabled"} onclick="dbSubmit()">Сдать отчёт</button>
    ${ready?`<span class="muted">После сдачи отчёт фиксируется и не меняется (ТР-96).</span>`:`<span class="amber">Осталось позиций без остатка: ${missing}. Введите Б (ноль — явно) или отметьте «Нет доступа к банку».</span>`}
    <div style="flex:1"></div><span id="dbSaved">${dbSavedText()}</span></div></div>`;
}
function dbMyCard(row, r){
  const c = dbCalc(row, r); const pid = row.pos; const cc = curCode(row.cur);
  return `<div class="panel db-card ${r.noAccess?"noacc":""}"><header><h2>${esc(nm(org(row.org)))} · ${esc(nm(acc(row.acc)))} <span class="tag">${esc(cc)}</span></h2>
    <span class="muted">Предыдущий сданный остаток: ${row.prev?`<b>${fmt(row.prev.b)} ${esc(cc)}</b> на ${fmtD(row.prev.date)} ${hm(row.prev.t)}`:"нет"}</span></header>
  <div class="body"><div class="db-grid">
    <div class="stack">
      <label class="fld"><span>Б — остаток по банку на утро ${fmtD(DBV.my.date)} <em>*</em></span>${r.noAccess?`<span class="muted">Нет доступа: подставлен последний остаток ${row.prev?`${fmt(row.prev.b)} на ${fmtD(row.prev.date)}`:"— его нет"}; фактическим на D он не считается, сверка не подтверждается (ТР-95).</span>`
        :sumWithCur(moneyInput({id:`b_${pid}`, value:r.b, onchange:`dbEdit('${pid}','b',parseNum(this.value))`, placeholder:"введите число"}), row.cur)}
        <small>Одно число, без формул. Ноль вводится явно.</small></label>
      <label class="chk"><input type="checkbox" ${r.noAccess?"checked":""} onchange="dbEdit('${pid}','noAccess',this.checked)"> Нет доступа к банку</label>
      <label class="fld"><span>Входящие в пути (справочно, в формуле не участвуют)</span>${sumWithCur(moneyInput({value:r.incoming, onchange:`dbEdit('${pid}','incoming',parseNum(this.value))`}), row.cur)}
        <input type="text" placeholder="откуда ожидается" value="${esc(r.incomingComment||"")}" onchange="dbEdit('${pid}','incomingComment',this.value)" style="margin-top:4px"></label>
      <label class="fld"><span>Комментарий</span><input type="text" value="${esc(r.comment||"")}" onchange="dbEdit('${pid}','comment',this.value)"></label>
    </div>
    <div class="stack">
      <div class="fld"><span>П — исходящие в пути: проведённые СБДС с датой до ${fmtD(addDays(DBV.my.date,-1))} включительно, банк ещё не исполнил</span>
        ${row.pCand.length?`<table class="mini"><thead><tr><th></th><th>Документ</th><th>Дата</th><th>Получатель</th><th class="num">Сумма</th></tr></thead><tbody>
          ${row.pCand.map(x=>`<tr><td><input type="checkbox" ${r.pDocs.includes(x.doc)?"checked":""} onchange="dbEdit('${pid}','pDoc',{doc:'${x.doc}',on:this.checked})" aria-label="Учесть в П"></td>
            <td><a class="lnk" onclick="dbOpen('doc','${x.doc}')">${esc(x.no||"")}</a></td><td>${fmtD(x.date)}</td><td>${esc(x.cpty||"")}</td><td class="num">${fmt(x.sum)}</td></tr>`).join("")}</tbody></table>`
          :`<span class="muted">Программа не нашла неисполненных СБДС по позиции.</span>`}</div>
      <div class="fld"><span>Ручные суммы П (с комментарием)</span>
        ${(r.pManual||[]).map((m,i)=>`<div class="row" style="gap:6px;margin-bottom:4px">${moneyInput({value:m.sum, onchange:`dbManual('${pid}',${i},'sum',parseNum(this.value))`, style:"width:140px"})}
          <input type="text" placeholder="комментарий обязателен" value="${esc(m.comment||"")}" onchange="dbManual('${pid}',${i},'comment',this.value)" style="flex:1">
          <button class="btn sm ghost" onclick="dbManual('${pid}',${i},null)" aria-label="Удалить">✕</button></div>`).join("")}
        <button class="btn sm" onclick="dbManual('${pid}',-1)">Добавить сумму</button></div>
    </div>
    <div class="db-calc">
      <div><span>П</span><b>${fmt(c.p)}</b></div>
      <div><span>Б − П</span><b>${c.bp===null?"—":fmt(c.bp)}</b></div>
      <div><span>Курс к USD</span><b>${row.rate?fmtRate(row.rate):"нет курса"}</b></div>
      <div><span>Сумма USD</span><b>${c.usd===null?"—":fmt(c.usd)}</b></div>
      <div><span>К — кошельки на конец ${fmtD(addDays(DBV.my.date,-1))}</span><b><a class="lnk" onclick="dbShowK('${row.acc}','${row.cur}','${DBV.my.date}')">${fmt(row.k)}</a></b></div>
      <div class="${c.diff===null?"":Math.abs(c.diff)<0.005?"ok":"bad"}"><span>Расхождение (Б − П) − К</span><b>${c.diff===null?"—":fmtS(c.diff)}</b></div>
      ${row.kSplit.length?`<div class="ksplit">${row.kSplit.map(k=>`<div><span>${esc(k.name)}</span><span class="num">${fmt(k.sum)}</span></div>`).join("")}</div>`:""}
    </div>
  </div></div></div>`;
}
async function dbSubmit(){
  const v = DBV.my; const neg = v.rows.filter(row=>{ const r = dbRowData(row.pos); return !r.noAccess && r.b<0; });
  if(neg.length && !confirm(`Отрицательный остаток по банку: ${neg.map(x=>dbPosLabel(x)).join(", ")}. Проверьте ввод. Сдать отчёт как есть?`)) return;
  const noCm = v.rows.some(row=>(dbRowData(row.pos).pManual||[]).some(m=>isFinite(m.sum) && m.sum!==null && !(m.comment||"").trim()));
  if(noCm){ toast("У ручной суммы П укажите комментарий", {lvl:"err"}); return; }
  if(!confirm(`Сдать отчёт за ${fmtD(v.date)}? Сданный отчёт фиксируется и не меняется.`)) return;
  clearTimeout(DBV.saveT);
  const data = {}; v.rows.forEach(row=>{ const r = dbRowData(row.pos); data[row.pos] = Object.assign({}, r, {pDocs:r.pDocs}); });
  const r = await mutate("/api/db/submit", {date:v.date, data});
  if(!r.ok) return showErrors(r);
  DBV.data = null; DBV.savedAt = "";
  toast(r.result.late ? "Отчёт сдан с опозданием — опоздание зафиксировано" : "Отчёт сдан", {lvl: r.result.late ? "warn" : "ok"});
}
function dbSubmitted(v){
  const rep = v.report;
  return `<div class="panel"><header><h2>Сданный отчёт · ${fmtT(rep.t)}${rep.late?` <span class="tag off">с опозданием</span>`:""}</h2><span class="muted">${esc(rep.uname)}</span><div style="flex:1"></div>${exportBtn("tDbMy","Daily Balance мой отчёт")}</header>
  <div class="body flush"><div class="tbl-wrap"><table id="tDbMy"><thead><tr><th>Организация</th><th>Счёт</th><th>Вал.</th><th class="num">Б</th><th class="num">П</th><th class="num">Б − П</th><th class="num">Курс</th><th class="num">USD</th><th class="num">К</th><th class="num">Расхождение</th><th>Входящие в пути</th><th>Комментарий</th><th>Обновления днём</th><th></th></tr></thead>
  <tbody>${rep.rows.map(x=>{ const row = v.rows.find(y=>y.pos===x.pos)||{updates:[]};
    return `<tr><td>${esc(nm(org(x.org)))}</td><td>${esc(nm(acc(x.acc)))}</td><td>${esc(curCode(x.cur))}</td>
    <td class="num">${x.noAccess?`<span class="tag warn" title="Последний остаток${x.last?` на ${fmtD(x.last.date)}`:""}">нет доступа</span> ${x.b!=null?fmt(x.b):""}`:fmt(x.b)}</td><td class="num">${fmt(x.p)}</td><td class="num">${x.bp!=null?fmt(x.bp):"—"}</td>
    <td class="num">${x.rate?fmtRate(x.rate):"—"}</td><td class="num">${x.usd!=null?fmt(x.usd):"—"}</td><td class="num">${fmt(x.k)}</td>
    <td class="num ${x.diff&&Math.abs(x.diff)>=0.005?"neg":""}">${x.diff==null?"—":fmtS(x.diff)}</td><td>${x.incoming!=null?`${fmt(x.incoming)} ${esc(x.incomingComment||"")}`:""}</td><td>${esc(x.comment||"")}</td>
    <td style="font-size:11px">${row.updates.map(u=>`${hm(u.t)}: ${fmt(u.b)}`).join("<br>")}</td>
    <td>${v.date===v.today?`<button class="btn sm" onclick="dbUpdateOpen('${x.pos}')">Обновить остаток</button>`:""}</td></tr>`; }).join("")}</tbody></table></div></div></div>
  <p class="muted">Обновление днём создаёт новую неизменяемую запись со временем; утренний отчёт не меняется (ТР-97). Исправить ошибку в сданном отчёте может фин. контролер или администратор — корректировкой с причиной (ТР-98).</p>`;
}
let DBU = null;
function dbUpdateOpen(pid){
  const row = DBV.my.rows.find(x=>x.pos===pid); DBU = {pos:pid, b:null, comment:""};
  openModal({title:`Обновить остаток · ${esc(dbPosLabel(row))}`, width:520, body:()=>`
    <label class="fld"><span>Остаток по банку сейчас <em>*</em></span>${sumWithCur(moneyInput({id:"dbuB", value:DBU.b, onchange:"DBU.b=parseNum(this.value)"}), row.cur)}</label>
    <label class="fld" style="margin-top:8px"><span>Комментарий</span><input type="text" value="${esc(DBU.comment)}" onchange="DBU.comment=this.value"></label>
    <p class="muted">Запись получит текущее время МСК и попадёт в «Остатки на утро» в режиме «Последнее обновление».</p>`,
    footer:()=>`<button class="btn" onclick="closeModal()">Отмена</button><button class="btn primary" onclick="dbUpdateSave()">Сохранить</button>`});
}
async function dbUpdateSave(){
  const el = $("#dbuB"); if(el) DBU.b = parseNum(el.value);
  if(!isFinite(DBU.b) || DBU.b===null){ toast("Введите остаток", {lvl:"err"}); return; }
  if(DBU.b<0 && !confirm("Отрицательный остаток по банку. Сохранить?")) return;
  const r = await mutate("/api/db/update", {pos:DBU.pos, data:{b:DBU.b, comment:DBU.comment}});
  if(!r.ok) return showErrors(r);
  closeModal(); toast("Остаток обновлён", {lvl:"ok"});
}
/** Клик по К — движения позиции до конца D−1 (видимые пользователю; чужие кошельки не раскрываются) */
async function dbShowK(accId, cur, d){
  const p = (DB.dbPositions||[]).find(x=>x.acc===accId && x.cur===cur);
  if(!p) return showFacts(`К: ${nm(acc(accId))} · ${curCode(cur)}`, f=>f.acc===accId && f.cur===cur && f.date<=addDays(d,-1));
  const r = await apiRaw(`/api/db/movements?pos=${encodeURIComponent(p.id)}&date=${d}`);
  if(!r.ok) return showErrors(r);
  openModal({title:`К: ${esc(nm(acc(accId)))} · ${esc(curCode(cur))} — движения до ${fmtD(r.lim)} включительно`, drawer:true, width:1000, body:()=>`
    <div class="row" style="margin-bottom:8px"><span class="tag">К = ${fmt(r.total)} ${esc(curCode(cur))}</span><span class="muted">${r.rows.length} записей · чужие кошельки свёрнуты в «прочие кошельки» (ТР-104)</span><div style="flex:1"></div><button class="btn sm" onclick="exportTable('tDbK','Daily Balance движения К')">Выгрузить в Excel</button></div>
    <div class="tbl-wrap"><table id="tDbK" class="sortable"><thead><tr><th>Дата</th><th>Документ или операция</th><th>Кошелёк</th><th class="num">Сумма</th></tr></thead>
    <tbody>${r.rows.map(x=>`<tr class="${x.ref?"clickable":""}" ${x.ref?`onclick="dbOpen('${x.ref.k}','${x.ref.id}')"`:""}><td>${fmtD(x.date)}</td><td>${x.ref?`<a class="lnk">${esc(x.title)}</a>`:esc(x.title)}</td>
      <td>${x.wallet==="*"?`<i>${esc(x.walletName)}</i>`:x.wallet?esc(x.walletName):`<span class="tag warn">Без кошелька</span>`}</td><td class="num ${x.sum<0?"neg":"pos"}">${fmtS(x.sum)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Движений нет</td></tr>`}</tbody></table></div>`});
}
/** Документ из подсказок и списков Daily Balance может быть вне прав пользователя на кошельки — тогда сообщаем, а не молчим */
function dbOpen(k, id){
  if(k==="op"){ if(byId(DB.ops,id)) return openOp(id); }
  else if(byId(DB.docs,id)) return openDoc(id);
  toast("Документ относится к кошелькам, которые вам не видны (раздел 9)", {lvl:"warn"});
}

/* ---------------- 2. «Остатки на утро» (ТР-99) ---------------- */
function viewDbMorning(){
  const T = "Daily Balance · остатки на утро";
  const v = dbNeed("morning"); if(!v) return dbLoadingHtml(T);
  const H = v.header; const cmp = DBV.cmp && DBV.cmpView && DBV.cmpView.date===DBV.cmp ? DBV.cmpView : null;
  const cmpMap = {}; if(cmp) cmp.rows.forEach(r=>cmpMap[r.pos]=r);
  let rows = v.rows.filter(r=>(!DBV.org || r.org===DBV.org) && (!DBV.cur || r.cur===DBV.cur) && (!DBV.q || norm(nm(acc(r.acc))+" "+nm(org(r.org))).includes(norm(DBV.q))))
    .filter(r=>!DBV.st || (DBV.st==="stale" ? r.stale : DBV.st==="noaccess" ? r.noAccess : DBV.st==="ok" ? !r.stale : true));
  rows.sort((a,b)=>(nm(org(a.org))+nm(acc(a.acc))).localeCompare(nm(org(b.org))+nm(acc(b.acc)),"ru"));
  const curs = [...new Set(rows.map(r=>r.cur))].sort((a,b)=>curCode(a).localeCompare(curCode(b)));
  const orgs = [...new Set(v.rows.map(r=>r.org))]; const allCurs = [...new Set(v.rows.map(r=>r.cur))];
  const cell = r => {
    if(!r) return "";
    const c = cmpMap[r.pos]; const delta = c && r.b!=null && c.b!=null ? r2(r.b-c.b) : null;
    const cls = r.noAccess ? "db-noacc" : r.stale ? "db-stale" : r.corrected ? "db-corr" : "";
    const tip = r.noAccess ? `Нет доступа к банку — последний остаток${r.staleDate?` на ${fmtD(r.staleDate)}`:""}` : r.stale ? `Отчёт не сдан — последний остаток${r.staleDate?` на ${fmtD(r.staleDate)}`:""}` : r.corrected ? `Скорректировано; исходное: ${fmt(r.bOrig)} · ${r.corr.reason}` : `${r.src==="morning"?"Утренний отчёт":"Обновление днём"} ${fmtT(r.t)}${r.late?" · сдан с опозданием":""}`;
    return `<a class="db-cell ${cls}" title="${esc(tip)}" onclick="dbHistory('${r.pos}')">${r.b==null?"—":fmt(r.b)}${r.corrected?`<sup>испр.</sup>`:""}${r.stale||r.noAccess?`<small>${r.staleDate?fmtD(r.staleDate):"нет данных"}</small>`:r.src!=="morning"?`<small>${hm(r.t)}</small>`:""}${delta!==null?`<small class="${delta<0?"neg":delta>0?"pos":"muted"}">${fmtS(delta)}</small>`:""}</a>`;
  };
  let table;
  if(DBV.flat){
    table = `<table id="tDbM" class="sortable"><thead><tr><th>Организация</th><th>Счёт или касса</th><th>Вал.</th><th class="num">Б</th>${cmp?`<th class="num">Б на ${fmtD(DBV.cmp)}</th><th class="num">Изменение</th>`:""}<th>Источник</th><th>Ответственный</th><th class="num">Курс</th><th class="num">USD</th></tr></thead>
    <tbody>${rows.map(r=>{ const c = cmpMap[r.pos]; return `<tr><td>${esc(nm(org(r.org)))}</td><td>${esc(nm(acc(r.acc)))}</td><td>${esc(curCode(r.cur))}</td><td class="num">${cell(r)}</td>
      ${cmp?`<td class="num">${c&&c.b!=null?fmt(c.b):"—"}</td><td class="num">${c&&c.b!=null&&r.b!=null?fmtS(r2(r.b-c.b)):"—"}</td>`:""}
      <td>${r.noAccess?`<span class="tag warn">нет доступа</span>`:r.stale?`<span class="tag warn">не сдан</span>`:r.src==="morning"?`утро ${hm(r.t)}${r.late?` <span class="tag off">опоздание</span>`:""}`:`обновление ${hm(r.t)}`}${r.corrected?` <span class="tag info">испр.</span>`:""}</td>
      <td>${esc(r.owner?nm(usr(r.owner)):"—")}</td><td class="num">${r.rate?fmtRate(r.rate):"—"}</td><td class="num">${r.usd!=null?fmt(r.usd):"—"}</td></tr>`; }).join("") || `<tr><td colspan="10" class="muted">Нет позиций</td></tr>`}</tbody></table>`;
  } else {
    const byOrg = {}; rows.forEach(r=>{ ((byOrg[r.org]=byOrg[r.org]||{})[r.acc]=byOrg[r.org][r.acc]||{})[r.cur] = r; });
    const usdSum = list => r2(list.reduce((t,r)=>t+(r&&r.usd!=null?r.usd:0),0));
    let grand = 0;
    const body = Object.entries(byOrg).sort((a,b)=>nm(org(a[0])).localeCompare(nm(org(b[0])),"ru")).map(([o, accs])=>{
      const all = Object.values(accs).flatMap(x=>Object.values(x)); const ou = usdSum(all); grand += ou;
      const tot = {}; all.forEach(r=>{ if(r.b!=null) tot[r.cur]=(tot[r.cur]||0)+r.b; });
      return `<tr class="grp"><td><b>${esc(nm(org(o)))}</b></td>${curs.map(c=>`<td class="num"><b>${tot[c]!=null?fmt(r2(tot[c])):""}</b></td>`).join("")}<td class="num"><b>${fmt(ou)}</b></td></tr>` +
        Object.entries(accs).map(([a, byCur])=>`<tr><td><span class="tree-pad" style="width:18px"></span>${esc(nm(acc(a)))}</td>${curs.map(c=>`<td class="num">${cell(byCur[c])}</td>`).join("")}<td class="num">${fmt(usdSum(Object.values(byCur)))}</td></tr>`).join("");
    }).join("");
    table = `<table id="tDbM" class="db-pivot"><thead><tr><th>Организация → счёт</th>${curs.map(c=>`<th class="num">${esc(curCode(c))}</th>`).join("")}<th class="num">Итого USD</th></tr></thead>
      <tbody>${body || `<tr><td colspan="${curs.length+2}" class="muted">Нет позиций</td></tr>`}</tbody>
      ${body?`<tfoot><tr class="tot"><td>Итого</td>${curs.map(()=>"<td></td>").join("")}<td class="num">${fmt(r2(grand))}</td></tr></tfoot>`:""}</table>`;
  }
  return `<h1>${T} <span class="tzref">ТР-99</span></h1>
  <p class="lede">Банковские остатки по позициям на утро рабочего дня: организация → счёт в строках, валюты в столбцах, итоги в USD. Если отчёт не сдан или нет доступа к банку — показан последний остаток с датой, выделен цветом. Скорректированный остаток помечен «испр.», исходный — по наведению. Клик по сумме — история позиции.</p>
  <div class="db-head">
    <div><span>Сдали</span><b>${H.submitted} из ${H.total}</b></div>
    <div class="${H.late.length?"warn":""}"><span>С опозданием</span><b>${H.late.length?esc(H.late.join(", ")):"—"}</b></div>
    <div class="${H.overdue.length?"bad":""}"><span>Просрочили</span><b>${H.overdue.length?esc(H.overdue.join(", ")):"—"}</b></div>
    <div><span>Ожидается до ${hm(H.deadline)} МСК</span><b>${H.pending.length?esc(H.pending.join(", ")):"—"}</b></div>
  </div>
  ${!v.workday?`<div class="alert info">${fmtD(v.date)} — нерабочий день; показаны последние сданные остатки.</div>`:""}
  ${dbDateBar(`<div class="fld"><span>Показать</span><div class="seg">${[["morning","На утро"],["latest","Последнее обновление"]].map(([k,t])=>`<button type="button" class="${DBV.mode===k?"on":""}" onclick="DBV.mode='${k}';render()">${t}</button>`).join("")}</div></div>
    <label class="fld"><span>Сравнить с датой</span><input type="date" value="${DBV.cmp}" onchange="DBV.cmp=this.value;DBV.cmpView=null;dbLoad('morning',true)"></label>
    <label class="fld"><span>Организация</span><select onchange="DBV.org=this.value;render()">${opts(orgs.map(o=>org(o)).filter(Boolean), DBV.org, {empty:"Все"})}</select></label>
    <label class="fld"><span>Валюта</span><select onchange="DBV.cur=this.value;render()">${opts(allCurs.map(c=>({id:c, name:curCode(c)})), DBV.cur, {empty:"Все"})}</select></label>
    <label class="fld"><span>Состояние</span><select onchange="DBV.st=this.value;render()"><option value="">Все</option>${[["ok","Сдано"],["stale","Не сдано / последний остаток"],["noaccess","Нет доступа к банку"]].map(([k,t])=>`<option value="${k}" ${DBV.st===k?"selected":""}>${t}</option>`).join("")}</select></label>
    <label class="fld"><span>Поиск</span><input type="search" value="${esc(DBV.q)}" placeholder="счёт или организация" onchange="DBV.q=this.value;render()"></label>`)}
  <div class="panel"><header><div class="seg">${[[false,"По организациям"],[true,"Плоский список"]].map(([k,t])=>`<button type="button" class="${DBV.flat===k?"on":""}" onclick="DBV.flat=${k};render()">${t}</button>`).join("")}</div>
    <div class="legend"><span class="db-stale">не сдан</span><span class="db-noacc">нет доступа</span><span class="db-corr">исправлено</span></div><div style="flex:1"></div>${exportBtn("tDbM","Daily Balance остатки на утро")}</header>
  <div class="body flush"><div class="tbl-wrap">${table}</div></div></div>`;
}
async function dbHistory(pid){
  const p = posOf(pid); const r = await apiRaw(`/api/db/history?pos=${encodeURIComponent(pid)}`);
  if(!r.ok) return showErrors(r);
  const K = {morning:"Утренний отчёт", update:"Обновление днём", correction:"Корректировка", explained:"Объяснено"};
  openModal({title:`История позиции · ${esc(p?dbPosLabel(p):pid)}`, drawer:true, width:980, body:()=>`<div class="row" style="margin-bottom:8px"><div style="flex:1"></div><button class="btn sm" onclick="exportTable('tDbH','Daily Balance история')">Выгрузить в Excel</button></div>
    <div class="tbl-wrap"><table id="tDbH"><thead><tr><th>D</th><th>Время</th><th>Запись</th><th>Автор</th><th class="num">Б</th><th class="num">П</th><th class="num">К</th><th class="num">Расхождение</th><th>Комментарий / причина</th></tr></thead>
    <tbody>${r.rows.map(x=>`<tr><td>${fmtD(x.date)}</td><td>${fmtT(x.t)}</td><td>${esc(K[x.kind]||x.kind)}${x.late?` <span class="tag off">опоздание</span>`:""}${x.noAccess?` <span class="tag warn">нет доступа</span>`:""}</td><td>${esc(x.uname||"")}</td>
      <td class="num">${x.kind==="correction"?(x.field==="b"?fmt(x.value):""):x.b!=null?fmt(x.b):""}</td><td class="num">${x.kind==="correction"?(x.field==="p"?fmt(x.value):""):x.p!=null?fmt(x.p):""}</td>
      <td class="num">${x.k!=null?fmt(x.k):""}</td><td class="num ${x.diff&&Math.abs(x.diff)>=0.005?"neg":""}">${x.diff!=null?fmtS(x.diff):""}</td><td>${esc(x.reason||x.comment||"")}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">Записей нет</td></tr>`}</tbody></table></div>`});
}

/* ---------------- 3. «Сверка» (ТР-100…ТР-103) ---------------- */
function viewDbRecon(){
  const T = "Daily Balance · сверка";
  const v = dbNeed("recon"); if(!v) return dbLoadingHtml(T);
  const S = v.summary; const confirmed = (S.ok||0) + (S.explained||0);
  const act = dbCanAct(); const closed = inClosed(v.date);
  const rows = v.rows.filter(r=>(!DBV.st || r.status===DBV.st) && (!DBV.org || r.org===DBV.org) && (!DBV.cur || r.cur===DBV.cur))
    .sort((a,b)=>(["diff","noreport","noaccess","explained","ok"].indexOf(a.status)-["diff","noreport","noaccess","explained","ok"].indexOf(b.status)) || (nm(org(a.org))+nm(acc(a.acc))).localeCompare(nm(org(b.org))+nm(acc(b.acc)),"ru"));
  const open = v.rows.filter(r=>r.status==="diff").sort((a,b)=>(b.age||0)-(a.age||0));
  return `<h1>${T} <span class="tzref">ТР-100…103</span></h1>
  <p class="lede">По каждой позиции на день D две проверки. Первая: Б − П против К — суммы кошельков на конец D−1 с разбивкой по кошелькам. Вторая: П казначея против списка неисполненных СБДС в программе. «На момент сдачи» — снимок, сохранённый при сдаче навсегда; «Сейчас» — К и П пересчитаны с учётом документов, донесённых позже.</p>
  <div class="db-head">
    <div class="ok"><span>Подтверждено</span><b>${confirmed} из ${S.total}</b><small>сходится ${S.ok||0} · объяснено ${S.explained||0}</small></div>
    <div class="${S.diff?"bad":""}"><span>Расхождения</span><b>${S.diff||0}</b></div>
    <div class="${S.noreport?"warn":""}"><span>Нет отчёта</span><b>${S.noreport||0}</b></div>
    <div class="${S.noaccess?"warn":""}"><span>Нет доступа к банку</span><b>${S.noaccess||0}</b></div>
  </div>
  ${open.length?`<div class="alert err"><b>Незакрытые расхождения:</b> ${open.map(r=>`<a class="lnk" onclick="DBV.open['${r.pos}']=1;render()">${esc(dbPosLabel(r))}</a> ${fmtS(r.diff)} — ${r.age} раб. дн.`).join("; ")}</div>`:""}
  ${dbDateBar(`<div class="fld"><span>Состояние сверки</span><div class="seg">${[["submit","На момент сдачи"],["now","Сейчас"]].map(([k,t])=>`<button type="button" class="${DBV.state===k?"on":""}" onclick="DBV.state='${k}';render()">${t}</button>`).join("")}</div></div>
    <label class="fld"><span>Статус</span><select onchange="DBV.st=this.value;render()"><option value="">Все</option>${Object.entries(DB_ST).map(([k,[t]])=>`<option value="${k}" ${DBV.st===k?"selected":""}>${t}</option>`).join("")}</select></label>
    <label class="fld"><span>Организация</span><select onchange="DBV.org=this.value;render()">${opts([...new Set(v.rows.map(r=>r.org))].map(o=>org(o)).filter(Boolean), DBV.org, {empty:"Все"})}</select></label>
    <label class="fld"><span>Валюта</span><select onchange="DBV.cur=this.value;render()">${opts([...new Set(v.rows.map(r=>r.cur))].map(c=>({id:c,name:curCode(c)})), DBV.cur, {empty:"Все"})}</select></label>`)}
  <div class="panel"><header><h2>${rows.length} позиций</h2><div style="flex:1"></div>${exportBtn("tDbR","Daily Balance сверка")}</header><div class="body flush"><div class="tbl-wrap"><table id="tDbR">
    <thead><tr><th></th><th>Организация</th><th>Счёт или касса · ответственный</th><th>Вал.</th><th class="num">Б</th><th class="num">П</th><th class="num">Б − П</th><th class="num">К</th><th class="num">Расхождение</th><th>Статус</th><th class="num" title="Проверка 2: П казначея минус список неисполненных СБДС программы">П: казн. − прогр.</th><th></th></tr></thead>
    <tbody>${rows.map(r=>dbReconRow(r, v, act, closed)).join("") || `<tr><td colspan="12" class="muted">Нет позиций${(DB.dbPositions||[]).length?"":" — администратор ещё не добавил позиции в модуль"}</td></tr>`}</tbody></table></div></div></div>`;
}
function dbReconRow(r, v, act, closed){
  const [stN, stC] = DB_ST[r.status]; const o = DBV.open[r.pos];
  const corrTip = c => c ? ` title="Скорректировано ${esc(c.uname)} ${fmtDT(c.t)}: ${esc(c.reason)}"` : "";
  const bCell = r.b==null ? "—" : `${fmt(r.b)}${r.bCorr?`<sup${corrTip(r.bCorr)}>испр.</sup><div class="sub muted">было ${fmt(r.bOrig)}</div>`:""}`;
  const pCell = r.p==null ? "—" : `${fmt(r.p)}${r.pCorr?`<sup${corrTip(r.pCorr)}>испр.</sup><div class="sub muted">было ${fmt(r.pOrig)}</div>`:""}`;
  const p2 = r.p2; const H = r.hints||{};
  const main = `<tr class="${r.status==="diff"?"bad":""} clickable" onclick="DBV.open['${r.pos}']=!DBV.open['${r.pos}'];render()">
    <td><span class="caret ${o?"open":""}"></span></td><td>${esc(nm(org(r.org)))}</td><td>${esc(nm(acc(r.acc)))}<div class="sub">${esc(r.owner?nm(usr(r.owner)):"ответственный не назначен")}</div></td><td>${esc(curCode(r.cur))}</td>
    <td class="num">${r.status==="noaccess"?`<span class="muted" title="Последний доступный остаток${r.last?` на ${fmtD(r.last.date)}`:""}">${bCell}</span>`:bCell}</td><td class="num">${pCell}</td>
    <td class="num">${r.b!=null&&r.p!=null?fmt(r2(r.b-r.p)):"—"}</td>
    <td class="num"><a class="lnk" onclick="event.stopPropagation();dbShowK('${r.acc}','${r.cur}','${r.date}')" title="Движения позиции">${fmt(r.k)}</a></td>
    <td class="num ${r.status==="diff"?"neg":""}"><b>${r.diff!=null?fmtS(r.diff):"—"}</b></td>
    <td><span class="tag ${stC}">${stN}</span>${r.age?` <span class="muted">${r.age} дн.</span>`:""}${r.late?` <span class="tag off">сдан с опозданием</span>`:""}</td>
    <td class="num ${p2&&Math.abs(p2.diff)>=0.005?"amber":""}">${p2?fmtS(p2.diff):"—"}</td>
    <td class="nowrap" onclick="event.stopPropagation()">${act&&r.status==="diff"?`<button class="btn sm" onclick="dbExplainOpen('${r.pos}','${r.date}')">Объяснено</button>`:""}${act&&r.report&&!closed?` <button class="btn sm ghost" onclick="dbCorrOpen('${r.report}','${r.pos}')">Корректировать</button>`:""}</td></tr>`;
  if(!o) return main;
  return main + `<tr class="detail"><td colspan="12"><div class="db-detail">
    <div><h4>Проверка 1: К по кошелькам на конец ${fmtD(addDays(r.date,-1))}</h4>
      <table class="mini"><tbody>${(r.kSplit||[]).map(k=>`<tr><td>${k.wallet==="*"?`<i>${esc(k.name)}</i>`:k.wallet?esc(k.name):`<span class="tag warn">Без кошелька</span>`}</td><td class="num">${fmt(k.sum)}</td></tr>`).join("") || `<tr><td class="muted" colspan="2">Движений нет</td></tr>`}
      <tr class="tot"><td>К</td><td class="num">${fmt(r.k)}</td></tr></tbody></table>
      ${r.comment?`<p><b>Комментарий казначея:</b> ${esc(r.comment)}</p>`:""}${r.incoming!=null?`<p class="muted">Входящие в пути (справочно): ${fmt(r.incoming)}</p>`:""}
      ${r.explained?`<div class="alert info">Объяснено: <span class="notr">${esc(r.explained.comment)}</span> — ${esc(r.explained.uname)}, ${fmtDT(r.explained.t)}</div>`:""}</div>
    <div><h4>Проверка 2: П казначея ${p2?fmt(p2.treasurer):"—"} против программы ${p2?fmt(p2.program):"—"}</h4>
      ${p2?`${p2.missing.length?`<p class="amber">Не отмечены казначеем, но не исполнены банком по данным программы:</p><ul>${p2.missing.map(x=>`<li><a class="lnk" onclick="dbOpen('doc','${x.doc}')">${esc(x.no||"")}</a> от ${fmtD(x.date)} — ${fmt(x.sum)} ${esc(x.cpty||"")}</li>`).join("")}</ul>`:""}
        ${p2.extra.length?`<p class="amber">Отмечены казначеем, но программа их уже не считает в пути:</p><ul>${p2.extra.map(x=>`<li><a class="lnk" onclick="dbOpen('doc','${x.doc}')">${esc(x.no||"")}</a> — ${fmt(x.sum)}</li>`).join("")}</ul>`:""}
        ${p2.manual.length?`<p>Ручные суммы П:</p><ul>${p2.manual.map(m=>`<li>${fmt(m.sum)} — ${esc(m.comment||"")}</li>`).join("")}</ul>`:""}
        ${!p2.missing.length&&!p2.extra.length&&!p2.manual.length?`<p class="muted">Списки совпадают.</p>`:""}`:`<p class="muted">Нет отчёта или нет доступа к банку.</p>`}</div>
    <div><h4>Подсказки</h4><ul class="hints">
      ${(H.same||[]).length?`<li>Документы с суммой ${fmt(Math.abs(r.diff||0))}: ${H.same.map(x=>`<a class="lnk" onclick="dbOpen('doc','${x.doc}')">${esc(x.no||"")}</a> ${fmtD(x.date)}${x.notCounted?" (не в расчёте)":""}`).join(", ")}</li>`:""}
      <li>Последний документ по позиции: ${H.lastDoc?fmtD(H.lastDoc):"нет"}</li>
      ${H.noWallet?`<li class="amber">Строк без кошелька: ${H.noWallet} ${seesNoWallet(me())?`<a class="lnk" onclick="go('nowallet')">открыть</a>`:""}</li>`:""}
      ${(H.review||[]).length?`<li class="amber">«Требует проверки»: ${H.review.map(x=>`<a class="lnk" onclick="dbOpen('doc','${x.doc}')">${esc(x.no||"")}</a>`).join(", ")}</li>`:""}
      <li><a class="lnk" onclick="dbShowK('${r.acc}','${r.cur}','${r.date}')">Движения позиции (клик по К)</a> · <a class="lnk" onclick="dbHistory('${r.pos}')">История позиции</a></li></ul></div>
  </div></td></tr>`;
}
let DBE = null;
function dbExplainOpen(pid, d){
  const p = posOf(pid); DBE = {pos:pid, date:d, comment:""};
  openModal({title:`Объяснено · ${esc(p?dbPosLabel(p):"")} за ${fmtD(d)}`, width:560, body:()=>`<label class="fld"><span>Причина расхождения <em>*</em></span><textarea rows="4" onchange="DBE.comment=this.value">${esc(DBE.comment)}</textarea></label>
    <p class="muted">Статус «Объяснено» ставит фин. контролер. Запись неизменяемая и попадает в историю позиции и журнал аудита.</p>`,
    footer:()=>`<button class="btn" onclick="closeModal()">Отмена</button><button class="btn primary" onclick="dbExplainSave()">Сохранить</button>`});
}
async function dbExplainSave(){
  const t = $("#modalHost textarea"); if(t) DBE.comment = t.value;
  if(!DBE.comment.trim()){ toast("Опишите причину", {lvl:"err"}); return; }
  const r = await mutate("/api/db/explain", {pos:DBE.pos, date:DBE.date, comment:DBE.comment});
  if(!r.ok) return showErrors(r); closeModal();
}
let DBC = null;
function dbCorrOpen(rep, pid){
  const p = posOf(pid); const row = DBV.recon.rows.find(x=>x.pos===pid); DBC = {report:+rep, pos:pid, field:"b", value:null, reason:""};
  openModal({title:`Корректировка · ${esc(p?dbPosLabel(p):"")} за ${fmtD(row.date)}`, width:560, body:()=>`
    <div class="seg" style="margin-bottom:10px">${[["b","Б — остаток по банку"],["p","П — исходящие в пути"]].map(([k,t])=>`<button type="button" class="${DBC.field===k?"on":""}" onclick="DBC.field='${k}';refreshModal()">${t}</button>`).join("")}</div>
    <p>Сейчас: <b>${fmt(DBC.field==="b"?row.b:row.p)}</b>${(DBC.field==="b"?row.bCorr:row.pCorr)?` (исходное ${fmt(DBC.field==="b"?row.bOrig:row.pOrig)})`:""}</p>
    <label class="fld"><span>Новое значение <em>*</em></span>${sumWithCur(moneyInput({id:"dbcV", value:DBC.value, onchange:"DBC.value=parseNum(this.value)"}), row.cur)}</label>
    <label class="fld" style="margin-top:8px"><span>Причина <em>*</em></span><textarea rows="3" id="dbcR" onchange="DBC.reason=this.value">${esc(DBC.reason)}</textarea></label>
    <p class="muted">Исходное значение остаётся, новое записывается рядом с причиной (ТР-98). В закрытом периоде корректировка запрещена (ТР-55).</p>`,
    footer:()=>`<button class="btn" onclick="closeModal()">Отмена</button><button class="btn primary" onclick="dbCorrSave()">Сохранить</button>`});
}
async function dbCorrSave(){
  const v = $("#dbcV"), t = $("#dbcR"); if(v) DBC.value = parseNum(v.value); if(t) DBC.reason = t.value;
  if(DBC.value===null || !isFinite(DBC.value)){ toast("Введите число", {lvl:"err"}); return; }
  if(!DBC.reason.trim()){ toast("Укажите причину", {lvl:"err"}); return; }
  const r = await mutate("/api/db/correct", DBC);
  if(!r.ok) return showErrors(r); closeModal(); toast("Корректировка записана", {lvl:"ok"});
}

/* ---------------- 4. Настройки Daily Balance (ТР-91, администратор) ---------------- */
const WD = ["","Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
let DBS = {hol:"", wd:"", newPos:""};
function viewDbSettings(){
  const S = DB.settings; const P = DB.dbPositions||[];
  const tres = DB.users.filter(u=>u.active && has(u,"treasurer"));
  const have = new Set(P.map(p=>p.acc+"|"+p.cur));
  const free = allPositions().filter(p=>isActiveAt(p.a, todayISO()) && !have.has(p.acc+"|"+p.cur));
  const tol = S.dbTol||{};
  const curs = [...new Set([...P.map(p=>curCode(p.cur)), ...Object.keys(tol)])].sort();
  const list = [...P].sort((a,b)=>(nm(org(acc(a.acc)&&acc(a.acc).org))+nm(acc(a.acc))+curCode(a.cur)).localeCompare(nm(org(acc(b.acc)&&acc(b.acc).org))+nm(acc(b.acc))+curCode(b.cur),"ru"));
  return `<h1>Настройки Daily Balance <span class="tzref">ТР-91</span></h1>
  <p class="lede">Позиции в модуле, один ответственный казначей на позицию (без заместителей; смена — вручную, попадает в журнал аудита), календарь рабочих дней — один на всю группу, контрольное время и допуск расхождения по валюте.</p>
  <div class="split">
    <div class="panel"><header><h2>Срок сдачи</h2><span class="tzref">ТР-94</span></header><div class="body stack">
      <label class="fld"><span>Контрольное время, МСК</span><input type="time" value="${esc(S.dbTime||"10:30")}" onchange="setSetting('dbTime',this.value)" style="max-width:140px"></label>
      <span class="muted">Отчёт, не сданный к этому времени, получает статус «Просрочен»; сдать можно позже, опоздание фиксируется. Сейчас в Москве рабочий день для отчёта: ${fmtD(DB.dbCurrent)}.</span></div></div>
    <div class="panel"><header><h2>Допуск расхождения</h2><span class="tzref">ТР-91</span></header><div class="body stack">
      <table class="mini"><thead><tr><th>Валюта</th><th>Допуск, в валюте позиции</th></tr></thead><tbody>
      ${curs.map(c=>`<tr><td>${esc(c)}</td><td>${moneyInput({value:tol[c]||0, onchange:`dbTolSet('${c}',parseNum(this.value))`, style:"width:140px"})}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">Добавьте позиции — появятся их валюты</td></tr>`}</tbody></table>
      <span class="muted">По умолчанию 0,00: любое расхождение больше допуска — «Расхождение».</span></div></div>
  </div>
  <div class="panel"><header><h2>Календарь рабочих дней</h2><span class="tzref">ТР-94</span></header><div class="body split">
    <div class="stack"><span>Выходные дни недели</span><div class="row">${[1,2,3,4,5,6,7].map(d=>`<label class="chk"><input type="checkbox" ${(S.dbWeekends||[6,7]).includes(d)?"checked":""} onchange="dbWeekend(${d},this.checked)"> ${WD[d]}</label>`).join("")}</div></div>
    <div class="stack"><span>Праздничные дни (нерабочие)</span><div class="row"><input type="date" value="${DBS.hol}" onchange="DBS.hol=this.value"><button class="btn sm" onclick="dbDay('dbHolidays',DBS.hol,true)">Добавить</button></div>
      <div class="chips">${(S.dbHolidays||[]).map(d=>`<span class="tag">${fmtD(d)} <a class="lnk" onclick="dbDay('dbHolidays','${d}',false)" aria-label="Удалить">×</a></span>`).join("") || `<span class="muted">нет</span>`}</div></div>
    <div class="stack"><span>Рабочие выходные (перенос)</span><div class="row"><input type="date" value="${DBS.wd}" onchange="DBS.wd=this.value"><button class="btn sm" onclick="dbDay('dbWorkdays',DBS.wd,true)">Добавить</button></div>
      <div class="chips">${(S.dbWorkdays||[]).map(d=>`<span class="tag">${fmtD(d)} <a class="lnk" onclick="dbDay('dbWorkdays','${d}',false)" aria-label="Удалить">×</a></span>`).join("") || `<span class="muted">нет</span>`}</div></div>
  </div></div>
  <div class="panel"><header><h2>Позиции в модуле · ${P.length}</h2><span class="tzref">ТР-91, ТР-92</span><div style="flex:1"></div>
    <select onchange="DBS.newPos=this.value" style="max-width:340px"><option value="">— добавить позицию —</option>${free.map(p=>`<option value="${p.acc}|${p.cur}" ${DBS.newPos===p.acc+"|"+p.cur?"selected":""}>${esc(nm(org(p.a.org)))} · ${esc(p.a.name)} · ${esc(curCode(p.cur))}</option>`).join("")}</select>
    <button class="btn" onclick="dbPosAdd()" ${free.length?"":"disabled"}>Добавить</button>
    <button class="btn primary" onclick="dbPosAll()" ${free.length?"":"disabled"} title="Все действующие счета и кассы × их валюты">Добавить все (${free.length})</button></header>
  <div class="body flush"><div class="tbl-wrap"><table id="tDbP"><thead><tr><th>Организация</th><th>Счёт или касса</th><th>Валюта</th><th>Ответственный казначей</th><th>В модуле</th></tr></thead>
  <tbody>${list.map(p=>{ const a = acc(p.acc); return `<tr class="${p.active?"":"excl"}"><td>${esc(a?nm(org(a.org)):"")}</td><td>${esc(nm(a))}</td><td>${esc(curCode(p.cur))}</td>
    <td><select onchange="dbPosSave('${p.id}',{owner:this.value})"><option value="">— не назначен —</option>${tres.map(u=>`<option value="${u.id}" ${p.owner===u.id?"selected":""}>${esc(u.name)}</option>`).join("")}</select>${!p.owner&&p.active?` <span class="tag warn">нет ответственного</span>`:""}</td>
    <td><label class="chk"><input type="checkbox" ${p.active?"checked":""} onchange="dbPosSave('${p.id}',{active:this.checked})"> активна</label></td></tr>`; }).join("") || `<tr><td colspan="5" class="muted">Позиций нет. Нажмите «Добавить все» — по каждому действующему счёту и кассе будет строка на каждую валюту (мультивалютный счёт — несколько строк).</td></tr>`}</tbody></table></div></div></div>`;
}
async function dbTolSet(c, v){ const t = Object.assign({}, DB.settings.dbTol||{}); t[c] = isFinite(v) && v!==null ? Math.abs(v) : 0; await setSetting("dbTol", t); }
async function dbWeekend(d, on){ const a = new Set(DB.settings.dbWeekends||[6,7]); on ? a.add(d) : a.delete(d); await setSetting("dbWeekends", [...a].sort()); }
async function dbDay(k, d, on){ if(!d){ toast("Выберите дату", {lvl:"err"}); return; } const a = new Set(DB.settings[k]||[]); on ? a.add(d) : a.delete(d); DBS.hol = DBS.wd = ""; await setSetting(k, [...a].sort()); }
async function dbPosAdd(){ if(!DBS.newPos) return; const [a,c] = DBS.newPos.split("|"); const r = await mutate("/api/db/positions", {position:{acc:a, cur:c, active:true}}); if(!r.ok) return showErrors(r); DBS.newPos = ""; }
async function dbPosAll(){ const r = await mutate("/api/db/positions/all"); if(!r.ok) return showErrors(r); toast(`Добавлено позиций: ${r.result}`, {lvl:"ok"}); }
async function dbPosSave(id, ch){ const p = posOf(id); const r = await mutate("/api/db/positions", {position:Object.assign({id, owner:p.owner||"", active:p.active}, ch)}); if(!r.ok){ showErrors(r); render(); } }
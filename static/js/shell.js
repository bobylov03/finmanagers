"use strict";
/* ============================================================
   10. ИНТЕРФЕЙС: КАРКАС
   ============================================================ */
let VIEW = "dash";
let MODAL = null;
const REPORT_VIEWS = {rep37:"Деньги по кошелькам на дату", rep75:"Где лежат деньги", rep38:"Фактический ДДС с остатками", rep40:"Внутренние займы", recon:"Сверка с 1С"};

function menu(){
  const u = me(); const A = isAdmin(u);
  const nf = notifications(u);
  const cnt = k => nf.filter(n=>n.go===k).length;
  const noW = facts().filter(f=>!f.wallet && f.src.k==="doc").length;
  const M = [
    ["Обзор", [["dash","Сводка"]]],
    ["Отчёты", [["rep37","Деньги по кошелькам"],["rep75","Где лежат деньги"],["rep38","Фактический ДДС"],["rep40","Внутренние займы"],["recon","Сверка с 1С", recon().filter(r=>Math.abs(r.diff)>=0.005).length||""]]],
    ["Операции", [
      ["docs","Документы"],
      ["ops","Внутренние операции"],
      ...(seesNoWallet(u) ? [["nowallet","Без кошелька", noW||""]] : []),
      ...(A||has(u,"treasurer") ? [["formalize","Требует оформления", needsFormalizing().length||""],["closedch","Изменения в закрытом периоде", cnt("closedch")?DB.closedChanges.length:""]] : []),
    ]],
    ["Справочники", [["wallets","Кошельки"], ...(A?[["rules","Правила автозаполнения"],["refs","Справочники 1С"]]:[])]],
    ...(A ? [["Администрирование", [["import","Загрузка файлов"],["xlog","Журнал обмена"],["opening","Входящие остатки"],["users","Пользователи и права"],["mail","Рассылка уведомлений"],["settings","Период и настройки"],["audit","Журнал аудита"]]]] : []),
  ];
  return M;
}
function allowedViews(){ return new Set(menu().flatMap(g=>g[1].map(x=>x[0]))); }
function go(v){
  if(!allowedViews().has(v)) v = "dash";
  VIEW = v; window.scrollTo(0,0);
  render();
}
function renderNav(){
  $("#nav").innerHTML = menu().map(([g,items])=>`<div class="rail-group">${esc(g)}</div>` +
    items.map(([id,t,c])=>`<a class="${VIEW===id?"on":""}" onclick="go('${id}')"><span>${esc(t)}</span><span class="cnt">${c||""}</span></a>`).join("")).join("");
}
/* --- всплывающие панели в шапке и на экранах: одна открыта за раз --- */
let POP = null;
function togglePop(id, ev){ if(ev) ev.stopPropagation(); POP = POP===id ? null : id; if(String(id).startsWith("v:")||String(POP||"").startsWith("v:")) render(); else { renderTop(); translateDom($(".topbar")); } }
function closePop(){ if(!POP) return; const v = String(POP).startsWith("v:"); POP = null; if(v) render(); else { renderTop(); translateDom($(".topbar")); } }
document.addEventListener("click", e=>{ if(POP && !e.target.closest(".popwrap")) closePop(); });

function initials(n){ return String(n||"?").split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase(); }
function prevMonthEnd(){ const d = new Date(CUR.date+"T00:00:00Z"); d.setUTCDate(0); return d.toISOString().slice(0,10); }
function setCurDate(d){ CUR.date = d || todayISO(); inval(); render(); }

function renderTop(){
  const u = me();
  $("#userBox").innerHTML = `<button type="button" class="userbtn" onclick="togglePop('user',event)" aria-expanded="${POP==="user"}">
      <span class="avatar notr">${esc(initials(nm(u)))}</span><span class="uname">${esc(nm(u))}</span><span class="caret"></span></button>
    ${POP==="user" ? `<div class="pop pop-right" role="menu">
      <div class="pop-head"><b>${esc(nm(u))}</b><span class="muted">${esc(u.login||"")}</span>
        <div class="row" style="margin-top:8px;gap:4px">${u.roles.map(r=>`<span class="tag ${r==="admin"?"ok":""}">${esc(ROLES[r])}</span>`).join("")}</div></div>
      <button type="button" class="pop-item" onclick="POP=null;renderTop();changeOwnPw()">Сменить пароль</button>
      <button type="button" class="pop-item" onclick="logout()">Выйти</button></div>` : ""}`;
  $("#curDate").value = CUR.date;
  const t = todayISO(), pm = prevMonthEnd();
  $("#dateQuick").innerHTML = [[t,"Сегодня"],[pm,"Конец прошлого месяца"]].map(([d,l])=>`<button type="button" class="chip ${CUR.date===d?"on":""}" onclick="setCurDate('${d}')">${l}</button>`).join("");
  $("#userTags").innerHTML = "";
  $("#periodTag").innerHTML = (SAVE_ERR ? `<span class="tag off" title="${esc(SAVE_ERR)}">данные не сохранены</span> ` : "") + (DB.settings.closedTo ? `<span class="tag warn" title="ТР-55">период закрыт по ${fmtD(DB.settings.closedTo)}</span>` : "");
  const nf = notifications(u); const dot = $("#bellDot");
  dot.textContent = nf.length; dot.classList.toggle("hidden", !nf.length);
  $("#bell").setAttribute("aria-expanded", POP==="bell");
  $("#bellPop").innerHTML = POP==="bell" ? `<div class="pop pop-right pop-wide" role="dialog" aria-label="Уведомления">
      <div class="pop-title">Уведомления <span class="muted">${nf.length||""}</span></div>
      ${nf.length ? nf.map(n=>`<button type="button" class="note ${n.lvl}" onclick="POP=null;go('${n.go}')"><span class="note-mark"></span><span class="note-text">${esc(n.text)} <span class="tzref">${n.tr}</span></span></button>`).join("")
        : `<p class="muted" style="margin:6px 14px 14px">Новых уведомлений нет.</p>`}</div>` : "";
}

/* --- шапка страницы: заголовок + свёрнутое пояснение «Как это работает» --- */
let HELP = {}; try{ HELP = JSON.parse(localStorage.getItem("wallets-help")||"{}"); }catch(e){}
function toggleHelp(){ HELP[VIEW] = !HELP[VIEW]; try{ localStorage.setItem("wallets-help", JSON.stringify(HELP)); }catch(e){} render(); }
function pageHead(){
  const v = $("#view"); const h = v.querySelector(":scope > h1"); if(!h) return;
  const lede = h.nextElementSibling && h.nextElementSibling.matches("p.lede") ? h.nextElementSibling : null;
  const head = document.createElement("div"); head.className = "page-head";
  const crumb = menu().find(g=>g[1].some(x=>x[0]===VIEW));
  head.innerHTML = `<div class="ph-main">${crumb?`<div class="crumb">${esc(crumb[0])}</div>`:""}</div>`;
  h.parentNode.insertBefore(head, h); head.firstChild.appendChild(h);
  if(lede){
    const b = document.createElement("button"); b.type = "button"; b.className = "help-toggle"; b.setAttribute("aria-expanded", !!HELP[VIEW]);
    b.textContent = HELP[VIEW] ? "Скрыть пояснение" : "Как это работает"; b.onclick = toggleHelp;
    head.appendChild(b);
    lede.classList.add("help"); if(!HELP[VIEW]) lede.hidden = true;
    head.after(lede);
  }
}

/* --- поиск по разделам и действиям (Ctrl+K) --- */
let CMD = null;
function cmdItems(){
  const u = me(); const out = [];
  menu().forEach(([g,items])=>items.forEach(([id,t])=>out.push({t, g, run:()=>go(id)})));
  if(canEnter(u)){
    out.push({t:"Новое поступление на счёт", g:"Действие", run:()=>newDoc("ПБДС")});
    out.push({t:"Новое поступление в кассу", g:"Действие", run:()=>newDoc("ПКО")});
    out.push({t:"Новая конвертация или переброска", g:"Действие", run:()=>newDoc("ПЕР")});
    out.push({t:"Новая внутренняя операция", g:"Действие", run:()=>newOp()});
  }
  visibleTree().forEach(w=>out.push({t:w.name, g:"Кошелёк", run:()=>{ RF.rep75.wallets=[w.id]; go("rep75"); }}));
  out.push({t:"Сменить пароль", g:"Профиль", run:()=>changeOwnPw()});
  return out;
}
function openCmd(){ CMD = {q:"", i:0}; renderCmd(); setTimeout(()=>{ const el = $("#cmdQ"); if(el) el.focus(); },0); }
function closeCmd(){ CMD = null; $("#cmdHost").innerHTML = ""; }
function cmdList(){ const q = norm(CMD.q); return cmdItems().filter(x=>!q || norm(x.t+" "+x.g).includes(q)).slice(0,12); }
function renderCmd(){
  if(!CMD) return; const L = cmdList(); CMD.i = Math.min(CMD.i, Math.max(0,L.length-1));
  const host = $("#cmdHost");
  if(!host.firstChild){
    host.innerHTML = `<div class="scrim cmd-scrim" onmousedown="if(event.target===this)closeCmd()"><div class="cmd" role="dialog" aria-label="Поиск">
      <input id="cmdQ" type="text" autocomplete="off" placeholder="Раздел, действие или кошелёк" oninput="CMD.q=this.value;CMD.i=0;renderCmd()" onkeydown="cmdKey(event)">
      <div id="cmdL" class="cmd-list" role="listbox"></div><div class="cmd-foot">↑↓ выбрать · Enter открыть · Esc закрыть</div></div></div>`;
  }
  $("#cmdL").innerHTML = L.map((x,i)=>`<div class="cmd-item ${i===CMD.i?"on":""}" role="option" onmousemove="if(CMD.i!==${i}){CMD.i=${i};renderCmd()}" onclick="cmdRun(${i})"><span>${esc(x.t)}</span><span class="muted">${esc(x.g)}</span></div>`).join("") || `<div class="cmd-empty muted">Ничего не найдено</div>`;
  translateDom(host);
}
function cmdRun(i){ const x = cmdList()[i]; closeCmd(); if(x) x.run(); }
function cmdKey(e){
  if(e.key==="ArrowDown"){ e.preventDefault(); CMD.i++; renderCmd(); }
  else if(e.key==="ArrowUp"){ e.preventDefault(); CMD.i = Math.max(0,CMD.i-1); renderCmd(); }
  else if(e.key==="Enter"){ e.preventDefault(); cmdRun(CMD.i); }
  else if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); closeCmd(); }
}
document.addEventListener("keydown", e=>{ if((e.ctrlKey||e.metaKey) && (e.key==="k"||e.key==="K"||e.code==="KeyK") && SESSION){ e.preventDefault(); CMD ? closeCmd() : openCmd(); } });

/* --- выбор кошельков: кнопка с выпадающим деревом --- */
function walletPicker(key, selected, onToggle, {label="Кошельки", all="Все доступные", onClear="", onAll=""}={}){
  const id = "v:"+key; const open = POP===id;
  const txt = !selected.length ? all : selected.length===1 ? nm(wal(selected[0])) : `${nm(wal(selected[0]))} и ещё ${selected.length-1}`;
  return `<div class="fld popwrap"><span>${esc(label)}</span>
    <button type="button" class="picker ${selected.length?"set":""}" onclick="togglePop('${id}',event)" aria-expanded="${open}"><span>${esc(txt)}</span><span class="caret"></span></button>
    ${open?`<div class="pop pop-left">${walletChecklist(selected,onToggle)}
      <div class="pop-foot">${onAll?`<button type="button" class="btn sm" onclick="${onAll}">Выбрать все</button>`:""}${onClear?`<button type="button" class="btn sm" onclick="${onClear}">Снять</button>`:""}<div style="flex:1"></div><button type="button" class="btn sm primary" onclick="closePop()">Готово</button></div></div>`:""}</div>`;
}
/* --- переключатель-флажок в виде «чипа» --- */
function chip(on, onclick, label){ return `<button type="button" class="chip ${on?"on":""}" aria-pressed="${!!on}" onclick="${onclick}">${label}</button>`; }

let R_BUSY = false, RM_BUSY = false;
function render(){
  if(R_BUSY){ setTimeout(render,0); return; }
  R_BUSY = true; try{ renderInner(); } finally { R_BUSY = false; }
}
function renderInner(){
  if(!allowedViews().has(VIEW)) VIEW = "dash";
  renderNav(); renderTop();
  const V = {dash:viewDash, rep37:viewRep37, rep75:viewRep75, rep38:viewRep38, rep40:viewRep40, recon:viewRecon,
    docs:viewDocs, ops:viewOps, nowallet:viewNoWallet, formalize:viewFormalize, closedch:viewClosedCh,
    wallets:viewWallets, rules:viewRules, refs:viewRefs, import:viewImport, xlog:viewXlog, opening:viewOpening,
    users:viewUsers, mail:viewMail, settings:viewSettings, audit:viewAudit}[VIEW] || viewDash;
  let html; try{ html = V(); }catch(e){ console.error(e); html = `<div class="alert err">Ошибка отображения: ${esc(e.message)}</div>`; }
  $("#view").innerHTML = html;
  pageHead();
  logReportView();
  renderLang(); translateDom($("#nav")); translateDom($(".topbar")); translateDom($("#view"));
  renderModal();
}
function renderModal(){
  if(RM_BUSY){ setTimeout(renderModal,0); return; }
  RM_BUSY = true; try{ renderModalInner(); } finally { RM_BUSY = false; }
}
function renderModalInner(){
  const host = $("#modalHost");
  if(!MODAL){ host.innerHTML = ""; return; }
  const scrollEl = host.querySelector(".modal .body"); const st = scrollEl ? scrollEl.scrollTop : 0;
  const active = document.activeElement; const aid = active && active.id && host.contains(active) ? active.id : null;
  const selS = aid && active.selectionStart!=null ? active.selectionStart : null;
  host.innerHTML = `<div class="scrim ${MODAL.drawer?"drawer-scrim":""}" onmousedown="if(event.target===this)closeModal()"><div class="modal ${MODAL.drawer?"drawer":""}" role="dialog" aria-modal="true" style="${MODAL.width&&!MODAL.drawer?`width:min(${MODAL.width}px,100%)`:""}">
    <header><h3>${MODAL.title}</h3><div style="flex:1"></div>${MODAL.headerExtra||""}<button class="btn sm" onclick="closeModal()" aria-label="Закрыть">✕</button></header>
    <div class="body">${MODAL.body()}</div>
    <footer>${MODAL.footer ? MODAL.footer() : `<button class="btn" onclick="closeModal()">Закрыть</button>`}</footer>
  </div></div>`;
  translateDom(host);
  const b = host.querySelector(".modal .body"); if(b) b.scrollTop = st;
  if(aid){ const el = document.getElementById(aid); if(el){ el.focus(); try{ if(selS!=null) el.setSelectionRange(selS,selS); }catch(e){} } }
}
function openModal(cfg){ MODAL = cfg; renderModal(); }
function closeModal(){ MODAL = null; renderModal(); }
function refreshModal(){ if(MODAL) renderModal(); }

/* --- выпадающие списки --- */
function opts(list, val, {empty="— не выбрано —", label=nm}={}){
  return (empty!==null?`<option value="">${esc(empty)}</option>`:"") + list.map(x=>`<option value="${esc(x.id)}" ${x.id===val?"selected":""}>${esc(label(x))}</option>`).join("");
}
function optsTree(arr, val, empty="— не выбрано —", filter){
  return (empty!==null?`<option value="">${esc(empty)}</option>`:"") + tree(arr).filter(x=>!filter||filter(x)).map(x=>`<option value="${x.id}" ${x.id===val?"selected":""}>${"   ".repeat(x._lvl)}${esc(x.name)}</option>`).join("");
}
/** Кошельки для выбора в документе: не закрытые на дату (ТР-25), доступные пользователю */
function optsWallets(val, date, {onlyEditable=false, empty="— без кошелька —", filter}={}){
  const u = me();
  const ok = w => !walletClosedAt(w,date) && (isAdmin(u) || hiddenAllowed(u,w)) && (!onlyEditable || canEditWallet(u,w.id)) && (!filter || filter(w));
  let html = (empty!==null?`<option value="">${esc(empty)}</option>`:"");
  html += tree(DB.wallets).map(w=>{
    const sel = w.id===val; if(!ok(w) && !sel) return "";
    return `<option value="${w.id}" ${sel?"selected":""} ${ok(w)?"":"disabled"}>${"   ".repeat(w._lvl)}${esc(w.name)}${walletClosedAt(w,date)?" (закрыт)":""}</option>`;
  }).join("");
  return html;
}
function optsAccounts(orgId, val, {cash=null, curId=null, empty="— выберите —"}={}){
  let list = [];
  if(cash!==true) list.push(...DB.accounts.map(a=>Object.assign({kind:"Счёт"},a)));
  if(cash!==false) list.push(...DB.cashboxes.map(a=>Object.assign({kind:"Касса"},a)));
  list = list.filter(a=>a.org===orgId && (!curId || a.cur===curId) && (isActiveAt(a,CUR.date) || a.id===val));
  return `<option value="">${esc(orgId?empty:"— сначала организация —")}</option>` + list.map(a=>`<option value="${a.id}" ${a.id===val?"selected":""}>${esc(a.name)} · ${esc(curCode(a.cur))}${a.accType==="Депозитный"?" · депозит":""}</option>`).join("");
}

/* --- ввод сумм с разделением разрядов (МД-10) --- */
function moneyIn(el, dec){
  dec = dec || 2;
  const pos = el.selectionStart ?? el.value.length, raw = el.value;
  const sig = ch => /[\d,\-]/.test(ch);
  const leftRaw = raw.slice(0,pos).replace(/\./g,",");
  const left = [...leftRaw].filter(sig).length;
  let s = raw.replace(/\./g,",").replace(/[^\d,\-]/g,"");
  const neg = s.startsWith("-"); s = s.replace(/-/g,"");
  const parts = s.split(","); let i = parts[0].replace(/^0+(?=\d)/,""); const hasC = parts.length>1;
  const d = parts.slice(1).join("").slice(0,dec);
  const out = (neg?"-":"") + i.replace(/\B(?=(\d{3})+(?!\d))/g," ") + (hasC?","+d:"");
  el.value = out;
  let c=0, p=0; while(p<out.length && c<left){ if(sig(out[p])) c++; p++; }
  try{ el.setSelectionRange(p,p); }catch(e){}
}
function moneyInput({id, value, onchange, dec=2, placeholder="0,00", readonly=false, style=""}){
  return `<input type="text" inputmode="decimal" class="money" ${id?`id="${id}"`:""} value="${esc(fmtIn(value,dec))}" placeholder="${placeholder}" style="${style}"
    ${readonly?"readonly":`oninput="moneyIn(this,${dec})" onchange="${onchange}"`}>`;
}
/** Сумма + валюта рядом, валюта из счёта и не редактируется (МД-09) */
function sumWithCur(inputHtml, curId){ return `<span class="sumcell">${inputHtml}<span class="cur" title="Валюта счёта — не редактируется">${esc(curId?curCode(curId):"—")}</span></span>`; }
const amt = (n, curId, {signed=false, dec=2}={}) => `<span class="num ${n<0?"neg":""}">${signed?fmtS(n,dec):fmt(n,dec)}</span>${curId?` <span class="muted">${esc(curCode(curId))}</span>`:""}`;

/* --- выгрузка в Excel: только то, что видно на экране (ТР-36) --- */
function exportTable(tableId, name){
  const t = document.getElementById(tableId); if(!t){ alert("Нет данных для выгрузки"); return; }
  const rows = [...t.querySelectorAll("tr")].map(tr=>[...tr.children].map(td=>{
    const txt = (td.tagName==="TH" ? td.textContent : td.innerText).replace(/[\u00a0\u202f]/g," ").replace(/\s*\n\s*/g,"; ").trim();
    if(td.classList.contains("num")){ const n = parseNum(txt.replace(/^\+/,"").replace(/[A-Z]{3}$/,"").trim()); if(isFinite(n)) return n; }
    return txt;
  }));
  const fname = `${name} ${CUR.date}.xlsx`;
  downloadBlob(xlsxBlob([{name:name.slice(0,31), rows}]), fname);
  audit("Выгрузка в Excel", name, `файл ${fname}; строк ${rows.length-1}; ${reportFilterText(VIEW)}`);
}
/** ТР-44: просмотр отчёта с фильтрами — пишется при открытии и при каждом изменении фильтров */
let LAST_REPORT_LOG = "";
function logReportView(){
  if(!REPORT_VIEWS[VIEW]) { LAST_REPORT_LOG = ""; return; }
  const key = VIEW + "|" + CUR.u + "|" + reportFilterText(VIEW);
  if(key === LAST_REPORT_LOG) return;
  LAST_REPORT_LOG = key; audit("Просмотр отчёта", REPORT_VIEWS[VIEW], reportFilterText(VIEW));
}
function reportFilterText(v){
  const F = RF[v]; if(!F) return "";
  if(!F.date && ("date" in F)) F._дата = CUR.date; else delete F._дата;
  if("to" in F && !F.to) F._по = CUR.date; else delete F._по;
  return Object.entries(F).filter(([k,x])=>x!=="" && x!==null && !(Array.isArray(x)&&!x.length)).map(([k,x])=>`${k}=${Array.isArray(x)?x.map(id=>nm(wal(id))||id).join(","):x}`).join("; ");
}

/* --- выбор нескольких кошельков деревом --- */
function walletChecklist(selected, onToggle, {only}={}){
  const V = only || visibleWallets();
  return `<div class="msel">${tree(DB.wallets).filter(w=>V.has(w.id)).map(w=>`<label class="chk" style="padding-left:${w._lvl*14}px">
    <input type="checkbox" ${selected.includes(w.id)?"checked":""} onchange="${onToggle}('${w.id}',this.checked)"> ${esc(w.name)}${w.closed?` <span class="muted">(закрыт)</span>`:""}</label>`).join("") || `<span class="muted">Кошельков нет</span>`}</div>`;
}
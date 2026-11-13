"use strict";
/* ============================================================
   25. ЯЗЫК ИНТЕРФЕЙСА RU / EN (ТР-50)
   Перевод готового интерфейса: строки сопоставляются по шаблону, в котором
   данные (названия, даты, суммы, номера) заменены на {0}, {1}… и не переводятся.
   ============================================================ */
let LANG = "ru";
try{ LANG = localStorage.getItem("wallets-lang") || "ru"; }catch(e){}
const I18N = {};           // заполняется ниже: шаблон RU → EN
let NAME_RE = null, NAME_VER = null;
function nameRe(){
  const ver = DB ? [DB.currencies.length,DB.orgs.length,DB.accounts.length,DB.cashboxes.length,DB.wallets.length,DB.rules.length,DB.users.length,DB.depts.length,DB.cfTypes.length,DB.zones.length,DB.contracts.length,DB.currencies.length].join(".") + (DB.wallets.map(w=>w.name).join("|").length) : "";
  if(NAME_RE!==null && NAME_VER===ver) return NAME_RE;
  NAME_VER = ver;
  const names = new Set();
  if(DB) ["orgs","accounts","cashboxes","currencies","cfTypes","depts","zones","wallets","rules","contracts","users"].forEach(k=>(DB[k]||[]).forEach(x=>{ [x.name, x.login, x.bank].forEach(n=>{ if(n && String(n).trim().length>1 && /[А-Яа-яЁё]/.test(n)) names.add(String(n).trim()); }); }));
  const codes = new Set(["USD"]); if(DB) DB.currencies.forEach(c=>{ const k = c.code || c.name || c.id; if(k && /^[A-Z]{3}$/.test(k)) codes.add(k); });
  codes.forEach(c=>names.add(c));
  const list = [...names].sort((a,b)=>b.length-a.length).map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"));
  NAME_RE = list.length ? new RegExp("(?<![А-Яа-яЁёA-Za-z0-9])(?:" + list.join("|") + ")(?![А-Яа-яЁёA-Za-z0-9])","g") : null;
  return NAME_RE;
}
const TOK_RE = [
  /«[^»]*»/g,
  /\d{2}\.\d{2}\.\d{4}(?:, \d{2}:\d{2})?/g,
  /(?:ПБ|ПК|ПР|ВО)-\d{6}/g,
  /(?:ТР|МД)-\d+(?:\s?[…,–-]\s?\d+)*/g,
  /[^\s«»"(),;:]+\.(?:xlsx|csv|json|eml|txt)\b/g,
];
const SUFFIX = [[" (нет в справочнике)"," (not in directory)"],[" (закрыт)"," (closed)"]];
const NUM_RE = /(?<![A-Za-zА-Яа-яЁё0-9.,_\-])[−+\-]?\d{1,3}(?:[  ]\d{3})*(?:,\d+)?(?![A-Za-zА-Яа-яЁё0-9])|(?<![A-Za-zА-Яа-яЁё0-9.,_])\d+(?![A-Za-zА-Яа-яЁё0-9])/g;
/** Текст → {key, vals}: данные вынесены в {n} */
function tokenize(text){
  const vals = []; let key = text;
  const put = m => { vals.push(m); return "\u0001" + String.fromCharCode(0xE000 + vals.length - 1) + "\u0002"; };
  TOK_RE.forEach(re=>{ key = key.replace(re, put); });
  const nr = nameRe(); if(nr) key = key.replace(nr, put);
  key = key.replace(NUM_RE, put);
  // нормализуем порядок: {0},{1}… по порядку появления
  const order = []; key = key.replace(/\u0001([\uE000-\uF8FF])\u0002/g, (_,c)=>{ order.push(vals[c.charCodeAt(0)-0xE000]); return "{" + (order.length-1) + "}"; });
  return {key, vals:order};
}
function trTok(v){
  if(v.startsWith("«")){ const inner = v.slice(1,-1); const t = I18N[inner]; return t!==undefined ? "“"+t+"”" : v; }
  return v.replace(/^ТР-/,"TR-").replace(/^МД-/,"MD-").replace(/ТР-/g,"TR-");
}
/* ДР-01-30.10.2026: сообщения сервера с переменной частью (списки листов, номеров) — по образцу */
const REASON_EN = {"нет обязательных столбцов":"missing required columns","устаревшие столбцы, исключённые из формата":"obsolete columns removed from the format","лишние или переименованные столбцы":"extra or renamed columns","столбцы повторяются":"duplicated columns","столбцы без названия с данными":"unnamed columns with data","есть устаревшие столбцы":"obsolete columns present"};
const TR_PATTERNS = [
  [/^(нет обязательных столбцов|устаревшие столбцы, исключённые из формата|лишние или переименованные столбцы|столбцы повторяются|столбцы без названия с данными|есть устаревшие столбцы): (.+)$/s, (k,x)=>`${REASON_EN[k]}: ${x}`],
  [/^(Списание безналичных ДС|Расходный кассовый ордер|Поступление на счёт|Поступление в кассу|Конвертация \/ переброска) № (.+)$/s, (t,no)=>`${({"Списание безналичных ДС":"Non-cash payment","Расходный кассовый ордер":"Cash payment order","Поступление на счёт":"Bank receipt","Поступление в кассу":"Cash receipt","Конвертация / переброска":"Conversion / transfer"})[t]} No. ${no}`],
  [/^нарушен порядок столбцов: на месте (\d+) ожидается (.+), в файле — (.+)$/s, (n,a,b)=>`wrong column order: position ${n} should be ${a}, the file has ${b}`],
  [/^не найдена строка заголовков с обязательным столбцом (.+)$/s, x=>`no header row with the required column ${x}`],
  [/^Листы не распознаны и пропущены: (.+)\. Назовите лист по справочнику .+$/s, x=>`Sheets not recognized and skipped: ${x}. Name each sheet after a reference (Organizations, Accounts, Cash desks, Currencies, Rates, CF expense types, Departments, Zones).`],
  [/^Курсы (\S+): нет курса за рабочие дни (.+?) — на эти даты USD-показатели будут предварительными; запросите курсы при следующем обмене \(ДР-02-23\.10\)$/s, (c,d)=>`Rates ${c}: no rate for working days ${d.replace(/ и ещё /," and more ")} — USD figures for these dates will be preliminary; request the rates in the next exchange (CR-02-23.10)`],
  [/^Документов с этими GUID ещё нет: (\d+) — признаки сохранятся и применятся при загрузке отчёта .+$/s, n=>`No documents with these GUIDs yet: ${n} — the flags are saved and applied when the Approval history report is loaded`],
  [/^Неподдерживаемый формат файла «История согласования»: (.+)$/s, x=>`Unsupported “Approval history” file format: ${x.replace(/нет обязательных столбцов/g,"missing required columns").replace(/устаревшие столбцы, исключённые из формата/g,"obsolete columns removed from the format").replace(/лишние или переименованные столбцы/g,"extra or renamed columns").replace(/столбцы повторяются/g,"duplicated columns").replace(/нарушен порядок столбцов/g,"wrong column order").replace(/ожидается/g,"expected").replace(/в файле/g,"in file").replace(/на месте/g,"at position")}`],
  // ДР-03-10.11.2026: запрет сохранения несбалансированных входящих остатков
  [/^Невозможно сохранить входящие остатки\. Сумма распределения по кошелькам не соответствует контрольному остатку\. Расхождение: (.+?)\. Исправьте распределение перед сохранением$/s, x=>`Opening balances cannot be saved. The wallet distribution total does not match the control balance. Difference: ${x}. Correct the distribution before saving`],
];
function tr(text){
  if(LANG==="ru" || !text || !/[А-Яа-яЁё]/.test(text)) return text;
  const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0]; const core = text.trim();
  if(I18N[core]!==undefined) return lead + I18N[core] + trail;
  for(const [re, fn] of TR_PATTERNS){ const m = core.match(re); if(m) return lead + fn(...m.slice(1)) + trail; }
  // ссылки на пункты ТЗ (ТР-24, ДР-02-23.10, МД-11) — латиницей
  if(/^(?:(?:ТР|ДР|МД)-[\d.…,\s-]+)+$/.test(core)) return lead + core.replace(/ТР-/g,"TR-").replace(/ДР-/g,"CR-").replace(/МД-/g,"MD-") + trail;
  for(const [ru,en] of SUFFIX) if(core.endsWith(ru)) return lead + core.slice(0,-ru.length) + en + trail;
  const {key, vals} = tokenize(core);
  let en = I18N[key];
  // строка из одних данных (ТР-24, названия, суммы) — переводим только ссылки на ТЗ
  if(en===undefined && /^[\s{}\d,.:;·→—–()\-\/]*$/.test(key)) en = key;
  if(en===undefined){ if(window.__MISS) window.__MISS.add(key); return text; }
  return lead + en.replace(/\{(\d+)\}/g, (_,i)=>trTok(vals[+i] ?? "")) + trail;
}
function translateDom(root){
  if(!root) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes = []; let n;
  while(n = w.nextNode()){ if((n.__ru || /[А-Яа-яЁё]/.test(n.nodeValue)) && !(n.parentElement && n.parentElement.closest("script,style,textarea,.notr"))) nodes.push(n); }
  // статичные узлы помнят русский оригинал — чтобы переключение EN → RU возвращало текст
  nodes.forEach(n=>{ const src = n.__ru || n.nodeValue; if(LANG==="ru"){ if(n.__ru){ n.nodeValue = n.__ru; } return; }
    const t = tr(src); if(t!==src){ n.__ru = src; n.nodeValue = t; } });
  if(LANG==="ru") return;
  root.querySelectorAll("[placeholder],[title],[aria-label]").forEach(el=>["placeholder","title","aria-label"].forEach(a=>{ const v = el.getAttribute(a); if(v && /[А-Яа-яЁё]/.test(v)){ const t = tr(v); if(t!==v) el.setAttribute(a,t); } }));
}
function setLang(l){
  LANG = l; try{ localStorage.setItem("wallets-lang", l); }catch(e){}
  document.documentElement.lang = l;
  if(SESSION){ apiRaw("/api/lang", {lang:l}).catch(()=>{}); render(); }
  else showLogin();
}
function langSwitch(){ return `<span class="row" style="gap:2px">${["ru","en"].map(l=>`<button class="btn sm ${LANG===l?"primary":""}" onclick="setLang('${l}')">${l.toUpperCase()}</button>`).join("")}</span>`; }
function renderLang(){ const a = $("#langBox"); if(a) a.innerHTML = langSwitch(); const b = $("#langBoxLogin"); if(b) b.innerHTML = langSwitch();
  translateDom(document.querySelector(".brand")); document.title = LANG==="en" ? "Wallet balances" : "Остатки по кошелькам"; }
const _alert = window.alert.bind(window), _confirm = window.confirm.bind(window);
window.alert = m => toast(m, {lvl:alertLevel(m)}); window.confirm = m => _confirm(trMsg(m));
function trMsg(m){ return LANG==="ru" ? m : String(m).split("\n").map(tr).join("\n"); }
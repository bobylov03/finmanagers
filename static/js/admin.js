"use strict";
/* ============================================================
   15. ЗАГРУЗКА ФАЙЛОВ (ТР-60…67, ТР-70, ТР-64, ТР-65)
   ============================================================ */
const EXP_SPEC = {
  guid:["GUID документа 1С","GUID документа","GUID","Идентификатор документа"],
  type:["Тип","Тип документа","Вид документа"],
  op:["Хозяйственная операция","Хоз. операция","Хоз операция","Операция"],
  no:["Номер","Номер документа"],
  date:["Дата","Дата документа","Дата создания"],
  org:["Организация"],
  acc:["Счёт или касса","Счет или касса","Банковский счёт","Банковский счет","Счёт","Счет","Касса"],
  cur:["Валюта"],
  status:["Статус"],
  approved:["Согласован","Прошёл согласование","Согласование"],
  bank:["Проведено банком","Признак проведено банком"],
  bankDate:["Дата проведения банком"],
  sum:["Сумма в валюте","Сумма"],
  usd:["Сумма в USD","Сумма USD"],
  wallet:["Кошелёк","Кошелек"],
  dept:["Подразделение"],
  cf:["Тип расхода CF","Тип расхода","Статья ДДС"],
  zone:["Зона ответственности","Зона"],
  cpty:["Контрагент"],
  contract:["Договор"],
  purpose:["Назначение платежа","Назначение"],
};
const EXP_REQ = ["guid","type","date","org","acc","sum","status"];
const EXP_HEAD = ["GUID документа 1С","Тип","Хозяйственная операция","Номер","Дата","Организация","Счёт или касса","Валюта","Статус","Согласован","Проведено банком","Дата проведения банком","Сумма в валюте","Сумма в USD","Кошелёк","Подразделение","Тип расхода CF","Зона ответственности","Контрагент","Договор","Назначение платежа"];
const ID_AL = ["Идентификатор","GUID","ID","Ид","Код"];
const REF_KINDS = {
  currencies:{name:"Валюты", key:"currencies", spec:{id:["Идентификатор","GUID","ID","Код"], name:["Наименование"], code:["Символьный код","Буквенный код","Код ISO"]}, req:["id"], head:["Идентификатор","Наименование","Символьный код"]},
  rates:{name:"Курсы к USD", key:"rates", spec:{cur:["Валюта"], date:["Дата"], rate:["Курс","Курс к USD","Единиц валюты за 1 USD"]}, req:["cur","date","rate"], head:["Валюта","Дата","Курс"]},
  orgs:{name:"Организации", key:"orgs", spec:{id:ID_AL, name:["Наименование"], deact:["Дата деактивации"]}, req:["id","name"], head:["Идентификатор","Наименование","Дата деактивации"]},
  accounts:{name:"Банковские счета", key:"accounts", spec:{id:ID_AL, name:["Наименование"], org:["Организация"], cur:["Валюта"], bank:["Банк"], accType:["Вид счёта","Вид счета","Вид"], deact:["Дата деактивации"]}, req:["id","name","org","cur"], head:["Идентификатор","Наименование","Организация","Валюта","Банк","Вид счёта","Дата деактивации"]},
  cashboxes:{name:"Кассы", key:"cashboxes", spec:{id:ID_AL, name:["Наименование"], org:["Организация"], cur:["Валюта"], deact:["Дата деактивации"]}, req:["id","name","org","cur"], head:["Идентификатор","Наименование","Организация","Валюта","Дата деактивации"]},
  cfTypes:{name:"Типы расхода CF", key:"cfTypes", spec:{id:ID_AL, name:["Наименование"], deact:["Дата деактивации"]}, req:["id","name"], head:["Идентификатор","Наименование","Дата деактивации"]},
  depts:{name:"Подразделения", key:"depts", spec:{id:ID_AL, name:["Наименование"], parent:["Родитель","Вышестоящее подразделение"], deact:["Дата деактивации"]}, req:["id","name"], head:["Идентификатор","Наименование","Родитель","Дата деактивации"]},
  zones:{name:"Зоны ответственности", key:"zones", spec:{id:ID_AL, name:["Наименование"], deact:["Дата деактивации"]}, req:["id","name"], head:["Идентификатор","Наименование","Дата деактивации"]},
};
const REF_ORDER = ["currencies","rates","orgs","accounts","cashboxes","cfTypes","depts","zones"];
function refKindBySheet(n){ const s = norm(n);
  if(s.includes("курс")) return "rates"; if(s.includes("валют")) return "currencies"; if(s.includes("касс")) return "cashboxes";
  if(s.includes("счет")) return "accounts"; if(s.includes("подразд")) return "depts"; if(s.includes("зон")) return "zones";
  if(s.includes("организац")) return "orgs"; if(s.includes("тип") || s.includes("cf") || s.includes("стат")) return "cfTypes"; return ""; }
const BAL_SPEC = {date:["Дата"], acc:["Счёт или касса","Счет или касса","Счёт","Счет","Касса","Банковский счёт"], cur:["Валюта"], sum:["Остаток","Остаток в валюте","Сумма"]};

let IMP = {tab:"exp", fileName:"", sheets:null, err:null, sel:null, pv:null, refKind:"", logged:false};
const cellOf = (row, map, k) => map[k]===undefined ? undefined : row[map[k]];
const txt = v => v===null||v===undefined ? "" : String(v).trim();

async function impFile(input){
  const f = input.files && input.files[0]; if(!f) return;
  IMP = Object.assign(IMP, {fileName:f.name, sheets:null, err:null, sel:null, pv:null, logged:false});
  busy(true);
  try{ IMP.sheets = await readAnyFile(f); }catch(e){ IMP.err = e.message; }
  finally{ busy(false); }
  if(IMP.sheets && IMP.tab==="ref" && IMP.sheets.length===1) IMP.refKind = refKindBySheet(IMP.sheets[0].name) || IMP.refKind || "";
  await impPreview(); render();
}
/** Файл читает браузер, проверку и сопоставление по GUID делает сервер */
function impPayload(){ return {sheets:IMP.sheets, sel:IMP.sel, refKind:IMP.refKind||"", fileName:IMP.fileName}; }
async function impPreview(){
  if(!IMP.sheets) return;
  busy(true);
  try{
    const r = await apiRaw(`/api/import/${IMP.tab}/preview`, Object.assign(impPayload(), {logReject:!IMP.logged}));
    if(!r.ok){ IMP.err = r.errors.join("; "); IMP.pv = null; return; }
    IMP.err = null; IMP.pv = r.preview; IMP.logged = true;
    if(IMP.tab==="exp" && r.preview.sel) IMP.sel = r.preview.sel;
    if(r.preview.errors && r.preview.errors.length){ await reloadState(); }
  } catch(e){ IMP.err = "Нет связи с сервером: " + e.message; }
  finally{ busy(false); }
}
async function impApply(){
  const tab = IMP.tab;
  const r = await mutate(`/api/import/${tab}/apply`, impPayload());
  if(!r.ok){ IMP.err = r.errors.join("; "); render(); return; }
  IMP = {tab, fileName:"", sheets:null, err:null, sel:null, pv:null, logged:false, refKind:""};
  go(tab==="bal" ? "recon" : tab==="exp" ? "xlog" : "import");
}
const applyExp = impApply, applyRef = impApply, applyBal = impApply;
function downloadTemplate(kind){
  if(kind==="exp") downloadBlob(xlsxBlob([{name:"Расходы", rows:[EXP_HEAD]}, {name:"Описание", rows:[["Колонка","Обязательно","Значения"],
    ["GUID документа 1С","да","Ключ документа 1С. Несколько строк с одним GUID — строки расшифровки одного документа"],["Тип","да","СБДС или РКО; ПБДС и ПКО — только с даты перехода на автообмен (ТР-72), до неё поступления вводятся вручную"],
    ["Хозяйственная операция","","Операции из списка ТР-70 пропускаются: они вводятся вручную"],["Дата","да","Дата создания документа, ДД.ММ.ГГГГ"],
    ["Организация","да","Идентификатор или наименование из 1С"],["Счёт или касса","да","Идентификатор или наименование; должен принадлежать организации"],
    ["Валюта","","Если указана — должна совпадать с валютой счёта"],["Статус","да","Проведён / Не проведён / На согласовании / Помечен на удаление. В расчёт входит только «Проведён»"],["Согласован","","Да / Нет — для СБДС. Если колонка пуста, документ считается согласованным. Несогласованный СБДС не входит в остаток (ТР-07)"],
    ["Проведено банком","","Да / Нет — только для СБДС"],["Дата проведения банком","","Для СБДС"],["Сумма в валюте","да","Положительное число; расход вычитается автоматически"],
    ["Сумма в USD","","Из 1С. Если пусто — пересчёт по курсу ERP на дату"],["Кошелёк","","Необязательно — назначается правилами в приложении (ТР-73)"],
    ["Подразделение, Тип расхода CF, Зона ответственности","","Идентификатор или наименование из 1С"]]}]), "Шаблон — расходы из 1С.xlsx");
  if(kind==="ref") downloadBlob(xlsxBlob(REF_ORDER.map(k=>({name:REF_KINDS[k].name, rows:[REF_KINDS[k].head]}))), "Шаблон — справочники 1С.xlsx");
  if(kind==="bal") downloadBlob(xlsxBlob([{name:"Остатки 1С", rows:[["Дата","Счёт или касса","Валюта","Остаток"]]}]), "Шаблон — остатки 1С.xlsx");
}
function impSelOrg(id,on){ const S = IMP.sel; S.orgs = on ? [...new Set([...S.orgs,id])] : S.orgs.filter(x=>x!==id); impPreview().then(render); }
function errTable(list, title, cls="err"){
  if(!list.length) return "";
  return `<div class="alert ${cls}"><b>${esc(title)}: ${list.length}</b><div class="tbl-wrap" style="max-height:220px;margin-top:6px"><table><thead><tr><th style="width:70px">Строка</th><th>Описание</th></tr></thead>
    <tbody>${list.slice(0,300).map(e=>`<tr><td>${esc(e.row)}</td><td>${esc(e.msg)}</td></tr>`).join("")}</tbody></table></div></div>`;
}
function viewImport(){
  const T = IMP.tab; const P = IMP.pv;
  const tabs = [["exp","Документы 1С","ТР-60…63"],["ref","Справочники и курсы","ТР-64"],["bal","Остатки 1С для сверки","ТР-65"]];
  let pv = "";
  if(IMP.err) pv = `<div class="alert err">${esc(IMP.err)}</div>`;
  else if(P && T==="exp"){
    const S = IMP.sel;
    pv = `<div class="panel"><header><h2>Предпросмотр · ${esc(IMP.fileName)}</h2><span class="hint">${P.rows||0} строк</span></header><div class="body">
      ${P.allOrgs.length?`<div class="filters" style="margin-bottom:12px">
        <div class="fld"><span>Загрузка заменяет период для организаций (ТР-62)</span><div class="msel">${P.allOrgs.map(o=>`<label class="chk"><input type="checkbox" ${S.orgs.includes(o)?"checked":""} onchange="impSelOrg('${o}',this.checked)"> ${esc(nm(org(o)))}</label>`).join("")}</div></div>
        <label class="fld"><span>Даты с</span><input type="date" value="${S.from}" onchange="IMP.sel.from=this.value;impPreview().then(render)"></label>
        <label class="fld"><span>по</span><input type="date" value="${S.to}" onchange="IMP.sel.to=this.value;impPreview().then(render)"></label>
        <span class="muted" style="max-width:48ch">Документы этих организаций и дат, которых нет в файле, будут исключены из расчёта. Повторная загрузка того же файла ничего не меняет.</span></div>`:""}
      <div class="stats" style="border:1px solid var(--line-soft);border-radius:4px;margin-bottom:12px">
        <div class="stat"><b>${P.add.length}</b><span>добавится</span></div><div class="stat"><b>${P.upd.length}</b><span>изменится</span></div>
        <div class="stat"><b>${P.exc.length}</b><span>исключится</span></div><div class="stat"><b>${P.same.length}</b><span>без изменений</span></div>
        <div class="stat"><b class="${P.errors.length?"neg":""}">${P.errors.length}</b><span>ошибок</span></div></div>
      ${P.errors.length?`<div class="alert err">Файл с ошибками целиком не загружается (ТР-63). Исправьте файл в 1С и загрузите снова.</div>`:""}
      ${errTable(P.errors,"Ошибки по строкам")}
      ${P.closed.length?`<div class="alert warn">Затрагивает закрытый период: ${P.closed.length} док. Изменения будут приняты (1С — мастер) и попадут в список «Изменения в закрытом периоде» (ТР-56).</div>`:""}
      ${P.skip70.length?`<div class="alert warn"><b>Пропущено — уже введено вручную (ТР-70): ${P.skip70.length} строк</b><div class="tbl-wrap" style="max-height:200px;margin-top:6px"><table><thead><tr><th>Строка</th><th>GUID</th><th>Организация</th><th>Хоз. операция</th><th class="num">Сумма</th></tr></thead>
        <tbody>${P.skip70.map(s=>`<tr><td>${s.row}</td><td><code class="k">${esc(s.guid)}</code></td><td>${esc(nm(org(s.org)))}</td><td>${esc(s.op)}</td><td class="num">${fmt(s.sum)} ${esc(curCode(s.cur))}</td></tr>`).join("")}</tbody></table></div></div>`:""}
      ${errTable(P.warns,"Предупреждения","warn")}
      ${P.skipOut.length?`<p class="muted">Вне выбранных организаций/дат или до начала учёта: ${P.skipOut.length} строк — не загружаются.</p>`:""}
      ${P.exc.length?`<details><summary>Будут исключены (${P.exc.length})</summary><table><tbody>${P.exc.slice(0,200).map(e=>`<tr><td>${fmtD(e.date)}</td><td>${e.type} ${esc(e.no1c)}</td><td><code class="k">${esc(e.guid)}</code></td><td class="num">${fmt(e.total)} ${esc(curCode(e.cur))}</td></tr>`).join("")}</tbody></table></details>`:""}
      <div class="row" style="margin-top:12px"><button class="btn primary" ${P.errors.length||(!P.add.length&&!P.upd.length&&!P.exc.length)?"disabled":""} onclick="applyExp()">Загрузить</button>
        <button class="btn" onclick="IMP.sheets=null;IMP.pv=null;IMP.fileName='';render()">Отменить</button>
        ${!P.errors.length&&!P.add.length&&!P.upd.length&&!P.exc.length?`<span class="muted">Изменений нет — данные уже совпадают с файлом.</span>`:""}</div>
    </div></div>`;
  } else if(P && T==="ref"){
    pv = `<div class="panel"><header><h2>Предпросмотр · ${esc(IMP.fileName)}</h2></header><div class="body">
      ${IMP.sheets.length===1?`<label class="fld" style="max-width:320px;margin-bottom:10px"><span>Что в файле</span><select onchange="IMP.refKind=this.value;impPreview().then(render)"><option value="">— выберите справочник —</option>${REF_ORDER.map(k=>`<option value="${k}" ${IMP.refKind===k?"selected":""}>${REF_KINDS[k].name}</option>`).join("")}</select></label>`:""}
      <table><thead><tr><th>Справочник</th><th>Лист</th><th class="num">Новых</th><th class="num">Изменится</th><th class="num">Без изменений</th></tr></thead>
      <tbody>${Object.values(P.stats).map(s=>`<tr><td>${esc(s.name)}</td><td>${esc(s.sheet)}</td><td class="num">${s.add}</td><td class="num">${s.upd}</td><td class="num">${s.same}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Нечего загружать</td></tr>`}</tbody></table>
      ${errTable(P.errors,"Ошибки")}${errTable(P.warns,"Предупреждения","warn")}
      <div class="row" style="margin-top:12px"><button class="btn primary" ${P.errors.length||!Object.values(P.stats).some(s=>s.add||s.upd)?"disabled":""} onclick="applyRef()">Загрузить</button>
      <button class="btn" onclick="IMP.sheets=null;IMP.pv=null;IMP.fileName='';render()">Отменить</button></div></div></div>`;
  } else if(P && T==="bal"){
    pv = `<div class="panel"><header><h2>Предпросмотр · ${esc(IMP.fileName)}</h2></header><div class="body">
      <p>Строк: <b>${P.items}</b>${P.dates&&P.dates.length?` · даты: ${P.dates.map(fmtD).join(", ")}`:""}</p>
      ${errTable(P.errors,"Ошибки")}
      <div class="row"><button class="btn primary" ${P.errors.length||!P.items?"disabled":""} onclick="applyBal()">Загрузить и сверить</button>
      <button class="btn" onclick="IMP.sheets=null;IMP.pv=null;IMP.fileName='';render()">Отменить</button></div></div></div>`;
  }
  const help = {
    exp:`Одна строка файла = одна строка расшифровки документа (ТР-61). Колонки: ${EXP_HEAD.join(", ")}. Кошелёк необязателен — проставляется правилами. Расходы СБДС и РКО загружаются всегда; строки с хозяйственными операциями ${DB.settings.excludedOps.map(x=>`«${x}»`).join(", ")} до даты перехода пропускаются — они введены вручную (ТР-70). Поступления ПБДС и ПКО принимаются только с даты перехода на автообмен${DB.settings.switchDate?" ("+fmtD(DB.settings.switchDate)+")":" (сейчас не задана)"} — ТР-72.`,
    ref:`Одна книга .xlsx с листами «Организации», «Банковские счета», «Кассы», «Валюты», «Курсы к USD», «Типы расхода CF», «Подразделения», «Зоны ответственности» — или один .csv с выбором справочника. Элементы сопоставляются по идентификатору ERP; удаления нет — только «Дата деактивации» (ТР-19). Курс — в форме котировки: сколько единиц валюты за 1 USD (например, 3,6725 AED), не менее 6 знаков (ТР-32).`,
    bal:`Колонки: Дата, Счёт или касса, Валюта, Остаток. Сверка выполняется на дату загруженных остатков (ТР-65).`,
  }[T];
  return `<h1>Загрузка файлов</h1>
  <p class="lede">Временный режим до запуска шлюза: расходы, справочники, курсы и остатки выгружаются из 1С в файлы. Формат совпадает с контрактом обмена, поэтому при переходе на автообмен документы сопоставятся по GUID без дублей (ТР-66).</p>
  <div class="tabs">${tabs.map(([k,t,tr])=>`<a class="${T===k?"on":""}" onclick="IMP={tab:'${k}',fileName:'',sheets:null,err:null,sel:null,pv:null,logged:false,refKind:''};render()">${t} <span class="tzref">${tr}</span></a>`).join("")}</div>
  <div class="panel"><div class="body">
    <p style="margin-top:0">${esc(help)}</p>
    <div class="row">
      <label class="drop" style="flex:1" ondragover="event.preventDefault();this.classList.add('over')" ondragleave="this.classList.remove('over')"
        ondrop="event.preventDefault();this.classList.remove('over');const i=this.querySelector('input');i.files=event.dataTransfer.files;impFile(i)">
        <input type="file" accept=".xlsx,.csv,.txt" style="display:none" onchange="impFile(this)">
        <b>${IMP.fileName?esc(IMP.fileName):"Выберите файл .xlsx или .csv"}</b><br><span class="muted">или перетащите его сюда</span></label>
      <button class="btn" onclick="downloadTemplate('${T}')">Скачать шаблон</button>
    </div>
  </div></div>${pv}`;
}
function viewXlog(){
  return `<h1>Журнал обмена <span class="tzref">ТР-18, ТР-67</span></h1>
  <p class="lede">Каждая загрузка: кто, когда, файл, итоги. Отклонённые файлы тоже записываются — при двух неудачах подряд администратор получает уведомление.</p>
  <div class="panel"><header><div style="flex:1"></div>${exportBtn("tX","Журнал обмена")}</header><div class="body flush"><div class="tbl-wrap"><table id="tX"><thead><tr><th>Время</th><th>Кто</th><th>Что</th><th>Файл</th><th class="num">Принято</th><th class="num">Обновлено</th><th class="num">Исключено</th><th class="num">Ошибок</th><th>Подробности</th></tr></thead>
  <tbody>${DB.exchangeLog.slice().reverse().map(e=>`<tr class="${e.errors?"bad":""}"><td>${fmtDT(e.t)}</td><td>${esc(nm(usr(e.u)))}</td><td>${esc(e.kind)}</td><td>${esc(e.file)}</td>
    <td class="num">${e.added}</td><td class="num">${e.updated}</td><td class="num">${e.excluded}</td><td class="num ${e.errors?"neg":""}">${e.errors}</td><td style="font-size:11px" class="notr">${esc(e.text)}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">Загрузок ещё не было</td></tr>`}</tbody></table></div></div></div>`;
}

/* ============================================================
   16. ВХОДЯЩИЕ ОСТАТКИ (ТР-20…22)
   ============================================================ */
let OB = null;
function viewOpening(){
  DRILLS = []; const d0 = DB.settings.startDate;
  if(!d0) return `<h1>Входящие остатки <span class="tzref">ТР-21</span></h1><div class="alert warn">Сначала задайте дату начала учёта по кошелькам (ТР-20). <a class="lnk" onclick="go('settings')">Период и настройки</a></div>`;
  const accs = [...DB.accounts.map(a=>Object.assign({kind:"Счёт"},a)), ...DB.cashboxes.map(a=>Object.assign({kind:"Касса"},a))].filter(a=>isActiveAt(a,d0))
    .sort((a,b)=>(nm(org(a.org))+a.name).localeCompare(nm(org(b.org))+b.name,"ru"));
  const locked = inClosed(d0);
  return `<h1>Входящие остатки на ${fmtD(d0)} <span class="tzref">ТР-21, ТР-22</span></h1>
  <p class="lede">Вводит только администратор, в разрезе кошелёк × счёт или касса × валюта. Сумма кошельков по каждому счёту должна равняться остатку счёта в 1С на ту же дату — расхождение видно до сохранения. Остаток 1С берётся из загруженного файла остатков.</p>
  ${locked?`<div class="alert warn">Дата начала учёта в закрытом периоде — входящие остатки менять нельзя (ТР-55).</div>`:""}
  <div class="panel"><header><div style="flex:1"></div>${exportBtn("tOB","Входящие остатки")}</header><div class="body flush"><div class="tbl-wrap" style="max-height:none"><table id="tOB">
    <thead><tr><th>Организация</th><th>Счёт или касса</th><th>Вал.</th><th class="num">Остаток 1С</th><th class="num">Сумма кошельков</th><th class="num">Расхождение</th><th>Кошельки</th><th></th></tr></thead>
    <tbody>${accs.map(a=>{ const rows = DB.opening.filter(x=>x.acc===a.id); const s = r2(rows.reduce((t,x)=>t+x.sum,0));
      const b = DB.bal1c.find(x=>x.acc===a.id && x.date===d0); const diff = b ? r2(s-b.sum) : null;
      return `<tr class="${diff&&Math.abs(diff)>=0.005?"bad":""}"><td>${esc(nm(org(a.org)))}</td><td>${esc(a.name)}</td><td>${esc(curCode(a.cur))}</td>
        <td class="num">${b?fmt(b.sum):`<span class="muted">не загружен</span>`}</td><td class="num">${fmt(s)}</td><td class="num ${diff?"neg":""}">${diff===null?"—":fmtS(diff)}</td>
        <td style="font-size:11px">${rows.map(x=>`${esc(nm(wal(x.wallet)))}: ${fmt(x.sum)}`).join("<br>")}</td>
        <td>${locked?"":`<button class="btn sm" onclick="openOpening('${a.id}')">Изменить</button>`}</td></tr>`; }).join("") || `<tr><td colspan="8" class="muted">Нет счетов и касс — загрузите справочники 1С</td></tr>`}</tbody></table></div></div></div>`;
}
function openOpening(accId){
  const a = acc(accId); const d0 = DB.settings.startDate;
  OB = {acc:accId, rows: DB.opening.filter(x=>x.acc===accId).map(x=>clone(x))};
  if(!OB.rows.length) OB.rows.push({id:uid("OB"), acc:accId, wallet:"", sum:null});
  openModal({title:`Входящие остатки · ${esc(a.name)} · ${esc(curCode(a.cur))} на ${fmtD(d0)}`, width:760, body:()=>{
    const s = r2(OB.rows.reduce((t,x)=>t+(x.sum||0),0)); const b = DB.bal1c.find(x=>x.acc===accId && x.date===d0); const diff = b ? r2(s-b.sum) : null;
    return `<table><thead><tr><th>Кошелёк</th><th style="width:230px">Сумма</th><th></th></tr></thead><tbody>
      ${OB.rows.map((x,i)=>`<tr><td><select onchange="OB.rows[${i}].wallet=this.value">${optsWallets(x.wallet,d0,{empty:"— выберите —"})}</select></td>
        <td>${sumWithCur(moneyInput({id:`ob${i}`, value:x.sum, onchange:`OB.rows[${i}].sum=parseNum(this.value);refreshModal()`}), a.cur)}</td>
        <td><button class="btn sm" onclick="OB.rows.splice(${i},1);refreshModal()">✕</button></td></tr>`).join("")}
      <tr class="tot"><td>Сумма кошельков</td><td class="num">${fmt(s)} ${esc(curCode(a.cur))}</td><td></td></tr></tbody></table>
      <button class="btn sm" style="margin-top:8px" onclick="OB.rows.push({id:uid('OB'),acc:'${accId}',wallet:'',sum:null});refreshModal()">Добавить кошелёк</button>
      <div class="alert ${diff===null?"warn":Math.abs(diff)<0.005?"ok":"err"}" style="margin-top:12px">${diff===null?`Остаток 1С на ${fmtD(d0)} не загружен — контроль ТР-22 невозможен.`:Math.abs(diff)<0.005?`Совпадает с остатком 1С: ${fmt(b.sum)}`:`Расхождение с 1С: ${fmtS(diff)} ${esc(curCode(a.cur))} (1С: ${fmt(b.sum)})`}</div>`; },
    footer:()=>`<button class="btn" onclick="closeModal()">Отмена</button><button class="btn primary" onclick="saveOpening()">Сохранить</button>`});
}
async function saveOpening(){
  const d0 = DB.settings.startDate; if(inClosed(d0)){ alert("Период закрыт"); return; }
  const rows = OB.rows.filter(x=>x.wallet || x.sum);
  if(rows.some(x=>!x.wallet || !isFinite(x.sum))){ alert("В каждой строке нужны кошелёк и сумма"); return; }
  if(new Set(rows.map(x=>x.wallet)).size!==rows.length){ alert("Кошелёк указан дважды"); return; }
  const s = r2(rows.reduce((t,x)=>t+x.sum,0)); const b = DB.bal1c.find(x=>x.acc===OB.acc && x.date===d0);
  if(b && Math.abs(s-b.sum)>=0.005 && !confirm(`Сумма кошельков ${fmt(s)} не равна остатку 1С ${fmt(b.sum)}. Сохранить с расхождением?`)) return;
  const r = await mutate(`/api/opening/${encodeURIComponent(OB.acc)}`, {rows:rows.map(x=>({id:x.id, wallet:x.wallet, sum:x.sum}))});
  if(!r.ok) return showErrors(r);
  closeModal();
}
/* ============================================================
   17. КОШЕЛЬКИ (раздел 4–5)
   ============================================================ */
let WE = null;
function viewWallets(){
  const u = me(); const A = isAdmin(u); const V = visibleWallets(u);
  const list = A ? tree(DB.wallets) : visibleTree();
  const bc = {}; facts().forEach(f=>{ if(f.wallet && f.date<=CUR.date){ (bc[f.wallet]=bc[f.wallet]||{})[f.cur]=((bc[f.wallet]||{})[f.cur]||0)+f.sum; } });
  const usdSub = id => { const all = {}; descendants(id).forEach(w=>{ if(!V.has(w)) return; Object.entries(bc[w]||{}).forEach(([c,v])=>all[c]=(all[c]||0)+v); }); return usdOf(all,CUR.date).usd; };
  return `<h1>Кошельки</h1>
  <p class="lede">Кошелёк — то же, что финцентр: управленческий владелец денег. Иерархия до 4 уровней. Удаления нет — закрытие с даты, история остаётся в отчётах (ТР-19). Закрытый кошелёк нельзя выбрать в документах, правилах и операциях (ТР-25).</p>
  <div class="panel"><header><h2>${list.length} кошельков</h2><div style="flex:1"></div>${A?`<button class="btn primary" onclick="openWallet(null)">Добавить кошелёк</button>`:""}</header>
  <div class="body flush"><div class="tbl-wrap" style="max-height:none"><table>
    <thead><tr><th>Наименование</th><th>Признаки</th><th>Статус</th><th>Казначеи</th><th>Доступ к скрытому</th><th class="num">Остаток, USD</th><th></th></tr></thead>
    <tbody>${list.map(w=>`<tr><td><span class="tree-pad" style="width:${w._lvl*18}px"></span>${esc(w.name)}</td>
      <td>${w.head?`<span class="tag ok">головной</span> `:""}${w.hidden?`<span class="tag warn">скрытый</span>`:""}</td>
      <td>${w.closed?`<span class="tag off">закрыт с ${fmtD(w.closedFrom)}</span>`:`<span class="tag ok">действует</span>`}</td>
      <td>${esc(treasurersOf(w.id).map(id=>nm(usr(id))).join(", "))}</td>
      <td>${w.hidden?esc((w.access||[]).map(id=>nm(usr(id))).join(", ")||"никто, кроме администратора"):""}</td>
      <td class="num">${V.has(w.id)?fmt(usdSub(w.id)):""}</td>
      <td class="num">${A?`<button class="btn sm" onclick="openWallet('${w.id}')">Изменить</button>`:""}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">Кошельков нет</td></tr>`}</tbody></table></div></div></div>`;
}
function openWallet(id){
  WE = id ? clone(wal(id)) : {id:uid("W"), name:"", parent:null, head:false, hidden:false, access:[], closed:false, closedFrom:"", created:new Date().toISOString()};
  WE._err = null; WE._target = "";
  openModal({title: id ? `Кошелёк «${esc(WE.name)}»` : "Новый кошелёк", width:760, body:walletBody,
    footer:()=>`<button class="btn" onclick="closeModal()">Отмена</button><button class="btn primary" onclick="saveWallet()">Сохранить</button>`});
}
function walletBody(){
  const w = WE; const exist = !!wal(w.id); const own = exist ? descendants(w.id) : new Set([w.id]);
  const bal = exist && w.closed && w.closedFrom ? [...balances(w.closedFrom, facts().filter(f=>f.wallet===w.id)).values()].filter(r=>Math.abs(r.sum)>=0.005) : [];
  return `${w._err?`<div class="alert err">${esc(w._err)}</div>`:""}<div class="grid2">
    <label class="fld"><span>Наименование <em>*</em></span><input type="text" value="${esc(w.name)}" onchange="WE.name=this.value"></label>
    <label class="fld"><span>Родитель</span><select onchange="WE.parent=this.value||null;refreshModal()">${optsTree(DB.wallets, w.parent, "— верхний уровень —", x=>!own.has(x.id))}</select><small>Не более 4 уровней</small></label>
  </div>
  <div class="stack" style="margin-top:12px">
    <label class="chk"><input type="checkbox" ${w.head?"checked":""} onchange="WE.head=this.checked"> Головной кошелёк — получает излишки и дивиденды, финансирует другие кошельки</label>
    <label class="chk"><input type="checkbox" ${w.hidden?"checked":""} onchange="WE.hidden=this.checked;refreshModal()"> Скрытый — виден только пользователям из списка доступа, даже если роль видит все кошельки (ТР-35)</label>
    ${w.hidden?`<div class="msel" style="margin-left:22px">${DB.users.filter(u=>!isAdmin(u)).map(u=>`<label class="chk"><input type="checkbox" ${(w.access||[]).includes(u.id)?"checked":""} onchange="WE.access=this.checked?[...new Set([...(WE.access||[]),'${u.id}'])]:(WE.access||[]).filter(x=>x!=='${u.id}')"> ${esc(u.name)} <span class="muted">${esc(roleNames(u))}</span></label>`).join("") || `<span class="muted">Других пользователей нет</span>`}</div>`:""}
    <label class="chk"><input type="checkbox" ${w.closed?"checked":""} onchange="WE.closed=this.checked;if(this.checked&&!WE.closedFrom)WE.closedFrom=CUR.date;refreshModal()"> Закрыт</label>
    ${w.closed?`<label class="fld" style="margin-left:22px;max-width:220px"><span>Закрыт с даты</span><input type="date" value="${w.closedFrom}" onchange="WE.closedFrom=this.value;refreshModal()"></label>`:""}
  </div>
  ${bal.length?`<fieldset style="margin-top:12px"><legend>Остаток на ${fmtD(w.closedFrom)} — перенос при закрытии (ТР-25)</legend>
    <table><tbody>${bal.map(r=>`<tr><td>${esc(nm(acc(r.acc)))}</td><td class="num ${r.sum<0?"neg":""}">${fmt(r.sum)} ${esc(curCode(r.cur))}</td></tr>`).join("")}</tbody></table>
    <div class="row" style="margin-top:8px"><select onchange="WE._target=this.value">${optsWallets(WE._target,w.closedFrom,{empty:"— куда перенести —",filter:x=>x.id!==w.id})}</select>
      <button class="btn" onclick="transferOnClose()">Обнулить остаток операциями «Дивиденды односторонние»</button></div>
    ${bal.some(r=>r.sum<0)?`<p class="muted">Отрицательный остаток закроется встречной операцией: выбранный кошелёк покроет минус на том же счёте.</p>`:""}</fieldset>`:""}`;
}
async function saveWallet(){
  const w = WE; w.name = (w.name||"").trim();
  if(!w.name){ w._err = "Укажите наименование"; refreshModal(); return; }
  if(w.closed && !w.closedFrom){ w._err = "Укажите дату закрытия"; refreshModal(); return; }
  const payload = {id: wal(w.id) ? w.id : "", name:w.name, parent:w.parent||"", head:!!w.head, hidden:!!w.hidden, access:w.access||[], closed:!!w.closed, closedFrom:w.closedFrom||""};
  const r = await mutate("/api/wallets", {wallet:payload});
  if(!r.ok){ w._err = r.errors.join("; "); refreshModal(); return; }
  closeModal();
}
async function transferOnClose(){
  const w = WE; const t = w._target; if(!t){ alert("Выберите кошелёк, куда перенести остаток"); return; }
  const pe = periodError(w.closedFrom); if(pe){ alert(pe); return; }
  const r = await mutate(`/api/wallets/${encodeURIComponent(w.id)}/close`, {target:t, date:w.closedFrom});
  if(!r.ok) return showErrors(r);
  closeModal(); alert(`Создано операций: ${r.result.created}`);
}
/* ============================================================
   18. ПРАВИЛА АВТОЗАПОЛНЕНИЯ (ТР-73)
   ============================================================ */
let RE = null; let RT = {org:"",acc:"",dept:"",cf:"",zone:"",cpty:"",date:""};
function condText(c){
  const f = RULE_FIELDS[c.field]; if(!f) return "?";
  const vals = f.text ? (c.values||[]).join("; ") : (c.values||[]).map(v=>nm(byId(f.list(),v))||v).join(", ");
  return `${f.name} ${RULE_OPS[c.op].toLowerCase()} ${vals||"—"}`;
}
/** Условие для экрана: значения отдельным элементом — чтобы переводился только текст интерфейса */
function condHtml(c){
  const f = RULE_FIELDS[c.field]; if(!f) return "?";
  const vals = f.text ? (c.values||[]).join("; ") : (c.values||[]).map(v=>nm(byId(f.list(),v))||v).join(", ");
  return `${esc(f.name)} ${esc(RULE_OPS[c.op].toLowerCase())} <b class="notr">${esc(vals||"—")}</b>`;
}
function viewRules(){
  const m = matchRule(RT, RT.date||CUR.date);
  return `<h1>Правила автозаполнения кошелька <span class="tzref">ТР-73</span></h1>
  <p class="lede">Администратор настраивает правила без изменения кода. Правила проверяются сверху вниз, срабатывает первое подходящее. Применяются при загрузке файла, ручном вводе и по кнопке «Применить правила» для строк без кошелька. Где правило не сработало, строка попадает в «Без кошелька».</p>
  <div class="panel"><header><h2>${DB.rules.length} правил</h2><div style="flex:1"></div>
    <button class="btn" onclick="rulesToEmpty()">Применить правила к строкам без кошелька</button><button class="btn primary" onclick="openRule(null)">Добавить правило</button></header>
  <div class="body flush"><table><thead><tr><th style="width:36px">№</th><th>Описание</th><th>Условия (все должны выполниться)</th><th>Целевой кошелёк</th><th>Вкл.</th><th></th></tr></thead>
  <tbody>${DB.rules.map((r,i)=>`<tr class="${r.active?"":"excl"}"><td>${i+1}</td><td>${esc(r.name)}</td><td style="font-size:11.5px">${(r.conds||[]).map(c=>condHtml(c)).join("<br>")||`<span class="tag warn">без условий — срабатывает всегда</span>`}</td>
    <td>${esc(nm(wal(r.wallet)))}${walletClosedAt(r.wallet,CUR.date)?` <span class="tag off">закрыт</span>`:""}</td>
    <td><input type="checkbox" ${r.active?"checked":""} onchange="toggleRule('${r.id}',this.checked)" aria-label="Включено"></td>
    <td class="num" style="white-space:nowrap"><button class="btn sm" ${i?"":"disabled"} onclick="moveRule(${i},-1)" aria-label="Выше">↑</button><button class="btn sm" ${i<DB.rules.length-1?"":"disabled"} onclick="moveRule(${i},1)" aria-label="Ниже">↓</button>
      <button class="btn sm" onclick="openRule('${r.id}')">Изменить</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">Правил нет</td></tr>`}</tbody></table></div></div>
  <div class="panel"><header><h2>Проверка правил</h2><span class="hint">введите условия — увидите, какое правило сработает</span></header><div class="body">
    <div class="filters">
      <label class="fld"><span>Организация</span><select onchange="RT.org=this.value;RT.acc='';render()">${opts(DB.orgs,RT.org,{empty:"—"})}</select></label>
      <label class="fld"><span>Счёт или касса</span><select onchange="RT.acc=this.value;render()">${optsAccounts(RT.org,RT.acc,{empty:"—"})}</select></label>
      <label class="fld"><span>Подразделение</span><select onchange="RT.dept=this.value;render()">${optsTree(DB.depts,RT.dept,"—")}</select></label>
      <label class="fld"><span>Тип расхода CF</span><select onchange="RT.cf=this.value;render()">${opts(DB.cfTypes,RT.cf,{empty:"—"})}</select></label>
      <label class="fld"><span>Зона ответственности</span><select onchange="RT.zone=this.value;render()">${opts(DB.zones,RT.zone,{empty:"—"})}</select></label>
      <label class="fld"><span>Контрагент</span><input type="text" value="${esc(RT.cpty)}" onchange="RT.cpty=this.value;render()"></label>
      <label class="fld"><span>Дата</span><input type="date" value="${RT.date||CUR.date}" onchange="RT.date=this.value;render()"></label>
    </div>
    <div class="alert ${m.wallet?"ok":"warn"}" style="margin-top:12px">${m.wallet?`Сработает правило №${DB.rules.indexOf(m.rule)+1} «${esc(m.rule.name)}» → кошелёк <b>${esc(nm(wal(m.wallet)))}</b>`:"Ни одно правило не сработало — строка попадёт в «Без кошелька»"}</div>
    <table><thead><tr><th>№</th><th>Правило</th><th>Проверка условий</th><th>Итог</th></tr></thead><tbody>
    ${m.trace.map(t=>`<tr class="${t.ok?"":""}"><td>${DB.rules.indexOf(t.r)+1}</td><td>${esc(t.r.name)}</td><td style="font-size:11.5px">${(t.res||[]).map(x=>`${x.ok?"✓":"✗"} ${condHtml(x.c)}`).join("<br>")}</td>
      <td>${t.ok?`<span class="tag ok">сработало</span>`:`<span class="tag">${esc(t.why)}</span>`}</td></tr>`).join("")}
    ${DB.rules.length>m.trace.length?`<tr><td colspan="4" class="muted">Остальные правила не проверяются — сработало первое подходящее</td></tr>`:""}</tbody></table>
  </div></div>`;
}
async function toggleRule(id,on){ const r = await mutate(`/api/rules/${encodeURIComponent(id)}/toggle`, {on}); if(!r.ok){ showErrors(r); render(); } }
async function moveRule(i,d){ const ids = DB.rules.map(r=>r.id); const j = i+d; [ids[i],ids[j]] = [ids[j],ids[i]]; const r = await mutate("/api/rules/order", {ids}); if(!r.ok) showErrors(r); }
function openRule(id){
  RE = id ? clone(byId(DB.rules,id)) : {id:uid("R"), name:"", conds:[{field:"dept", op:"group", values:[]}], wallet:"", active:true};
  RE._err = null;
  openModal({title: id?"Правило автозаполнения":"Новое правило", width:900, body:ruleBody,
    footer:()=>`${id?`<span class="muted" style="margin-right:auto">Удаления нет — выключите правило (ТР-19)</span>`:""}<button class="btn" onclick="closeModal()">Отмена</button><button class="btn primary" onclick="saveRule()">Сохранить</button>`});
}
function ruleBody(){
  const r = RE;
  return `${r._err?`<div class="alert err">${esc(r._err)}</div>`:""}<div class="grid2">
    <label class="fld"><span>Описание <em>*</em></span><input type="text" value="${esc(r.name)}" onchange="RE.name=this.value"></label>
    <label class="fld"><span>Целевой кошелёк <em>*</em></span><select onchange="RE.wallet=this.value">${optsWallets(r.wallet,CUR.date,{empty:"— выберите —"})}</select></label>
  </div>
  <label class="chk" style="margin:10px 0"><input type="checkbox" ${r.active?"checked":""} onchange="RE.active=this.checked"> Включено</label>
  <fieldset><legend>Условия — все должны выполниться</legend>
  ${r.conds.map((c,i)=>{ const f = RULE_FIELDS[c.field];
    return `<div class="row" style="align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line-soft)">
      <select onchange="RE.conds[${i}]={field:this.value,op:'eq',values:[]};refreshModal()">${Object.entries(RULE_FIELDS).map(([k,x])=>`<option value="${k}" ${c.field===k?"selected":""}>${x.name}</option>`).join("")}</select>
      <select onchange="RE.conds[${i}].op=this.value;refreshModal()">${Object.entries(RULE_OPS).filter(([k])=>k!=="group"||f.tree).map(([k,t])=>`<option value="${k}" ${c.op===k?"selected":""}>${t}</option>`).join("")}</select>
      <div style="flex:1">${f.text ? `<input type="text" style="width:100%" value="${esc((c.values||[]).join("; "))}" placeholder="значения через ;" onchange="RE.conds[${i}].values=this.value.split(';').map(s=>s.trim()).filter(Boolean)">`
        : (c.op==="eq" ? `<select style="width:100%" onchange="RE.conds[${i}].values=this.value?[this.value]:[]">${f.tree?optsTree(f.list(),c.values[0],"— выберите —"):opts(f.list(),c.values[0],{empty:"— выберите —"})}</select>`
        : `<div class="msel">${(f.tree?tree(f.list()):f.list()).map(x=>`<label class="chk" style="padding-left:${(x._lvl||0)*14}px"><input type="checkbox" ${(c.values||[]).includes(x.id)?"checked":""} onchange="RE.conds[${i}].values=this.checked?[...new Set([...RE.conds[${i}].values,'${x.id}'])]:RE.conds[${i}].values.filter(v=>v!=='${x.id}')"> ${esc(x.name)}</label>`).join("") || `<span class="muted">Справочник пуст — загрузите из 1С</span>`}</div>`)}
        ${c.op==="group"?`<small class="muted">«В группе» — элемент и все его подчинённые</small>`:""}</div>
      <button class="btn sm" onclick="RE.conds.splice(${i},1);refreshModal()" aria-label="Удалить условие">✕</button></div>`; }).join("")}
  <button class="btn sm" style="margin-top:8px" onclick="RE.conds.push({field:'org',op:'eq',values:[]});refreshModal()">Добавить условие</button></fieldset>`;
}
async function saveRule(){
  const r = RE; r.name = (r.name||"").trim();
  if(!r.name){ r._err = "Укажите описание"; refreshModal(); return; }
  if(!r.wallet){ r._err = "Выберите целевой кошелёк"; refreshModal(); return; }
  if(r.conds.some(c=>!(c.values||[]).length)){ r._err = "В каждом условии нужно выбрать значение"; refreshModal(); return; }
  const res = await mutate("/api/rules", {rule:{id: byId(DB.rules,r.id) ? r.id : "", name:r.name, conds:r.conds, wallet:r.wallet, active:!!r.active}});
  if(!res.ok){ r._err = res.errors.join("; "); refreshModal(); return; }
  closeModal();
}
/* ============================================================
   19. ПОЛЬЗОВАТЕЛИ И ПРАВА (раздел 8)
   ============================================================ */
let UE = null;
const ROLE_DESC = {
  owner:["Все кошельки и операции, кроме скрытых без доступа","Только просмотр"],
  fcHead:["Свои кошельки и все подчинённые им","Только просмотр; внутренние операции вводит казначей"],
  treasurer:["Остатки и операции своих кошельков; названия всех активных нескрытых кошельков","Вводить и править внутренние операции и ручные документы по своим кошелькам в открытом периоде"],
  deptHead:["Свои кошельки и операции","Только просмотр"],
  admin:["Всё","Пользователи, права, кошельки, правила, входящие остатки, загрузка файлов, закрытие периода, журналы"],
};
function viewUsers(){
  return `<h1>Пользователи и права <span class="tzref">раздел 8</span></h1>
  <p class="lede">Пять ролей. Права выдаются на кошелёк и распространяются на подчинённые. У пользователя может быть несколько ролей и кошельков — права суммируются (ТР-34). Переключите пользователя в шапке, чтобы проверить, что он видит.</p>
  <div class="panel"><header><h2>${DB.users.length} пользователей</h2><div style="flex:1"></div><button class="btn primary" onclick="openUser(null)">Добавить пользователя</button></header>
  <div class="body flush"><table><thead><tr><th>Пользователь</th><th>Логин</th><th>Роли</th><th>Кошельки</th><th class="num">Видит кошельков</th><th>Статус</th><th></th></tr></thead>
  <tbody>${DB.users.map(u=>`<tr class="${u.active?"":"excl"}"><td>${esc(u.name)}${u.email?`<br><span class="muted">${esc(u.email)}</span>`:""}</td><td><code class="k">${esc(u.login)}</code>${u.hasPw?"":` <span class="tag warn">нет пароля</span>`}</td><td>${u.roles.map(r=>`<span class="tag">${esc(ROLES[r])}</span>`).join(" ")}</td>
    <td>${esc((u.wallets||[]).map(id=>nm(wal(id))).join(", "))}</td><td class="num">${visibleWallets(u).size}</td><td>${u.active?`<span class="tag ok">активен</span>`:`<span class="tag off">отключён</span>`}</td>
    <td class="num"><button class="btn sm" onclick="openUser('${u.id}')">Изменить</button></td></tr>`).join("")}</tbody></table></div></div>
  <div class="panel"><header><h2>Роли</h2></header><div class="body flush"><table><thead><tr><th>Роль</th><th>Видит</th><th>Может</th></tr></thead>
  <tbody>${Object.entries(ROLES).map(([k,n])=>`<tr><td><b>${esc(n)}</b></td><td>${esc(ROLE_DESC[k][0])}</td><td>${esc(ROLE_DESC[k][1])}</td></tr>`).join("")}</tbody></table></div></div>`;
}
function openUser(id){
  UE = id ? clone(usr(id)) : {id:uid("U"), name:"", login:"", email:"", roles:[], wallets:[], active:true, hasPw:false}; UE._err = null; UE._pw = "";
  openModal({title: id?`Пользователь «${esc(UE.name)}»`:"Новый пользователь", width:760, body:()=>`${UE._err?`<div class="alert err">${esc(UE._err)}</div>`:""}
    <div class="grid2"><label class="fld"><span>ФИО <em>*</em></span><input type="text" value="${esc(UE.name)}" onchange="UE.name=this.value"></label>
      <label class="fld"><span>Логин <em>*</em></span><input type="text" value="${esc(UE.login)}" onchange="UE.login=this.value"></label>
      <label class="fld"><span>E-mail для уведомлений</span><input type="text" value="${esc(UE.email||"")}" onchange="UE.email=this.value"></label>
      <label class="fld"><span>${UE.hasPw?"Новый пароль (оставьте пустым, чтобы не менять)":"Пароль <em>*</em>"}</span><input type="password" autocomplete="new-password" value="${esc(UE._pw)}" onchange="UE._pw=this.value"><small>Не короче 8 символов. Вход по логину и паролю (ТР-48)</small></label></div>
    <div class="split" style="margin-top:12px"><fieldset><legend>Роли</legend>${Object.entries(ROLES).map(([k,n])=>`<label class="chk"><input type="checkbox" ${UE.roles.includes(k)?"checked":""} onchange="UE.roles=this.checked?[...new Set([...UE.roles,'${k}'])]:UE.roles.filter(x=>x!=='${k}');refreshModal()"> ${esc(n)}</label>`).join("")}</fieldset>
      <fieldset><legend>Кошельки (с подчинёнными)</legend>${walletChecklist(UE.wallets,"ueW",{only:new Set(DB.wallets.map(w=>w.id))})}</fieldset></div>
    <label class="chk" style="margin-top:8px"><input type="checkbox" ${UE.active?"checked":""} onchange="UE.active=this.checked"> Активен</label>
    <p class="muted">Итого увидит кошельков: ${visibleWallets(Object.assign({},UE,{id:"__preview"+Math.random()})).size}</p>`,
    footer:()=>`<button class="btn" onclick="closeModal()">Отмена</button><button class="btn primary" onclick="saveUser()">Сохранить</button>`});
}
function ueW(id,on){ UE.wallets = on ? [...new Set([...UE.wallets,id])] : UE.wallets.filter(x=>x!==id); refreshModal(); }
async function saveUser(){
  const u = UE; u.name = (u.name||"").trim(); u.login = (u.login||"").trim();
  if(!u.name || !u.login){ u._err = "Укажите ФИО и логин"; refreshModal(); return; }
  if(!u.roles.length){ u._err = "Назначьте хотя бы одну роль"; refreshModal(); return; }
  if(!u.hasPw && !u._pw){ u._err = "Задайте пароль"; refreshModal(); return; }
  if(u._pw && u._pw.length < 8){ u._err = "Пароль — не короче 8 символов"; refreshModal(); return; }
  const payload = {id: usr(u.id) ? u.id : "", name:u.name, login:u.login, email:(u.email||"").trim(), roles:u.roles, wallets:u.wallets, active:!!u.active};
  const r = await mutate("/api/users", {user:payload, password:u._pw||""});
  if(!r.ok){ u._err = r.errors.join("; "); refreshModal(); return; }
  closeModal();
}
/* ============================================================
   20. СПРАВОЧНИКИ 1С — только просмотр (ТР-01, МД-06)
   ============================================================ */
let REFT = "orgs", RATECUR = "";
function viewRefs(){
  const tabs = [["orgs","Организации",DB.orgs.length],["accounts","Банковские счета",DB.accounts.length],["cashboxes","Кассы",DB.cashboxes.length],["currencies","Валюты",DB.currencies.length],["rates","Курсы к USD",DB.rates.length],["cfTypes","Типы расхода CF",DB.cfTypes.length],["depts","Подразделения",DB.depts.length],["zones","Зоны ответственности",DB.zones.length]];
  const deact = x => x.deactivated ? `<span class="tag off">с ${fmtD(x.deactivated)}</span>` : "";
  let t = "";
  if(REFT==="rates"){
    const list = DB.rates.filter(r=>!RATECUR||r.cur===RATECUR).sort((a,b)=>a.date<b.date?1:-1).slice(0,1000);
    t = `<div class="body filters"><label class="fld"><span>Валюта</span><select onchange="RATECUR=this.value;render()">${opts(DB.currencies,RATECUR,{empty:"Все"})}</select></label>
      <span class="muted">Курс — в форме котировки: единиц валюты за 1 USD. USD = ÷ курс, округляется только итог. Контроль: 50 000 000 AED ÷ 3,6725 = ${fmt(toUSD(50000000,"__",null,3.6725))} USD (ТР-32).</span></div>
      <table id="tRef"><thead><tr><th>Валюта</th><th>Дата</th><th class="num">Единиц за 1 USD</th><th class="num">USD за 1 единицу</th></tr></thead><tbody>${list.map(r=>`<tr><td>${esc(curCode(r.cur))}</td><td>${fmtD(r.date)}</td><td class="num">${fmtRate(r.rate)}</td><td class="num muted">${fmtRate(1/r.rate)}</td></tr>`).join("")||`<tr><td colspan="4" class="muted">Курсов нет</td></tr>`}</tbody></table>`;
  } else {
    const cols = {orgs:[["Наименование",x=>esc(x.name)]], accounts:[["Наименование",x=>esc(x.name)],["Организация",x=>esc(nm(org(x.org)))],["Валюта",x=>esc(curCode(x.cur))],["Банк",x=>esc(x.bank||"")],["Вид",x=>esc(x.accType||"")]],
      cashboxes:[["Наименование",x=>esc(x.name)],["Организация",x=>esc(nm(org(x.org)))],["Валюта",x=>esc(curCode(x.cur))]], currencies:[["Наименование",x=>esc(x.name)],["Код",x=>esc(x.code||"")]],
      cfTypes:[["Наименование",x=>esc(x.name)]], depts:[["Наименование",x=>`<span class="tree-pad" style="width:${(x._lvl||0)*16}px"></span>${esc(x.name)}`]], zones:[["Наименование",x=>esc(x.name)]]}[REFT];
    const list = REFT==="depts" ? tree(DB.depts) : DB[REFT];
    t = `<table id="tRef"><thead><tr><th>Идентификатор ERP</th>${cols.map(c=>`<th>${c[0]}</th>`).join("")}<th>Деактивирован</th></tr></thead>
      <tbody>${list.map(x=>`<tr><td><code class="k">${esc(x.id)}</code></td>${cols.map(c=>`<td>${c[1](x)}</td>`).join("")}<td>${deact(x)}</td></tr>`).join("") || `<tr><td colspan="${cols.length+2}" class="muted">Пусто — загрузите из 1С</td></tr>`}</tbody></table>`;
  }
  return `<h1>Справочники 1С</h1>
  <p class="lede">Мастер-система — 1С ERP. Справочники идентичны ERP и сопоставляются по идентификаторам, в приложении только просмотр; ручного заведения нет, чтобы не было второго источника данных (ТР-01, ТР-64).</p>
  <div class="tabs">${tabs.map(([k,n,c])=>`<a class="${REFT===k?"on":""}" onclick="REFT='${k}';render()">${n} <span class="muted">${c}</span></a>`).join("")}</div>
  <div class="panel"><header><div style="flex:1"></div><button class="btn" onclick="IMP={tab:'ref',fileName:'',sheets:null,err:null,sel:null,pv:null,logged:false,refKind:''};go('import')">Загрузить из файла</button>${exportBtn("tRef","Справочник")}</header>
  <div class="body flush"><div class="tbl-wrap">${t}</div></div></div>`;
}

/* ============================================================
   21. ПЕРИОД И НАСТРОЙКИ
   ============================================================ */
async function setSetting(k, v, label){
  const before = DB.settings[k]; if(before===v) return;
  if(k==="startDate" && DB.opening.length && !confirm("Входящие остатки уже введены. Сменить дату начала учёта?")){ render(); return; }
  if(k==="closedTo" && before && v < before && !confirm(`Открыть период после ${fmtD(v||"")}? Действие попадёт в журнал аудита.`)){ render(); return; }
  if(k==="switchDate" && v && !confirm(`С ${fmtD(v)} ручной ввод поступлений, конвертаций и перебросок отключится, а ручные документы с этой даты будут исключены и заменены документами из 1С (ТР-72). Продолжить?`)){ render(); return; }
  const r = await mutate("/api/settings", {key:k, value:v});
  if(!r.ok){ showErrors(r); render(); }
}
async function closeMonth(){
  const d = new Date(todayISO()+"T00:00:00Z"); d.setUTCDate(1); d.setUTCDate(0); const end = d.toISOString().slice(0,10);
  if(DB.settings.closedTo && DB.settings.closedTo >= end){ alert(`Период по ${fmtD(DB.settings.closedTo)} уже закрыт`); return; }
  if(!confirm(`Закрыть период по ${fmtD(end)}? После этого нельзя создавать, менять и помечать на удаление внутренние операции, ручные документы и входящие остатки с датой до ${fmtD(end)} включительно.`)) return;
  showErrors(await mutate("/api/settings/close-month"));
}
function exportBackup(){ window.location.href = "/api/admin/backup"; }
async function importBackup(input){
  const f = input.files[0]; if(!f) return;
  let d; try{ d = JSON.parse(await f.text()); }catch(e){ alert("Не удалось прочитать файл: "+e.message); return; }
  if(!confirm("Заменить все данные содержимым файла? Журнал аудита сохранится.")) return;
  const r = await mutate("/api/admin/restore", Object.assign({}, d, {fileName:f.name}));
  if(!r.ok) return showErrors(r);
  VIEW = "dash"; render();
}
async function resetAll(){
  if(!confirm("Удалить все данные: справочники, кошельки, документы, операции, журнал обмена, пользователей (кроме вас)? Журнал аудита сохранится (ТР-46).")) return;
  const r = await mutate("/api/admin/reset");
  if(!r.ok) return showErrors(r);
  VIEW = "dash"; render();
}
function viewSettings(){
  const S = DB.settings;
  const prevEnd = (()=>{ const d = new Date(CUR.date+"T00:00:00Z"); d.setUTCDate(1); d.setUTCDate(0); return d.toISOString().slice(0,10); })();
  const due = new Date(CUR.date+"T00:00:00Z").getUTCDate() >= 5 && (!S.closedTo || S.closedTo < prevEnd);
  return `<h1>Период и настройки</h1>
  <div class="split">
    <div class="panel"><header><h2>Начало учёта по кошелькам</h2><span class="tzref">ТР-20</span></header><div class="body stack">
      <input type="date" value="${S.startDate}" onchange="setSetting('startDate',this.value,'Дата начала учёта')" style="max-width:200px">
      <span class="muted">На эту дату вводятся входящие остатки. Документы раньше этой даты не участвуют в расчёте.</span></div></div>
    <div class="panel"><header><h2>Закрытие периода</h2><span class="tzref">ТР-55</span></header><div class="body stack">
      <span>Закрыт по: <b>${S.closedTo?fmtD(S.closedTo):"не закрывался"}</b></span>
      ${due?`<div class="alert warn">После 5 числа предыдущий месяц нужно закрыть.</div>`:""}
      <div class="row"><button class="btn primary" onclick="closeMonth()">Закрыть по ${fmtD(prevEnd)}</button>
        <label class="fld"><span>или указать дату</span><input type="date" value="${S.closedTo}" onchange="setSetting('closedTo',this.value,'Закрытие периода')"></label></div>
      <label class="chk"><input type="checkbox" ${S.autoClose?"checked":""} onchange="setSetting('autoClose',this.checked,'Автозакрытие периода')"> Закрывать предыдущий месяц автоматически 5-го числа (после ввода входящих остатков)</label>
      <span class="muted">В закрытом периоде нельзя создавать, менять и помечать на удаление внутренние операции, ручные документы и входящие остатки. Изменения 1С принимаются и попадают в отдельный список (ТР-56).</span></div></div>
    <div class="panel"><header><h2>Переход на автообмен с 1С</h2><span class="tzref">ТР-72</span></header><div class="body stack">
      <input type="date" value="${S.switchDate}" onchange="setSetting('switchDate',this.value,'Дата перехода на автообмен')" style="max-width:200px">
      <span class="muted">С этой даты ручной ввод поступлений, конвертаций и перебросок отключается; ручные документы с датой не раньше даты перехода исключаются и заменяются документами из 1С. Ручные документы до этой даты остаются в учёте.</span></div></div>
    <div class="panel"><header><h2>Защита от двойного учёта</h2><span class="tzref">ТР-70</span></header><div class="body stack">
      <span class="muted">Строки СБДС и РКО с этими хозяйственными операциями пропускаются при загрузке файла — они уже введены вручную. По одной на строку. Точный список — открытый вопрос ТЗ.</span>
      <textarea rows="5" onchange="setSetting('excludedOps',this.value.split('\\n').map(x=>x.trim()).filter(Boolean),'Изменение списка исключаемых операций')">${esc(S.excludedOps.join("\n"))}</textarea></div></div>
  </div>
  <div class="panel"><header><h2>Данные прототипа</h2></header><div class="body row">
    <button class="btn" onclick="exportBackup()">Сохранить резервную копию (.json)</button>
    <label class="btn">Восстановить из копии<input type="file" accept=".json" style="display:none" onchange="importBackup(this)"></label>
    <div style="flex:1"></div><button class="btn danger" onclick="resetAll()">Удалить все данные (журнал аудита сохранится)</button></div>
    <div class="body" style="padding-top:0"><span class="muted">Данные хранятся на сервере в базе SQLite. Резервную копию базы делает ИТ (ТР-51); здесь можно выгрузить и восстановить данные целиком.</span></div></div>`;
}

/* ============================================================
   22. ЖУРНАЛ АУДИТА (ТР-44…47)
   ============================================================ */
const AF = {u:"", q:"", from:"", to:""};
let AUD = null, AUD_KEY = "";
async function loadAudit(){
  const q = new URLSearchParams({user:AF.u, q:AF.q, from:AF.from, to:AF.to}).toString();
  const r = await apiRaw("/api/audit?" + q);
  AUD = r.ok ? r.rows : []; AUD_KEY = q; render();
}
function viewAudit(){
  const q = new URLSearchParams({user:AF.u, q:AF.q, from:AF.from, to:AF.to}).toString();
  if(AUD===null || AUD_KEY!==q){ AUD_KEY = q; setTimeout(loadAudit, 0); }
  const list = AUD || [];
  return `<h1>Журнал аудита <span class="tzref">ТР-44…47</span></h1>
  <p class="lede">Вход и выход, просмотр отчётов с фильтрами, выгрузки в Excel, создание, изменение и пометка на удаление ручных документов и внутренних операций (было/стало), загрузки файлов, входящие остатки, пользователи, роли, кошельки, правила, закрытие периода. Журнал нельзя изменить или удалить из интерфейса, в том числе администратору. Хранится 13 месяцев.</p>
  <div class="panel"><div class="body filters">
    <label class="fld"><span>Пользователь</span><select onchange="AF.u=this.value;render()">${opts(DB.users,AF.u,{empty:"Все"})}</select></label>
    <label class="fld"><span>С</span><input type="date" value="${AF.from}" onchange="AF.from=this.value;render()"></label>
    <label class="fld"><span>По</span><input type="date" value="${AF.to}" onchange="AF.to=this.value;render()"></label>
    <label class="fld"><span>Поиск</span><input type="text" value="${esc(AF.q)}" onchange="AF.q=this.value;render()"></label>
    <div style="flex:1"></div><button class="btn" onclick="AUD=null;render()">Обновить</button>${exportBtn("tAud","Журнал аудита")}</div></div>
  <div class="panel"><div class="body flush"><div class="tbl-wrap"><table id="tAud"><thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Объект</th><th>Подробности</th></tr></thead>
  <tbody>${AUD===null?`<tr><td colspan="5" class="muted">Загрузка…</td></tr>`:list.map(a=>`<tr><td style="white-space:nowrap">${fmtDT(a.t)}</td><td class="notr">${esc(a.uname)}</td><td>${esc(a.action)}</td><td class="notr">${esc(a.object)}</td><td class="notr" style="font-size:11px;max-width:520px">${esc(a.details)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Записей нет</td></tr>`}</tbody></table></div></div></div>`;
}
/* ============================================================
   23. РАССЫЛКА УВЕДОМЛЕНИЙ (ТР-18, ТР-24, ТР-42, ТР-56, ТР-57)
   ============================================================ */
function mailText(u){
  const nf = notifications(u);
  return `Здравствуйте, ${u.name}!\n\nУведомления системы «Остатки по кошелькам» на ${fmtD(CUR.date)}:\n\n` + nf.map(n=>`• ${n.text} (${n.tr})`).join("\n") + `\n`;
}
function downloadMail(uid_){
  const u = usr(uid_); const body = mailText(u);
  const eml = `To: ${u.email}\r\nSubject: =?UTF-8?B?${btoa(unescape(encodeURIComponent("Остатки по кошелькам: уведомления на "+fmtD(CUR.date))))}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`;
  downloadBlob(new Blob([eml],{type:"message/rfc822"}), `Уведомления ${u.login} ${CUR.date}.eml`);
  audit("Формирование письма с уведомлениями", u.name, `${notifications(u).length} уведомлений`);
}
function viewMail(){
  const users = DB.users.filter(u=>u.active).map(u=>({u, nf:notifications(u)}));
  return `<h1>Рассылка уведомлений</h1>
  <p class="lede">Кому и что уходит: отрицательный остаток — казначею кошелька и администратору (ТР-24), расхождение сверки — казначеям кошельков на счёте и администратору (ТР-42), «Требует оформления» — казначеям обоих кошельков (ТР-57), изменения в закрытом периоде (ТР-56), два неудачных обмена подряд — администратору (ТР-18). Сервер отправляет письма каждый день в конце дня, если настроена почта (SMTP); письмо можно также скачать (.eml) и открыть в почте.</p>
  ${DB.mailConfigured?`<div class="row" style="margin-bottom:12px"><button class="btn primary" onclick="sendMailNow()">Отправить письма сейчас</button></div>`:`<div class="alert warn">Почта на сервере не настроена — задайте SMTP_HOST и SMTP_FROM (см. README). Пока можно скачать письмо .eml.</div>`}
  <div class="panel"><div class="body flush"><table><thead><tr><th>Пользователь</th><th>E-mail</th><th class="num">Уведомлений</th><th>Содержание</th><th></th></tr></thead>
  <tbody>${users.map(({u,nf})=>`<tr><td>${esc(u.name)}<br><span class="muted">${esc(roleNames(u))}</span></td><td>${u.email?esc(u.email):`<span class="tag warn">не указан</span>`}</td>
    <td class="num">${nf.length}</td><td style="font-size:11.5px">${nf.map(n=>`${esc(n.text)} <span class="tzref">${n.tr}</span>`).join("<br>") || `<span class="muted">нет</span>`}</td>
    <td>${nf.length&&u.email?`<button class="btn sm" onclick="downloadMail('${u.id}')">Письмо .eml</button>`:""}</td></tr>`).join("")}</tbody></table></div></div>`;
}

async function sendMailNow(){
  busy(true); try{ const r = await apiRaw("/api/mail/send", {}); if(!r.ok) return showErrors(r); alert(`Отправлено писем: ${r.sent}`); } finally{ busy(false); }
}

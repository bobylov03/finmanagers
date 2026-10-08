"use strict";
/* ============================================================
   1. УТИЛИТЫ
   ============================================================ */
const uid = p => (p||"id") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const jsq = s => String(s ?? "").replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,"&quot;");
const clone = o => JSON.parse(JSON.stringify(o));
const todayISO = () => { const d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); };

/** Округление до центов — только итоговых сумм (ТР-32) */
function r2(x){ if(!isFinite(x)) return x; const s = x<0?-1:1; return s*Math.round(Math.abs(x)*100 + 1e-7)/100; }

/** 13 614 703,88 — разделение разрядов пробелом, запятая (МД-10) */
function fmt(n, dec=2){
  if(n===null || n===undefined || n==="" || !isFinite(n)) return "—";
  const neg = n < 0 || Object.is(n,-0) && false;
  const a = Math.abs(dec===2 ? r2(n) : n);
  let [i,d] = a.toFixed(dec).split(".");
  i = i.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const s = d ? i + "," + d : i;
  return (neg && a!==0 ? "−" : "") + s;
}
/** Со знаком: поступления «+», расходы «−» (МД-18) */
function fmtS(n, dec=2){ if(!isFinite(n)) return "—"; if(Math.abs(n)<0.005) return fmt(0,dec); return (n>0?"+":"") + fmt(n,dec); }
/** Курс: до 6 знаков, без лишних нулей */
function fmtRate(x){ if(!isFinite(x)) return "—"; let s = fmt(x,6); if(s.includes(",")) s = s.replace(/0+$/,"").replace(/,$/,""); return s; }
/** Значение для поля ввода (обычный пробел, чтобы парсилось) */
function fmtIn(n, dec=2){ if(n===null || n===undefined || n==="" || !isFinite(n)) return ""; return fmt(n,dec).replace(/\u00a0/g," ").replace("−","-"); }
function parseNum(v){
  if(typeof v === "number") return v;
  if(v===null || v===undefined) return NaN;
  let s = String(v).trim().replace(/[\s\u00a0\u202f']/g,"").replace("−","-");
  if(!s) return NaN;
  if(s.includes(",") && s.includes(".")){
    if(s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g,"").replace(",",".");
    else s = s.replace(/,/g,"");
  } else s = s.replace(",",".");
  if(!/^-?\d*\.?\d+$/.test(s) && !/^-?\d+\.?$/.test(s)) return NaN;
  return Number(s);
}
function fmtD(iso){ if(!iso) return "—"; const [y,m,d] = String(iso).slice(0,10).split("-"); return d ? `${d}.${m}.${y}` : iso; }
function fmtDT(iso){ if(!iso) return "—"; const d = new Date(iso); return d.toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}); }
/** Дата из файла: ISO, дд.мм.гггг, серийный номер Excel, объект Date */
function parseDate(v){
  if(v===null || v===undefined || v==="") return null;
  if(v instanceof Date && !isNaN(v)) return v.toISOString().slice(0,10);
  if(typeof v === "number" && v > 20000 && v < 80000){
    const d = new Date(Date.UTC(1899,11,30) + Math.round(v)*86400000); return d.toISOString().slice(0,10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if(m){ let y = m[3]; if(y.length===2) y = "20"+y; return `${y}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`; }
  const n = parseNum(s); if(isFinite(n)) return parseDate(n);
  return null;
}
function addDays(iso, n){ const d = new Date(iso+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function monthEnd(iso){ const d = new Date(iso.slice(0,7)+"-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth()+1); d.setUTCDate(0); return d.toISOString().slice(0,10); }
const norm = s => String(s ?? "").toLowerCase().replace(/ё/g,"е").replace(/[\s_\-.,«»"()/]/g,"");

/* ============================================================
   2. XLSX / ZIP / CSV — без внешних библиотек
   ============================================================ */
const CRC_T = (()=>{ const t = new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1; t[n]=c>>>0; } return t; })();
function crc32(u8){ let c = 0xFFFFFFFF; for(let i=0;i<u8.length;i++) c = CRC_T[(c^u8[i])&255] ^ (c>>>8); return (c^0xFFFFFFFF)>>>0; }
function zipStore(files){ // files: [{name, data:string}]
  const enc = new TextEncoder(); const parts=[]; const central=[]; let off=0;
  for(const f of files){
    const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0,0x04034b50,true); lh.setUint16(4,20,true); lh.setUint16(6,0x0800,true); lh.setUint16(8,0,true);
    lh.setUint16(10,0,true); lh.setUint16(12,0x21,true); lh.setUint32(14,crc,true); lh.setUint32(18,data.length,true);
    lh.setUint32(22,data.length,true); lh.setUint16(26,name.length,true); lh.setUint16(28,0,true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0,0x02014b50,true); ch.setUint16(4,20,true); ch.setUint16(6,20,true); ch.setUint16(8,0x0800,true);
    ch.setUint16(10,0,true); ch.setUint16(12,0,true); ch.setUint16(14,0x21,true); ch.setUint32(16,crc,true);
    ch.setUint32(20,data.length,true); ch.setUint32(24,data.length,true); ch.setUint16(28,name.length,true);
    ch.setUint32(42,off,true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s,a)=>s+a.length,0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0,0x06054b50,true); e.setUint16(8,files.length,true); e.setUint16(10,files.length,true);
  e.setUint32(12,cdSize,true); e.setUint32(16,off,true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
function colL(i){ let s=""; i++; while(i>0){ const m=(i-1)%26; s=String.fromCharCode(65+m)+s; i=Math.floor((i-1)/26); } return s; }
const xmlE = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"");
/** sheets: [{name, rows:[[cell]]}] — cell: string | number | {v, bold, dec} ; первая строка — заголовок (жирный) */
function xlsxBlob(sheets){
  const files = [];
  files.push({name:"[Content_Types].xml", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`});
  files.push({name:"_rels/.rels", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`});
  files.push({name:"xl/workbook.xml", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${xmlE(String(s.name).replace(/[\\\/?*\[\]:]/g," ").slice(0,31))}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("")}</sheets></workbook>`});
  files.push({name:"xl/_rels/workbook.xml.rels", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`});
  files.push({name:"xl/styles.xml", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.000000"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`});
  sheets.forEach((sh,si)=>{
    const rowsXml = sh.rows.map((row,ri)=>`<row r="${ri+1}">${row.map((cell,ci)=>{
      if(cell===null || cell===undefined || cell==="") return "";
      const o = (typeof cell === "object") ? cell : {v:cell};
      const bold = o.bold || ri===0;
      const ref = colL(ci)+(ri+1);
      if(typeof o.v === "number" && isFinite(o.v)) return `<c r="${ref}" s="${o.dec===6?4:(bold?3:2)}"><v>${o.v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${bold?' s="1"':""}><is><t xml:space="preserve">${xmlE(o.v)}</t></is></c>`;
    }).join("")}</row>`).join("");
    const widths = (sh.rows[0]||[]).map((_,ci)=>{ let w = 8; sh.rows.slice(0,200).forEach(r=>{ const c=r[ci]; const v = c&&typeof c==="object"?c.v:c; w = Math.max(w, String(v??"").length+2); }); return `<col min="${ci+1}" max="${ci+1}" width="${Math.min(w,60)}" customWidth="1"/>`; }).join("");
    files.push({name:`xl/worksheets/sheet${si+1}.xml`, data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${widths?`<cols>${widths}</cols>`:""}<sheetData>${rowsXml}</sheetData></worksheet>`});
  });
  return zipStore(files);
}
function downloadBlob(blob, name){
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
async function unzip(buf){
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = -1; for(let i=u8.length-22;i>=Math.max(0,u8.length-66000);i--){ if(dv.getUint32(i,true)===0x06054b50){ e=i; break; } }
  if(e<0) throw new Error("Файл не является книгой Excel (.xlsx)");
  const cnt = dv.getUint16(e+10,true); let p = dv.getUint32(e+16,true);
  const out = {}; const dec = new TextDecoder();
  for(let k=0;k<cnt;k++){
    const method = dv.getUint16(p+10,true), csize = dv.getUint32(p+20,true);
    const nlen = dv.getUint16(p+28,true), xlen = dv.getUint16(p+30,true), clen = dv.getUint16(p+32,true), loff = dv.getUint32(p+42,true);
    const name = dec.decode(u8.subarray(p+46,p+46+nlen));
    p += 46+nlen+xlen+clen;
    const ln = dv.getUint16(loff+26,true), lx = dv.getUint16(loff+28,true);
    const data = u8.subarray(loff+30+ln+lx, loff+30+ln+lx+csize);
    out[name] = {method, data};
  }
  return {
    async text(name){
      const f = out[name]; if(!f) return null;
      if(f.method===0) return dec.decode(f.data);
      if(typeof DecompressionStream === "undefined") throw new Error("Браузер не умеет распаковывать .xlsx — сохраните файл как CSV");
      const ds = new Blob([f.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return dec.decode(await new Response(ds).arrayBuffer());
    }, names:Object.keys(out)
  };
}
async function readXlsx(buf){
  const z = await unzip(buf); const P = new DOMParser();
  const xml = async n => { const t = await z.text(n); return t ? P.parseFromString(t,"application/xml") : null; };
  const wb = await xml("xl/workbook.xml"); if(!wb) throw new Error("В файле нет листов Excel");
  const rels = await xml("xl/_rels/workbook.xml.rels"); const relMap = {};
  if(rels) [...rels.getElementsByTagName("Relationship")].forEach(r=>relMap[r.getAttribute("Id")] = r.getAttribute("Target"));
  const ssDoc = await xml("xl/sharedStrings.xml"); const ss = [];
  if(ssDoc) [...ssDoc.getElementsByTagName("si")].forEach(si=>ss.push([...si.getElementsByTagName("t")].map(t=>t.textContent).join("")));
  // стили дат
  const stDoc = await xml("xl/styles.xml"); const dateXf = new Set();
  if(stDoc){
    const custom = {}; [...stDoc.getElementsByTagName("numFmt")].forEach(n=>custom[n.getAttribute("numFmtId")] = n.getAttribute("formatCode"));
    const xfs = stDoc.getElementsByTagName("cellXfs")[0];
    if(xfs) [...xfs.getElementsByTagName("xf")].forEach((x,i)=>{
      const id = +x.getAttribute("numFmtId"); const code = custom[id]||"";
      if((id>=14 && id<=22) || (id>=45&&id<=47) || /[dmy]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"/g,""))) dateXf.add(i);
    });
  }
  const sheets = [];
  for(const s of [...wb.getElementsByTagName("sheet")]){
    const rid = s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships","id");
    let target = relMap[rid] || ""; target = target.startsWith("/") ? target.slice(1) : "xl/"+target.replace(/^\.\//,"");
    const doc = await xml(target); if(!doc) continue;
    const rows = [];
    [...doc.getElementsByTagName("row")].forEach(r=>{
      const ri = (+r.getAttribute("r")||rows.length+1)-1; const arr = [];
      [...r.getElementsByTagName("c")].forEach((c,k)=>{
        const ref = c.getAttribute("r"); let ci = k;
        if(ref){ const L = ref.replace(/\d+/g,""); ci = [...L].reduce((a,ch)=>a*26+ch.charCodeAt(0)-64,0)-1; }
        const t = c.getAttribute("t"), sIdx = +c.getAttribute("s"); const vEl = c.getElementsByTagName("v")[0];
        let v = vEl ? vEl.textContent : null;
        if(t==="s") v = ss[+v]; else if(t==="inlineStr") v = [...c.getElementsByTagName("t")].map(x=>x.textContent).join("");
        else if(t==="b") v = v==="1"; else if(t==="str" || t==="e") v = v; else if(v!==null){ v = Number(v); if(dateXf.has(sIdx)) v = parseDate(v); }
        arr[ci] = v;
      });
      rows[ri] = arr;
    });
    sheets.push({name:s.getAttribute("name"), rows:[...rows].map(r=>r||[])});
  }
  return sheets;
}
function parseCSV(text){
  text = text.replace(/^\ufeff/,"");
  const first = text.split(/\r?\n/)[0]||""; const cnt = ch => first.split(ch).length;
  const del = [";","\t",","].sort((a,b)=>cnt(b)-cnt(a))[0];
  const rows=[]; let row=[], cur="", q=false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){ cur+='"'; i++; } else q=false; } else cur+=c; }
    else if(c==='"') q=true;
    else if(c===del){ row.push(cur); cur=""; }
    else if(c==="\n"){ row.push(cur.replace(/\r$/,"")); rows.push(row); row=[]; cur=""; }
    else cur+=c;
  }
  if(cur!=="" || row.length){ row.push(cur.replace(/\r$/,"")); rows.push(row); }
  return rows;
}
async function readAnyFile(file){
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  if(u8[0]===0x50 && u8[1]===0x4b) return readXlsx(buf);
  if(/\.xls$/i.test(file.name)) throw new Error("Формат .xls не поддерживается — сохраните как .xlsx или .csv");
  let text; try{ text = new TextDecoder("utf-8",{fatal:true}).decode(u8); } catch(e){ text = new TextDecoder("windows-1251").decode(u8); }
  return [{name:file.name.replace(/\.[^.]+$/,""), rows:parseCSV(text)}];
}
/** Сопоставление колонок по заголовкам: spec = {key:[синонимы]} */
function mapHeader(rows, spec){
  let hi = rows.findIndex(r => r && r.some(c=>String(c??"").trim()!==""));
  if(hi<0) return {hi:-1, map:{}, missing:Object.keys(spec)};
  const head = rows[hi].map(norm); const map = {};
  for(const [k,al] of Object.entries(spec)){ const i = head.findIndex(h => al.some(a=>norm(a)===h)); if(i>=0) map[k]=i; }
  return {hi, map, missing:Object.keys(spec).filter(k=>!(k in map))};
}

/* ============================================================
   3. МОДЕЛЬ ДАННЫХ
   ============================================================ */
const ROLES = {
  owner:   "Собственник",
  fcHead:  "Руководитель финцентра",
  treasurer:"Казначей",
  deptHead:"Руководитель отдела",
  admin:   "Администратор",
};
const OP_KINDS = {
  loan:       {name:"Выдача займа",                 from:"Кошелёк-займодавец", to:"Кошелёк-заёмщик", debt:+1},
  repay:      {name:"Погашение займа",              from:"Кошелёк-заёмщик",    to:"Кошелёк-займодавец", debt:-1},
  funding:    {name:"Безвозмездное финансирование", from:"Головной кошелёк",   to:"Кошелёк"},
  dividends:  {name:"Дивиденды",                    from:"Кошелёк",            to:"Головной кошелёк"},
  closeDiv:   {name:"Дивиденды односторонние (перенос остатка при закрытии)", from:"Закрываемый кошелёк", to:"Выбранный кошелёк"},
  exchange:   {name:"Обмен между кошельками на двух счетах", from:"Кошелёк X", to:"Кошелёк Y"},
};
const DOC_TYPES = {
  СБДС:{name:"Списание безналичных ДС", sign:-1, cash:false, src:"file"},
  РКО: {name:"Расходный кассовый ордер", sign:-1, cash:true, src:"file"},
  ПБДС:{name:"Поступление на счёт",      sign:+1, cash:false, src:"manual"},
  ПКО: {name:"Поступление в кассу",      sign:+1, cash:true, src:"manual"},
  ПЕР: {name:"Конвертация / переброска", sign:0, src:"manual"},
};
const MANUAL_OPS = {
  ПБДС:["Прочее поступление","Оплата от клиента","Возврат от поставщика","Поступление по кредитам и займам","Возврат депозита"],
  ПКО: ["Прочее поступление","Оплата от клиента","Поступление наличных из банка","Возврат от подотчётника"],
  ПЕР: ["Конвертация валюты","Перечисление на другой счёт","Оплата в другую организацию группы","Инкассация"],
};
const STATUSES = ["Проведён","Не проведён","На согласовании","Помечен на удаление"];

function emptyDB(){
  return {
    ver:"1.3",
    orgs:[], accounts:[], cashboxes:[], currencies:[], rates:[], cfTypes:[], depts:[], zones:[],
    wallets:[], rules:[], contracts:[],
    users:[{id:"U_ADMIN", name:"Администратор", login:"admin", email:"", roles:["admin"], wallets:[], active:true, pw:null}],
    docs:[], ops:[], opening:[], bal1c:[], exchangeLog:[], audit:[], closedChanges:[],
    settings:{startDate:"", closedTo:"", switchDate:"", autoClose:true,
      excludedOps:["Конвертация валюты","Перечисление на другой счёт","Оплата в другую организацию группы","Инкассация"]},
    counters:{},
  };
}
let DB = null;
let CUR = {u:"U_ADMIN", date:todayISO()};

/* --- данные приходят с сервера (GET /api/state); изменения — через API --- */
let SAVE_ERR = "";
function save(){ inval(); }

/* --- справочники --- */
const byId = (arr,id) => id ? (arr.find(x=>x.id===id) || null) : null;
const org = id => byId(DB.orgs,id);
const cur = id => byId(DB.currencies,id);
const dept = id => byId(DB.depts,id);
const zone = id => byId(DB.zones,id);
const cfType = id => byId(DB.cfTypes,id);
const wal = id => byId(DB.wallets,id);
const usr = id => byId(DB.users,id);
const contract = id => byId(DB.contracts,id);
/** Счёт или касса */
function acc(id){ const a = byId(DB.accounts,id); if(a) return Object.assign({kind:"Счёт"},a); const k = byId(DB.cashboxes,id); return k ? Object.assign({kind:"Касса"},k) : null; }
const nm = x => x ? x.name : "—";
/** Имя по ссылке или «сырое» значение из файла, если справочника ещё нет (ТР-17) */
function refName(list, v){ if(!v) return ""; const x = byId(list, v); return x ? x.name : String(v).replace(/^\?/,"") + " (нет в справочнике)"; }
function curCode(id){ const c = cur(id); return c ? (c.code || c.name || c.id) : (id||""); }
const isUSD = id => String(curCode(id)).toUpperCase()==="USD" || String(id).toUpperCase()==="USD";
function isActiveAt(x, date){ return !(x && x.deactivated && date && date >= x.deactivated); }
/** Поиск элемента справочника по идентификатору ERP или наименованию */
function findRef(list, v){
  if(v===null || v===undefined || String(v).trim()==="") return null;
  const s = String(v).trim();
  return list.find(x=>x.id===s) || list.find(x=>norm(x.name)===norm(s)) || list.find(x=>x.code && norm(x.code)===norm(s)) || null;
}

/* --- курсы (ТР-32): хранятся как котируются — единиц валюты за 1 USD --- */
let RATE_IDX = null;
function rateIdx(){
  if(RATE_IDX) return RATE_IDX; RATE_IDX = {};
  DB.rates.forEach(r=>{ (RATE_IDX[r.cur] = RATE_IDX[r.cur] || []).push(r); });
  Object.values(RATE_IDX).forEach(a=>a.sort((x,y)=>x.date<y.date?-1:1));
  return RATE_IDX;
}
function rateAt(curId, date){
  if(isUSD(curId)) return 1;
  const a = rateIdx()[curId]; if(!a || !a.length) return null;
  let r = null; for(const x of a){ if(x.date <= date) r = x; else break; }
  return r ? r.rate : null;
}
/** Сумма в USD: делим на курс «единиц за 1 USD», округляем только итог (МД-17) */
function toUSD(sum, curId, date, rate){ const k = rate || rateAt(curId, date); if(!k) return NaN; return r2(sum / k); }

/* --- кошельки: иерархия --- */
function walletDepth(id){ let d=0, w=wal(id); while(w && w.parent){ d++; w = wal(w.parent); if(d>10) break; } return d; }
function descendants(id){ const out = new Set([id]); let grow=true; while(grow){ grow=false; DB.wallets.forEach(w=>{ if(w.parent && out.has(w.parent) && !out.has(w.id)){ out.add(w.id); grow=true; } }); } return out; }
function ancestors(id){ const out=[]; let w = wal(id); while(w){ out.push(w); w = wal(w.parent); if(out.length>10) break; } return out; }
function tree(arr, parent=null, lvl=0, out=[]){
  arr.filter(x=>(x.parent||null)===parent).sort((a,b)=>a.name.localeCompare(b.name,"ru")).forEach(x=>{ out.push(Object.assign({_lvl:lvl},x)); tree(arr,x.id,lvl+1,out); });
  if(parent===null){ // осиротевшие
    const ids = new Set(out.map(x=>x.id)); arr.filter(x=>!ids.has(x.id)).forEach(x=>out.push(Object.assign({_lvl:0},x)));
  }
  return out;
}
function walletClosedAt(w, date){ w = typeof w==="string"?wal(w):w; return !!(w && w.closed && w.closedFrom && date >= w.closedFrom); }
function walletPath(id){ return ancestors(id).reverse().map(w=>w.name).join(" / "); }

/* ============================================================
   4. РОЛИ И ПРАВА (раздел 8, МД-01)
   ============================================================ */
function me(){ return usr(CUR.u) || DB.users[0]; }
const has = (u,r) => !!(u && u.roles.includes(r));
const isAdmin = u => has(u,"admin");
function ownWallets(u){ const s = new Set(); (u.wallets||[]).forEach(id=>descendants(id).forEach(x=>s.add(x))); return s; }
/** Скрытый кошелёк (или скрытый предок) виден только из списка доступа (ТР-35) */
function hiddenAllowed(u, w){ return ancestors(w.id).every(a => !a.hidden || (a.access||[]).includes(u.id)); }
let VIS_CACHE = {};
function visibleWallets(u){
  u = u || me(); if(VIS_CACHE[u.id]) return VIS_CACHE[u.id];
  if(DB.perms && u.id===DB.me.id) return VIS_CACHE[u.id] = new Set(DB.perms.visible);
  let s;
  if(isAdmin(u)) s = new Set(DB.wallets.map(w=>w.id));
  else {
    const base = has(u,"owner") ? new Set(DB.wallets.map(w=>w.id)) : ownWallets(u);
    s = new Set([...base].filter(id=>{ const w = wal(id); return w && hiddenAllowed(u,w); }));
  }
  return VIS_CACHE[u.id] = s;
}
/** Казначей видит названия всех активных нескрытых кошельков — для выбора второй стороны */
function pickableWallets(u, date, {all=false}={}){
  u = u || me();
  return DB.wallets.filter(w => !walletClosedAt(w,date) && (isAdmin(u) || hiddenAllowed(u,w)) && (all || true));
}
const seesNoWallet = u => isAdmin(u) || has(u,"owner") || has(u,"treasurer");
/** Может вводить/править по кошельку (ТР, раздел 8: казначей — по своим кошелькам) */
function canEditWallet(u, wid){ if(DB.perms && u.id===DB.me.id) return DB.perms.editable.includes(wid); return isAdmin(u) || (has(u,"treasurer") && ownWallets(u).has(wid)); }
const canEnter = u => isAdmin(u) || has(u,"treasurer");
function roleNames(u){ return u.roles.map(r=>ROLES[r]||r).join(", "); }

/* --- период (ТР-55) --- */
function inClosed(date){ return !!(DB.settings.closedTo && date && date <= DB.settings.closedTo); }
/** День, по которому сверка с 1С прошла без расхождений — правка запрещена */
/** День, по которому сверка с 1С прошла без расхождений — правка запрещена (считает сервер) */
function reconciledDay(date){ return (DB.reconciledDays||[]).includes(date); }
function periodError(date){
  if(!date) return "Не указана дата";
  if(inClosed(date)) return `Период по ${fmtD(DB.settings.closedTo)} закрыт (ТР-55). Исправления вносятся новой операцией в открытом периоде.`;
  if(reconciledDay(date)) return `За ${fmtD(date)} сверка с 1С прошла без расхождений — правка операций этого дня запрещена (ТР-55).`;
  if(DB.settings.startDate && date < DB.settings.startDate) return `Дата раньше начала учёта по кошелькам (${fmtD(DB.settings.startDate)}).`;
  return null;
}

/* ============================================================
   5. ПРАВИЛА АВТОЗАПОЛНЕНИЯ КОШЕЛЬКА (ТР-73, МД-11)
   ============================================================ */
const RULE_FIELDS = {
  org:{name:"Организация", list:()=>DB.orgs},
  acc:{name:"Счёт или касса", list:()=>[...DB.accounts,...DB.cashboxes]},
  dept:{name:"Подразделение", list:()=>DB.depts, tree:true},
  cf:{name:"Тип расхода CF", list:()=>DB.cfTypes},
  zone:{name:"Зона ответственности", list:()=>DB.zones},
  cpty:{name:"Контрагент", text:true},
};
const RULE_OPS = {eq:"Равно", ne:"Не равно", in:"В списке", group:"В группе"};
function deptInGroup(d, groupId){ let x = dept(d), n=0; while(x && n<20){ if(x.id===groupId) return true; x = dept(x.parent); n++; } return false; }
function condResult(c, ctx){
  const f = RULE_FIELDS[c.field]; const vals = c.values||[];
  let v = ctx[c.field];
  const eq = (a,b) => f && f.text ? norm(a)===norm(b) : a===b;
  const inList = () => vals.some(x=>eq(v,x));
  switch(c.op){
    case "eq": return vals.length>0 && inList();
    case "ne": return !inList();
    case "in": return inList();
    case "group": return f && f.tree ? vals.some(g=>deptInGroup(v,g)) : inList();
  }
  return false;
}
/** Возвращает {rule, wallet, trace} — срабатывает первое подходящее правило */
function matchRule(ctx, date){
  const trace = [];
  for(const r of DB.rules){
    if(!r.active){ trace.push({r, ok:false, why:"выключено"}); continue; }
    const w = wal(r.wallet);
    if(!w){ trace.push({r, ok:false, why:"не задан целевой кошелёк"}); continue; }
    if(walletClosedAt(w, date)){ trace.push({r, ok:false, why:"целевой кошелёк закрыт"}); continue; }
    const res = (r.conds||[]).map(c=>({c, ok:condResult(c,ctx)}));
    const ok = res.every(x=>x.ok);
    trace.push({r, ok, res, why: ok ? "сработало" : "условия не выполнены"});
    if(ok) return {rule:r, wallet:r.wallet, trace};
  }
  return {rule:null, wallet:null, trace};
}
function lineCtx(doc, line){ return {org:doc.org, acc:doc.acc, dept:line.dept, cf:line.cf, zone:line.zone, cpty:line.cpty}; }
/** Проставить кошелёк по правилам в строках, где его нет или он был поставлен правилом */
function applyRules(doc, {force=false}={}){
  let n=0;
  (doc.lines||[]).forEach(l=>{
    if(l.wallet && l.wsrc!=="rule" && !force) return;
    const m = matchRule(lineCtx(doc,l), doc.date);
    if(m.wallet){ if(l.wallet!==m.wallet) n++; l.wallet = m.wallet; l.wsrc = "rule"; l.rule = m.rule.id; }
    else if(l.wsrc==="rule"){ l.wallet = null; l.wsrc = null; l.rule = null; n++; }
  });
  return n;
}

/* ============================================================
   6. РАСЧЁТ: ФАКТЫ ДВИЖЕНИЯ ДЕНЕГ
   Остаток = Входящий + Поступления − Списания ± Внутренние операции
   ============================================================ */
let FACTS = null;
let VF_CACHE = {}, NF_CACHE = {};
function inval(){ FACTS = null; RATE_IDX = null; VIS_CACHE = {}; RECON = null; VF_CACHE = {}; NF_CACHE = {}; }

/** Участвует ли документ в расчёте (ТР-07, ТР-08, ТР-72, ТР-74) */
function docCounts(d){
  if(d.excluded || d.deleted) return false;
  if(d.status !== "Проведён") return false;
  if(d.type==="СБДС" && d.approved===false) return false;
  if(DB.settings.startDate && d.date < DB.settings.startDate) return false;
  if(d.source==="manual" && DB.settings.switchDate && d.date >= DB.settings.switchDate) return false;
  return true;
}
function docStateTag(d){
  if(d.excluded) return `<span class="tag off">исключён</span>`;
  if(d.deleted) return `<span class="tag off">помечен на удаление</span>`;
  if(d.source==="manual" && DB.settings.switchDate && d.date >= DB.settings.switchDate) return `<span class="tag off">заменён данными 1С (ТР-72)</span>`;
  if(DB.settings.startDate && d.date < DB.settings.startDate) return `<span class="tag warn">до начала учёта</span>`;
  if(d.status!=="Проведён") return `<span class="tag warn">${esc(d.status)}</span>`;
  if(d.type==="СБДС" && d.approved===false) return `<span class="tag warn">не прошёл согласование</span>`;
  return `<span class="tag ok">в расчёте</span>`;
}
/** Стороны внутренней операции: деньги остаются на счёте, меняется владелец (ТР-27) */
function opLegs(o){
  const legs = [];
  const mk = (L, from, to, n) => { const a = acc(L.acc); if(!a || !(L.sum>0) || !(L.rate>0)) return null;
    return {n, acc:L.acc, org:a.org, cur:a.cur, sum:L.sum, rate:L.rate, usd:r2(L.sum/L.rate), from, to}; };
  if(o.kind==="exchange"){
    const a = mk(o.leg1||{}, o.from, o.to, 1), b = mk(o.leg2||{}, o.to, o.from, 2);
    if(a) legs.push(a); if(b) legs.push(b);
  } else { const a = mk(o.leg1||{}, o.from, o.to, 1); if(a) legs.push(a); }
  return legs;
}
function opComplete(o){ const L = opLegs(o); return o.kind==="exchange" ? L.length===2 : L.length===1; }
function opCounts(o){ return o.posted && !o.deleted && !o.linkedDoc && opComplete(o) && !(DB.settings.startDate && o.date < DB.settings.startDate); }

function facts(){
  if(FACTS) return FACTS;
  const out = [];
  const d0 = DB.settings.startDate;
  if(d0) DB.opening.forEach(x=>{ const a = acc(x.acc); if(!a) return;
    out.push({date:d0, acc:x.acc, org:a.org, cur:a.cur, wallet:x.wallet||null, sum:x.sum, usd:toUSD(x.sum,a.cur,d0), cat:"opening", src:{k:"open", id:x.id}}); });
  DB.docs.forEach(d=>{
    if(!docCounts(d)) return;
    if(d.type==="ПЕР"){
      [["from",-1],["to",+1]].forEach(([side,sg])=>{ const S = d[side]; const a = acc(S.acc); if(!a) return;
        out.push({date:d.date, acc:S.acc, org:a.org, cur:a.cur, wallet:S.wallet||null, sum:sg*S.sum, usd:sg*(S.usd ?? toUSD(S.sum,a.cur,d.date)),
          cat:"transfer", op:d.op, cf:S.cf, src:{k:"doc", id:d.id, side}}); });
      return;
    }
    const sg = DOC_TYPES[d.type].sign; const a = acc(d.acc);
    d.lines.forEach((l,i)=>{
      out.push({date:d.date, acc:d.acc, org:d.org, cur:d.cur || (a&&a.cur), wallet:l.wallet||null, sum:sg*l.sum,
        usd:sg*(isFinite(l.usd) && l.usd!==null ? l.usd : toUSD(l.sum, d.cur, d.date)),
        cat: sg>0 ? "in" : "out", cf:l.cf, notBank: d.type==="СБДС" && !d.bankDone, src:{k:"doc", id:d.id, line:i}});
    });
  });
  DB.ops.forEach(o=>{
    if(!opCounts(o)) return;
    opLegs(o).forEach(L=>{
      out.push({date:o.date, acc:L.acc, org:L.org, cur:L.cur, wallet:L.from, sum:-L.sum, usd:-L.usd, cat:"internal", kind:o.kind, src:{k:"op", id:o.id}});
      out.push({date:o.date, acc:L.acc, org:L.org, cur:L.cur, wallet:L.to,   sum:+L.sum, usd:+L.usd, cat:"internal", kind:o.kind, src:{k:"op", id:o.id}});
    });
  });
  return FACTS = out;
}
/** Факты, видимые пользователю */
function visFacts(u){ u = u||me(); if(VF_CACHE[u.id]) return VF_CACHE[u.id]; const V = visibleWallets(u); const nw = seesNoWallet(u); return VF_CACHE[u.id] = facts().filter(f => f.wallet ? V.has(f.wallet) : nw); }
/** Видна ли пользователю строка документа (казначей не видит строки чужих кошельков) */
function lineVisible(wid, u){ u = u||me(); if(isAdmin(u)) return true; return wid ? visibleWallets(u).has(wid) : seesNoWallet(u); }
/** Имя кошелька; скрытый недоступный кошелёк не раскрывается (ТР-35) */
function wname(id, u){ u = u||me(); const w = wal(id); if(!w) return "без кошелька"; return (isAdmin(u) || hiddenAllowed(u,w)) ? w.name : "скрытый кошелёк"; }

/** Остатки на дату: Map ключ → {wallet, acc, org, cur, sum, notBank} */
function balances(date, list, keyFn){
  keyFn = keyFn || (f => (f.wallet||"∅")+"|"+f.acc+"|"+f.cur);
  const m = new Map();
  list.forEach(f=>{ if(f.date > date) return; const k = keyFn(f);
    let r = m.get(k); if(!r){ r = {wallet:f.wallet, acc:f.acc, org:f.org, cur:f.cur, sum:0, notBank:0}; m.set(k,r); }
    r.sum += f.sum; if(f.notBank) r.notBank += f.sum; });
  m.forEach(r=>{ r.sum = r2(r.sum); r.notBank = r2(r.notBank); });
  return m;
}
/** Сумма по валютам → USD по курсу на дату (ТР-58) */
function usdOf(byCur, date){ let s = 0, miss = []; for(const [c,v] of Object.entries(byCur)){ if(!v) continue; const k = rateAt(c,date); if(!k){ miss.push(curCode(c)); continue; } s += v/k; } return {usd:r2(s), miss}; }

/* ============================================================
   7. СВЕРКА С 1С (ТР-41…43)
   ============================================================ */
let RECON = null;
/** Строки сверки считает сервер по всем кошелькам счёта (интерфейсу могут быть видны не все) */
function recon(){ if(RECON) return RECON; return RECON = (DB.recon||[]).map(r=>Object.assign({a:acc(r.acc)}, r)); }
const badAccs = () => new Set(recon().filter(r=>Math.abs(r.diff)>=0.005).map(r=>r.acc));

/* ============================================================
   8. УВЕДОМЛЕНИЯ (ТР-18, ТР-24, ТР-42, ТР-56, ТР-57)
   ============================================================ */
function treasurersOf(wid){ return DB.users.filter(u=>u.active && has(u,"treasurer") && ownWallets(u).has(wid)).map(u=>u.id); }
function needsFormalizing(){
  return DB.docs.filter(d => d.type==="ПЕР" && docCounts(d) && d.from.wallet && d.to.wallet && d.from.wallet!==d.to.wallet
    && !DB.ops.some(o=>o.linkedDoc===d.id && !o.deleted));
}
/** Уведомления считает сервер: для себя — DB.notifications, администратору — по каждому пользователю */
function notifications(u){
  u = u || me();
  if(u.id===DB.me.id) return DB.notifications || [];
  return (DB.notificationsByUser||{})[u.id] || [];
}

/* ============================================================
   9. ЖУРНАЛ АУДИТА (ТР-44…47) — только добавление
   ============================================================ */
/** Журнал аудита ведёт сервер. Из браузера уходят только просмотры отчётов, выгрузки и формирование писем (ТР-44) */
const CLIENT_AUDIT = new Set(["Просмотр отчёта","Выгрузка в Excel","Формирование письма с уведомлениями"]);
function audit(action, object, details){
  if(!CLIENT_AUDIT.has(action)) return;
  apiRaw("/api/audit/event", {action, object:object||"", details:details||""}).catch(()=>{});
}
function diffText(before, after){
  const keys = new Set([...Object.keys(before||{}), ...Object.keys(after||{})]); const out=[];
  keys.forEach(k=>{ const a = JSON.stringify(before?before[k]:undefined), b = JSON.stringify(after?after[k]:undefined); if(a!==b) out.push(`${k}: ${a??"—"} → ${b??"—"}`); });
  return out.join("; ");
}
/** Краткий «слепок» документа для версий (ТР-14): сумма, дата, кошелёк, статус */
function docSnap(d){
  if(d.type==="ПЕР") return {дата:d.date, сумма:`${fmtIn(d.from.sum)} → ${fmtIn(d.to.sum)}`, кошелёк:`${nm(wal(d.from.wallet))} → ${nm(wal(d.to.wallet))}`, статус:d.deleted?"помечен":d.status};
  return {дата:d.date, сумма:fmtIn(r2(d.lines.reduce((s,l)=>s+l.sum,0))), кошелёк:[...new Set(d.lines.map(l=>l.wallet?nm(wal(l.wallet)):"без кошелька"))].join(", "),
    статус: d.excluded ? "исключён" : d.deleted ? "помечен на удаление" : d.status + (d.type==="СБДС" && d.approved===false ? ", не согласован" : "")};
}
function opSnap(o){ const L = opLegs(o); return {дата:o.date, вид:OP_KINDS[o.kind].name, сумма:L.map(l=>`${fmtIn(l.sum)} ${curCode(l.cur)}`).join(" / "),
  кошелёк:`${nm(wal(o.from))} → ${nm(wal(o.to))}`, статус: o.deleted?"помечена на удаление":o.posted?"проведена":"черновик"}; }
function addVersion(obj, before, after, source){
  const d = diffText(before, after); if(!d) return false;
  (obj.versions = obj.versions||[]).push({t:new Date().toISOString(), u:nm(me()), source:source||"", before, after, diff:d});
  return true;
}


/* ============================================================
   API
   ============================================================ */
async function apiRaw(path, data, method){
  const opt = {method: method || (data===undefined ? "GET" : "POST"), headers:{"X-Requested-With":"wallets"}, credentials:"same-origin"};
  if(data!==undefined){ opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(data); }
  const r = await fetch(path, opt);
  let j = null; try{ j = await r.json(); }catch(e){}
  if(r.status===401 && path!=="/api/login" && path!=="/api/setup"){ if(typeof showLogin==="function") showLogin(); }
  if(!r.ok || (j && j.ok===false)) return {ok:false, status:r.status, errors:(j && j.errors) || [`Ошибка сервера (${r.status})`]};
  return Object.assign({ok:true}, j||{});
}
let BUSY = 0;
function busy(on){ BUSY += on?1:-1; const el = $("#busy"); if(el) el.classList.toggle("hidden", BUSY<=0); document.body.classList.toggle("busy", BUSY>0); }
/** Загрузить данные, разрешённые текущему пользователю */
async function reloadState(){
  const r = await fetch("/api/state", {credentials:"same-origin"});
  if(r.status===401){ showLogin(); return false; }
  if(!r.ok){ SAVE_ERR = "Сервер недоступен"; return false; }
  const d = await r.json();
  DB = Object.assign(emptyDB(), d); DB.settings = Object.assign(emptyDB().settings, d.settings||{});
  CUR.u = d.me.id; SAVE_ERR = "";
  inval(); return true;
}
/** Изменение данных: запрос → перечитать данные → перерисовать. Возвращает {ok, result} или {ok:false, errors} */
async function mutate(path, data){
  busy(true);
  try{
    const r = await apiRaw(path, data===undefined ? {} : data);
    if(r.ok){ await reloadState(); render(); }
    return r;
  } catch(e){ return {ok:false, errors:["Нет связи с сервером: " + e.message]}; }
  finally{ busy(false); }
}
function showErrors(r){ if(r && !r.ok) alert(r.errors.join("\n")); }

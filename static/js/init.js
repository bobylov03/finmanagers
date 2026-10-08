"use strict";
/* ============================================================
   ВХОД (ТР-48), ЗАГРУЗКА ДАННЫХ, ОБНОВЛЕНИЕ ОТ ДРУГИХ ПОЛЬЗОВАТЕЛЕЙ
   ============================================================ */
let SESSION = null, LOGIN_MSG = "", STATUS = null, POLL = null;

async function startSession(){
  if(!(await reloadState())) return;
  SESSION = DB.me.id; VIS_CACHE = {}; LAST_REPORT_LOG = "";
  if(DB.me.lang){ LANG = DB.me.lang; document.documentElement.lang = LANG; }
  RF.rep75.wallets = []; RF.rep38.wallets = []; VIEW = "dash"; AUD = null;
  $("#login").classList.add("hidden");
  render();
  clearInterval(POLL);
  // данные меняют и другие пользователи: раз в 20 секунд проверяем версию
  POLL = setInterval(async ()=>{
    if(!SESSION || MODAL || BUSY>0 || document.hidden) return;
    try{ const r = await apiRaw("/api/version"); if(r.ok && r.version!==DB.version){ await reloadState(); render(); } }catch(e){}
  }, 20000);
}
async function logout(){
  if(SESSION) await apiRaw("/api/logout", {}).catch(()=>{});
  SESSION = null; clearInterval(POLL); MODAL = null; renderModal(); showLogin();
}
async function showLogin(){
  SESSION = null; clearInterval(POLL);
  try{ STATUS = (await apiRaw("/api/status")) || STATUS; }catch(e){}
  const fr = STATUS && STATUS.firstRun;
  const box = $("#login"); box.classList.remove("hidden");
  box.innerHTML = `<form class="modal" style="width:min(420px,100%)" onsubmit="event.preventDefault();doLogin()">
    <header><h3>Остатки по кошелькам</h3><div style="flex:1"></div><span id="langBoxLogin"></span></header>
    <div class="body stack">
      ${fr ? `<div class="alert ok">Первый запуск: задайте пароль администратора (логин <b>${esc(STATUS.adminLogin)}</b>). Запомните логин и пароль — они понадобятся для следующего входа.</div>` : ""}
      ${LOGIN_MSG ? `<div class="alert err">${esc(LOGIN_MSG)}</div>` : ""}
      <label class="fld"><span>Логин</span><input type="text" id="lgLogin" autocomplete="username" value="${esc(fr ? STATUS.adminLogin : lastLogin())}" ${fr?"readonly":""} placeholder="например, admin"></label>
      <label class="fld"><span>Пароль</span><input type="password" id="lgPw" autocomplete="${fr?"new-password":"current-password"}"></label>
      ${fr ? `<label class="fld"><span>Повторите пароль</span><input type="password" id="lgPw2" autocomplete="new-password"></label>` : ""}
    </div>
    <footer><button class="btn primary" type="submit">${fr?"Задать пароль и войти":"Войти"}</button></footer></form>`;
  renderLang();
  setTimeout(()=>{ const el = $(fr || lastLogin() ? "#lgPw" : "#lgLogin"); if(el) el.focus(); }, 0);
  translateDom(box);
}
/** Последний логин, с которым входили в этом браузере — подставляется в форму */
function lastLogin(){ try{ return localStorage.getItem("wallets-login") || ""; }catch(e){ return ""; } }
function rememberLogin(l){ try{ localStorage.setItem("wallets-login", l); }catch(e){} }
async function doLogin(){
  const login = $("#lgLogin").value.trim(), pw = $("#lgPw").value;
  let r;
  busy(true);
  try{
    if(STATUS && STATUS.firstRun){
      const pw2 = $("#lgPw2").value;
      if(pw.length < 8){ LOGIN_MSG = "Пароль — не короче 8 символов"; return showLogin(); }
      if(pw !== pw2){ LOGIN_MSG = "Пароли не совпадают"; return showLogin(); }
      r = await apiRaw("/api/setup", {password:pw});
    } else r = await apiRaw("/api/login", {login, password:pw});
  } catch(e){ r = {ok:false, errors:["Нет связи с сервером"]}; }
  finally{ busy(false); }
  if(!r.ok){ LOGIN_MSG = r.errors.join("; "); return showLogin(); }
  rememberLogin(STATUS && STATUS.firstRun ? STATUS.adminLogin : login);
  LOGIN_MSG = ""; await startSession();
}
function changeOwnPw(){
  openModal({title:"Смена пароля", width:420, body:()=>`<div class="stack">
    <label class="fld"><span>Текущий пароль</span><input type="password" id="cpOld" autocomplete="current-password"></label>
    <label class="fld"><span>Новый пароль</span><input type="password" id="cpN1" autocomplete="new-password"></label>
    <label class="fld"><span>Повторите</span><input type="password" id="cpN2" autocomplete="new-password"></label></div>`,
    footer:()=>`<button class="btn" onclick="closeModal()">Отмена</button><button class="btn primary" id="cpSave">Сохранить</button>`});
  $("#cpSave").onclick = async () => {
    const o = $("#cpOld").value, a = $("#cpN1").value, b = $("#cpN2").value;
    if(a.length<8 || a!==b){ alert("Новый пароль — не короче 8 символов, оба поля должны совпадать"); return; }
    const r = await apiRaw("/api/password", {old:o, new:a});
    if(!r.ok) return showErrors(r);
    closeModal(); alert("Пароль изменён");
  };
}
async function init(){
  document.documentElement.lang = LANG;
  try{ STATUS = await apiRaw("/api/status"); }catch(e){ STATUS = null; }
  if(STATUS && STATUS.ok && STATUS.user) await startSession();
  else showLogin();
}
$("#curDate").addEventListener("change", e=>{ CUR.date = e.target.value || todayISO(); inval(); render(); });
$("#bell").addEventListener("click", ()=>{
  const nf = notifications();
  openModal({title:"Уведомления", width:720, body:()=> nf.length ? nf.map(n=>`<div class="alert ${n.lvl}" style="cursor:pointer" onclick="closeModal();go('${n.go}')">${esc(n.text)} <span class="tzref">${n.tr}</span></div>`).join("") : `<p class="muted">Нет уведомлений</p>`});
});
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && MODAL) closeModal(); });
init();

// Сквозной тест в браузере: node tests/e2e.js http://localhost:8000  (нужен npm i playwright)
// База должна быть пустой (первый запуск). Использует файлы из tests/fixtures.
const {chromium} = require('playwright');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:8000';
const FX = f => path.join(__dirname, 'fixtures', f);
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if(!cond) fails++; };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({acceptDownloads: true});
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  pg.on('dialog', d => d.accept());
  const E = (f, a) => pg.evaluate(f, a);
  const viewOk = async tag => { const t = await pg.textContent('#view'); if(t.includes('Ошибка отображения')) errs.push(tag + ': ' + t.slice(0, 200)); };
  const upload = async (tab, file) => {
    await E(t => { IMP = {tab: t, fileName: '', sheets: null, err: null, sel: null, pv: null, logged: false, refKind: ''}; go('import'); }, tab);
    await pg.setInputFiles('#view input[type=file]', FX(file));
    await pg.waitForFunction(() => IMP.pv || IMP.err, null, {timeout: 60000});
    return E(() => IMP.err ? {err: IMP.err} : IMP.pv);
  };
  const W = () => E(() => Object.fromEntries(DB.wallets.map(w => [w.name, w.id])));
  const login = async (l, p) => {
    if(await E(() => !!SESSION)) await E(() => logout());
    await pg.waitForSelector('#lgLogin');
    await E(() => { LOGIN_MSG = ''; });
    await pg.fill('#lgLogin', l); await pg.fill('#lgPw', p); await pg.click('#login button[type=submit]');
    await pg.waitForFunction(() => SESSION || LOGIN_MSG, null, {timeout: 10000});
  };

  await pg.goto(BASE);
  await pg.waitForSelector('#lgPw2');
  ok(await pg.isVisible('#lgPw2'), 'первый запуск: форма задания пароля администратора');
  await pg.fill('#lgPw', 'admin-pass-1'); await pg.fill('#lgPw2', 'admin-pass-1'); await pg.click('#login button[type=submit]');
  await pg.waitForFunction(() => SESSION);
  ok(await E(() => me().name) === 'Администратор', 'вход администратора');
  await E(() => setSetting('autoClose', false, ''));

  let pv = await upload('ref', 'refs.xlsx');
  ok(!pv.err && pv.errors.length === 0, 'справочники: предпросмотр без ошибок');
  await E(() => applyRef()); await pg.waitForFunction(() => !BUSY && DB.orgs.length === 2);
  ok(await E(() => DB.rates.find(r => r.cur === 'AED').rate) === 3.6725, 'курс AED хранится как котируется (3,6725)');
  await E(() => setSetting('startDate', '2026-09-01', ''));
  for(const [n, p, h, hid] of [['Холдинг', null, 1, 0], ['КТФ', 'Холдинг', 0, 0], ['МТФ', 'Холдинг', 0, 0], ['Трейдинг', null, 0, 1]]) {
    await E(async ([n, p, h, hid]) => { openWallet(null); WE.name = n; WE.parent = p ? DB.wallets.find(w => w.name === p).id : null; WE.head = !!h; WE.hidden = !!hid; await saveWallet(); }, [n, p, h, hid]);
  }
  let w = await W();
  ok(Object.keys(w).length === 4, 'созданы 4 кошелька');
  await E(async w => { openRule(null); RE.name = 'КТФ'; RE.conds = [{field: 'dept', op: 'group', values: ['d-2']}]; RE.wallet = w['КТФ']; await saveRule();
    openRule(null); RE.name = 'МТФ'; RE.conds = [{field: 'dept', op: 'eq', values: ['d-3']}]; RE.wallet = w['МТФ']; await saveRule(); }, w);
  await E(async w => { openOpening('a-1'); OB.rows = [{id: '', wallet: w['КТФ'], sum: 60000}, {id: '', wallet: w['МТФ'], sum: 40000}]; await saveOpening();
    openOpening('a-2'); OB.rows = [{id: '', wallet: w['КТФ'], sum: 100000}]; await saveOpening(); }, w);
  ok(await E(() => DB.opening.length) === 3, 'входящие остатки сохранены');

  pv = await upload('exp', 'exp.xlsx');
  ok(pv.add.length === 3 && pv.skip70.length === 1 && pv.errors.length === 0, `документы: добавится 3, пропущено по ТР-70 1 (было ${pv.add && pv.add.length}/${pv.skip70 && pv.skip70.length})`);
  await E(() => applyExp()); await pg.waitForFunction(() => !BUSY && VIEW === 'xlog');
  const lines = await E(() => DB.docs.find(d => d.guid === 'g-1').lines.map(l => wal(l.wallet).name));
  ok(lines.join(',') === 'КТФ,МТФ', 'правила проставили кошельки по строкам');
  pv = await upload('exp', 'exp.xlsx');
  ok(pv.add.length === 0 && pv.upd.length === 0 && pv.exc.length === 0 && pv.same.length === 3, 'повторная загрузка того же файла ничего не меняет');
  pv = await upload('exp', 'bad.xlsx');
  ok(pv.errors.length === 2, 'файл с ошибками отклонён, ошибки по строкам');
  pv = await upload('bal', 'bal.csv');
  ok(pv.errors.length === 0 && pv.items === 2, 'остатки 1С: предпросмотр');
  await E(() => applyBal()); await pg.waitForFunction(() => !BUSY && VIEW === 'recon');
  ok(await E(() => recon().every(r => Math.abs(r.diff) < 0.005)), 'сверка с 1С сходится');

  // ручное поступление 50 000 000 AED
  await E(() => { newDoc('ПБДС'); edSet('org', 'o-1'); edSet('acc', 'a-2'); edSet('date', '2026-09-18'); });
  await pg.fill('#ln0', '50000000'); await pg.dispatchEvent('#ln0', 'input');
  ok(await pg.inputValue('#ln0') === '50 000 000', 'разделение разрядов при вводе');
  await pg.$eval('#ln0', el => el.dispatchEvent(new Event('change')));
  await E(async () => { ED.lines[0].dept = 'd-3'; applyRules(ED); await saveManual(); });
  ok(await E(() => DB.docs.find(d => d.type === 'ПБДС').lines[0].usd) === 13614703.88, '50 000 000 AED = 13 614 703,88 USD (расчёт на сервере)');

  // переброска с привязанным займом
  await E(async w => { newDoc('ПЕР'); ED.date = '2026-09-24'; ED.op = 'Оплата в другую организацию группы'; trSet('from', 'org', 'o-1'); trSet('from', 'acc', 'a-1');
    trSet('to', 'org', 'o-2'); trSet('to', 'acc', 'a-3'); trSet('from', 'sum', 250); trSet('from', 'wallet', w['КТФ']); trSet('to', 'wallet', w['Холдинг']);
    ED.link.kind = 'loan'; await quickContract(); await saveManual(); }, w);
  ok(await E(() => DB.ops.some(o => o.linkedDoc && o.kind === 'loan')), 'переброска + займ одной формой');
  ok(await E(() => loanRows('2026-09-30')[0].debt) === 250, 'долг по займу 250 USD');

  // обмен: без второй ноги не проводится
  await E(async w => { newOp({kind: 'exchange'}); OE.from = w['КТФ']; OE.to = w['МТФ']; OE.date = '2026-09-19'; legSet('leg1', 'org', 'o-1'); legSet('leg1', 'acc', 'a-1'); legSet('leg1', 'sum', 500); await saveOp(true); }, w);
  ok(await E(() => (OEerr || []).some(e => e.includes('Нога 2'))), 'обмен без второй ноги не проводится');
  await E(async () => { legSet('leg2', 'org', 'o-2'); legSet('leg2', 'acc', 'a-3'); legSet('leg2', 'sum', 500); await saveOp(true); });
  ok(await E(() => DB.ops.some(o => o.kind === 'exchange' && o.posted)), 'обмен с двумя ногами проведён');

  // пользователи
  await E(async w => { const mk = async (n, l, roles, ws) => { openUser(null); UE.name = n; UE.login = l; UE.roles = roles; UE.wallets = ws; UE._pw = 'secret-pass-1'; await saveUser(); };
    await mk('Казначей КТФ', 't1', ['treasurer'], [w['КТФ']]); await mk('Собственник', 'o1', ['owner'], []); await mk('Рук отдела', 'd1', ['deptHead'], [w['МТФ']]); }, w);
  ok(await E(() => DB.users.length) === 4, 'созданы пользователи');

  const views = ['dash', 'rep37', 'rep75', 'rep38', 'rep40', 'recon', 'docs', 'ops', 'nowallet', 'formalize', 'closedch', 'wallets', 'rules', 'refs', 'import', 'xlog', 'opening', 'users', 'mail', 'settings', 'audit'];
  for(const v of views) { await E(v => go(v), v); await pg.waitForTimeout(30); await viewOk('admin/' + v); }

  // казначей: видит только свой кошелёк; чужие строки скрыты сервером
  await login('t1', 'secret-pass-1');
  ok(await E(() => [...visibleWallets()].map(id => wal(id).name).join(',')) === 'КТФ', 'казначей видит только КТФ');
  ok(await E(() => DB.docs.find(d => d.guid === 'g-1').lines.length === 1 && DB.docs.find(d => d.guid === 'g-1').hiddenLines === 1), 'строка чужого кошелька не передана с сервера');
  ok(await E(() => !DB.wallets.some(w => w.name === 'Трейдинг')), 'скрытый кошелёк не передан казначею');
  const r403 = await E(async () => apiRaw('/api/wallets', {wallet: {name: 'X'}}));
  ok(!r403.ok && r403.status === 403, 'казначею запрещено создавать кошельки (403)');
  const rOther = await E(async () => { const d = DB.docs.find(d => d.guid === 'g-1'); return apiRaw(`/api/docs/${d.id}/wallets`, {changes: [{where: '1', wallet: d.lines[0].wallet}]}); });
  ok(!rOther.ok, 'казначей не может переназначить строку чужого кошелька');
  for(const v of views) { await E(v => go(v), v); await pg.waitForTimeout(20); await viewOk('treasurer/' + v); }
  await login('t1', 'wrong');
  ok(await E(() => LOGIN_MSG) === 'Неверный логин или пароль', 'неверный пароль отклонён');
  await login('o1', 'secret-pass-1');
  ok(await E(() => [...visibleWallets()].map(id => wal(id).name).sort().join(',')) === 'КТФ,МТФ,Холдинг', 'собственник видит все, кроме скрытого');
  for(const v of views) { await E(v => go(v), v); await pg.waitForTimeout(20); await viewOk('owner/' + v); }

  // администратор: журнал, английский, закрытие периода
  await login('admin', 'admin-pass-1');
  await E(() => go('audit')); await pg.waitForFunction(() => AUD !== null);
  const actions = await E(() => AUD.map(a => a.action));
  ok(actions.includes('Неудачная попытка входа') && actions.includes('Загрузка файла') && actions.includes('Просмотр отчёта'), 'журнал аудита на сервере');
  await E(() => setLang('en')); await E(() => go('dash'));
  ok((await pg.textContent('#view h1')) === 'Summary', 'английский интерфейс');
  await E(() => setLang('ru'));
  await E(() => setSetting('closedTo', '2026-09-20', ''));
  const rClosed = await E(async () => { const d = DB.docs.find(d => d.type === 'ПБДС'); return apiRaw(`/api/docs/${d.id}/delete`, {}); });
  ok(!rClosed.ok && rClosed.errors[0].includes('закрыт'), 'закрытый период: сервер не даёт менять документ');
  const n0 = await E(() => DB.docs.length);
  await E(() => resetAll());
  await pg.waitForFunction(() => !BUSY && DB.docs.length === 0);
  await E(() => go('audit')); await E(() => { AUD = null; render(); }); await pg.waitForFunction(() => AUD !== null && AUD.length > 0);
  ok(n0 > 0 && await E(() => AUD.length) > 20, 'удаление данных не стирает журнал аудита (ТР-46)');

  ok(errs.length === 0, 'нет ошибок JavaScript и отображения' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close();
  console.log(fails ? `\nПровалено проверок: ${fails}` : '\nВсе проверки пройдены');
  process.exit(fails ? 1 : 0);
})();

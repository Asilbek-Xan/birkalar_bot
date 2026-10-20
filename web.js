/* Brauzerdagi panel (bot.js ichidan ishga tushadi, bir xil baza bilan ishlaydi) */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const ExcelJS = require('exceljs');

module.exports = function startWeb({ db, now, cap, qosh, markDone, notify, idsOf, loginTokens }) {
  const app = express();
  const sessions = new Map();

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
  const getSession = (req) => {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
    return m ? sessions.get(m[1]) : null;
  };
  const auth = (...roles) => (req, res, next) => {
    const s = getSession(req);
    if (!s || (roles.length && !roles.includes(s.rol))) return res.status(401).json({ xato: 'Ruxsat yo\'q' });
    req.s = s;
    next();
  };

  app.use(express.json());
  const fs = require('fs');
  const pub = path.join(__dirname, 'public');
  app.use(express.static(pub));
  // index.html "public" papkasida bo'lmasa, bot.js yonida turgan bo'lsa ham topiladi
  app.get('/', (req, res, next) => {
    const f = [path.join(pub, 'index.html'), path.join(__dirname, 'index.html')].find((p) => fs.existsSync(p));
    return f ? res.sendFile(f) : next();
  });

  // ---------- Telegramdagi /panel havolasi bilan kirish ----------
  // GET faqat sahifani beradi; tokenni POST ishlatadi (Telegram havolani oldindan ochib tekshirsa, token yonmaydi)
  app.get('/auth', (req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Kirilmoqda</title>
<body style="font:16px system-ui,sans-serif;padding:40px;text-align:center">
<p id="m">Kirilmoqda...</p>
<script>
const t = new URLSearchParams(location.search).get('t');
fetch('/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t }) })
  .then((r) => (r.ok ? location.replace('/') : Promise.reject()))
  .catch(() => { document.getElementById('m').textContent = 'Havola eskirgan yoki ishlatilgan. Botda /panel ni qayta bosing.'; });
</script></body>`);
  });
  app.post('/auth', (req, res) => {
    const t = String((req.body || {}).t || '');
    const v = loginTokens && loginTokens.get(t);
    if (loginTokens) loginTokens.delete(t);
    if (!v || v.exp < Date.now()) return res.status(401).json({ xato: 'Havola eskirgan' });
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { rol: v.rol, ism: v.ism });
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    res.json({ ok: true });
  });

  // ---------- Kirish ----------
  app.post('/api/login', (req, res) => {
    const { parol, ism } = req.body || {};
    let rol = null;
    if (process.env.ADMIN_PASSWORD && same(parol, process.env.ADMIN_PASSWORD)) rol = 'admin';
    else if (process.env.ISHCHI_PASSWORD && same(parol, process.env.ISHCHI_PASSWORD)) rol = 'ishchi';
    if (!rol) return setTimeout(() => res.status(401).json({ xato: 'Parol noto\'g\'ri' }), 800);
    if (rol === 'ishchi' && !String(ism || '').trim()) return res.status(400).json({ xato: 'Ismingizni kiriting' });

    const token = crypto.randomBytes(24).toString('hex');
    const s = { rol, ism: rol === 'admin' ? 'Admin (web)' : String(ism).trim().slice(0, 40) + ' (web)' };
    sessions.set(token, s);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    res.json(s);
  });
  app.post('/api/logout', (req, res) => {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
    if (m) sessions.delete(m[1]);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    res.json({ ok: true });
  });
  app.get('/api/me', auth(), (req, res) => res.json(req.s));

  // ---------- Statistika ----------
  app.get('/api/stats', auth(), (req, res) => {
    const kun = now().slice(0, 10);
    const t = db.prepare('SELECT COUNT(*) n, SUM(chiqarilgan IS NOT NULL) d FROM birka').get();
    const bugunGuruh = db
      .prepare('SELECT tur, rang, COUNT(*) n FROM birka WHERE chiqarilgan LIKE ? GROUP BY tur, rang')
      .all(kun + '%');
    res.json({
      kun,
      jami: t.n,
      chiqarilgan: t.d || 0,
      qolgan: t.n - (t.d || 0),
      bugun: bugunGuruh.reduce((s, r) => s + r.n, 0),
      guruh: db
        .prepare('SELECT tur, rang, COUNT(*) n, SUM(chiqarilgan IS NOT NULL) d FROM birka GROUP BY tur, rang')
        .all(),
      bugunGuruh,
      kim: db
        .prepare('SELECT kim_ism, COUNT(*) n FROM birka WHERE chiqarilgan LIKE ? GROUP BY kim_ism')
        .all(kun + '%'),
    });
  });

  app.get('/api/filtr', auth(), (req, res) => {
    res.json({
      turlar: db.prepare('SELECT DISTINCT tur FROM birka ORDER BY tur').all().map((r) => r.tur),
      ranglar: db.prepare('SELECT DISTINCT rang FROM birka ORDER BY rang').all().map((r) => r.rang),
    });
  });

  // ---------- Birkalar ro'yxati ----------
  app.get('/api/birka', auth(), (req, res) => {
    const { tur, rang, holat = 'qolgan', q, sahifa = 1 } = req.query;
    const where = [];
    const args = [];
    if (tur) { where.push('tur=?'); args.push(tur); }
    if (rang) { where.push('rang=?'); args.push(rang); }
    if (holat === 'qolgan') where.push('chiqarilgan IS NULL');
    if (holat === 'bajarilgan') where.push('chiqarilgan IS NOT NULL');
    if (q) { where.push('raqam LIKE ?'); args.push('%' + q + '%'); }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = 50;
    const offset = (Math.max(1, Number(sahifa) || 1) - 1) * limit;
    const total = db.prepare(`SELECT COUNT(*) n FROM birka ${W}`).get(...args).n;
    const rows = db
      .prepare(`SELECT * FROM birka ${W} ORDER BY CAST(raqam AS INTEGER), raqam LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    res.json({ total, limit, rows });
  });

  app.post('/api/birka/:id/done', auth(), async (req, res) => {
    const row = db.prepare('SELECT * FROM birka WHERE id=?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ xato: 'Topilmadi' });
    if (row.chiqarilgan) return res.status(409).json({ xato: 'Bu allaqachon chiqarilgan' });
    await markDone(row, { id: 0, ism: req.s.ism });
    res.json({ ok: true });
  });

  app.post('/api/birka/:id/undo', auth('admin'), (req, res) => {
    db.prepare('UPDATE birka SET chiqarilgan=NULL, kim_id=NULL, kim_ism=NULL WHERE id=?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- Qo'shish (admin) ----------
  app.post('/api/qosh', auth('admin'), async (req, res) => {
    const { tur, rang, from, to } = req.body || {};
    const a = String(from || '').trim();
    const b = String(to || from || '').trim();
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b) || !String(tur || '').trim() || !String(rang || '').trim()) {
      return res.status(400).json({ xato: 'Tur, rang va raqamlarni to\'g\'ri kiriting' });
    }
    const f = Number(a);
    const t = Number(b);
    if (t < f || t - f > 5000) return res.status(400).json({ xato: 'Oraliq noto\'g\'ri (eng ko\'pi 5000 ta)' });
    const items = [];
    for (let i = f; i <= t; i++) items.push({ raqam: String(i).padStart(a.length, '0'), rang: cap(rang), tur: cap(tur) });
    res.json(await qosh(items));
  });

  app.post('/api/upload', auth('admin'), express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.body);
      const ws = wb.worksheets[0];
      const head = {};
      ws.getRow(1).eachCell((c, i) => (head[String(c.text).trim().toLowerCase()] = i));
      const iR = head['birka'] || head['raqam'] || head['nomer'];
      const iC = head['rang'];
      const iT = head['tur'];
      if (!iR || !iC || !iT) return res.status(400).json({ xato: 'Sarlavha topilmadi. Ustunlar: Birka | Rang | Tur' });
      const items = [];
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const raqam = String(row.getCell(iR).text || '').trim();
        if (raqam) items.push({ raqam, rang: cap(row.getCell(iC).text), tur: cap(row.getCell(iT).text) });
      });
      res.json(await qosh(items));
    } catch (e) {
      console.error(e);
      res.status(400).json({ xato: 'Faylni o\'qib bo\'lmadi (.xlsx bo\'lishi kerak)' });
    }
  });

  // ---------- Ishchilar (admin) ----------
  app.get('/api/ishchilar', auth('admin'), (req, res) => {
    res.json(db.prepare("SELECT id, ism, rol FROM users WHERE rol IN ('kutilmoqda','ishchi') ORDER BY rol DESC, ism").all());
  });
  app.post('/api/ishchilar/:id/:amal', auth('admin'), async (req, res) => {
    const id = Number(req.params.id);
    const amal = req.params.amal;
    if (amal === 'approve') {
      db.prepare("UPDATE users SET rol='ishchi' WHERE id=? AND rol!='admin'").run(id);
      await notify([id], '✅ Siz tasdiqlandingiz. /start ni bosing.');
    } else {
      db.prepare("UPDATE users SET rol='rad' WHERE id=? AND rol!='admin'").run(id);
    }
    res.json({ ok: true });
  });

  // ---------- Excel ----------
  async function sendXlsx(res, filename, rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Birkalar');
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 16));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(Buffer.from(await wb.xlsx.writeBuffer()));
  }
  app.get('/api/excel', auth(), (req, res) => {
    const admin = req.s.rol === 'admin';
    const q = admin
      ? 'SELECT * FROM birka ORDER BY partiya, id'
      : 'SELECT * FROM birka WHERE chiqarilgan IS NULL ORDER BY partiya, id';
    const rows = [['Birka', 'Rang', 'Tur', 'Holat', 'Kim chiqargan', 'Vaqt', 'Partiya']];
    db.prepare(q).all().forEach((r) =>
      rows.push([r.raqam, r.rang, r.tur, r.chiqarilgan ? 'Chiqarilgan' : 'Qolgan', r.kim_ism || '', r.chiqarilgan || '', r.partiya])
    );
    return sendXlsx(res, 'birkalar_hisobot.xlsx', rows);
  });
  app.get('/api/namuna', auth('admin'), (req, res) =>
    sendXlsx(res, 'namuna.xlsx', [
      ['Birka', 'Rang', 'Tur'],
      ['1001', 'Sariq', 'Qo\'y'],
      ['1002', 'Sariq', 'Qo\'y'],
      ['2001', 'Ko\'k', 'Mol'],
    ])
  );

  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => console.log(`✅ Web panel: http://localhost:${port}`));
  server.on('error', (e) =>
    console.error(
      e.code === 'EADDRINUSE'
        ? `❌ ${port}-port band (boshqa dastur ishlatyapti). .env da PORT=3001 deb o'zgartiring.`
        : `❌ Web panel xatosi: ${e.message}`
    )
  );
};

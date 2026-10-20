/*
 Birkalar boti - Admin + Ishchilar (Node.js)

 ADMIN:   jadval yuklaydi (Excel yoki /qosh), ishchilarni tasdiqlaydi,
          har bir bajarilgan ish va kunlik hisobotni oladi.
 ISHCHI:  yangi vazifa haqida xabar oladi, birkalarni "chiqarildi" deb belgilaydi.
*/


import http from 'http';

// Oddiy port ochib qo'yish Render uchun kifoya
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});




require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const cron = require('node-cron');
const crypto = require('crypto');

const BOT_ON = !!process.env.BOT_TOKEN;
if (!BOT_ON) console.warn('⚠️ BOT_TOKEN yo\'q: faqat web panel ishlaydi.');
if (!process.env.ADMIN_PASSWORD) console.warn('⚠️ ADMIN_PASSWORD yo\'q: web panelga kirib bo\'lmaydi.');

const bot = new Telegraf(process.env.BOT_TOKEN || '0:web-only');
const db = new Database('birka.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  ism TEXT,
  rol TEXT            -- admin | ishchi | kutilmoqda | rad
);
CREATE TABLE IF NOT EXISTS birka(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raqam TEXT UNIQUE,
  rang TEXT,
  tur TEXT,
  partiya INTEGER,
  qoshilgan TEXT,
  chiqarilgan TEXT,
  kim_id INTEGER,
  kim_ism TEXT
);`);

// adminlarni .env dan olamiz
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
for (const id of ADMIN_IDS) {
  db.prepare(
    "INSERT INTO users(id, ism, rol) VALUES(?, 'Admin', 'admin') ON CONFLICT(id) DO UPDATE SET rol='admin'"
  ).run(id);
}

// ---------- yordamchilar ----------
const TZ = Number(process.env.TZ_OFFSET || 5); // Toshkent UTC+5
const now = () =>
  new Date(Date.now() + TZ * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
const cap = (s) => {
  s = String(s || '').trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
};
const chunk = (a, n) => {
  const r = [];
  for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n));
  return r;
};
const idsOf = (...roles) =>
  db
    .prepare(`SELECT id FROM users WHERE rol IN (${roles.map(() => '?').join(',')})`)
    .all(...roles)
    .map((r) => r.id);

async function notify(ids, text, extra) {
  if (!BOT_ON) return;
  for (const id of ids) {
    try {
      await bot.telegram.sendMessage(id, text, extra);
    } catch (e) {
      console.error('Xabar yuborilmadi:', id, e.message);
    }
  }
}
const adminOnly = (fn) => (ctx, next) => {
  if (ctx.state.user.rol === 'admin') return fn(ctx, next);
  return ctx.callbackQuery ? ctx.answerCbQuery('Faqat admin uchun') : ctx.reply('Bu buyruq faqat admin uchun.');
};
const lines = (rows) => rows.map((r) => `• ${r.tur} / ${r.rang}: ${r.n} ta`).join('\n');

// ---------- Kirish nazorati (ro'yxatdan o'tish) ----------
bot.use(async (ctx, next) => {
  if (ctx.from) console.log(`📩 Xabar keldi: ID=${ctx.from.id} ${ctx.message && ctx.message.text ? ctx.message.text : ''}`);
  return next();
});

bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  let u = db.prepare('SELECT * FROM users WHERE id=?').get(ctx.from.id);

  const ism =
    [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') +
    (ctx.from.username ? ` @${ctx.from.username}` : '');
  const matn = (ctx.message && ctx.message.text) || '';

  const soraviYubor = async (sarlavha) => {
    await ctx.reply('So\'rovingiz adminga yuborildi. Tasdiqlanishini kuting.');
    await notify(
      idsOf('admin'),
      `${sarlavha}\n${ism}\nID: ${ctx.from.id}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Tasdiqlash', `A:${ctx.from.id}`),
          Markup.button.callback('❌ Rad etish', `X:${ctx.from.id}`),
        ],
      ])
    );
  };

  if (!u) {
    db.prepare("INSERT INTO users(id, ism, rol) VALUES(?,?,'kutilmoqda')").run(ctx.from.id, ism);
    return soraviYubor('👤 Yangi ishchi so\'rovi:');
  }
  if (u.rol === 'kutilmoqda') return ctx.reply('Admin tasdiqlashini kuting.');
  if (u.rol === 'rad') {
    // Olib tashlangan yoki rad etilgan odam /start bosib qayta so'rov yubora oladi
    if (matn.startsWith('/start')) {
      db.prepare("UPDATE users SET rol='kutilmoqda', ism=? WHERE id=?").run(ism, ctx.from.id);
      return soraviYubor('🔁 Qayta so\'rov (oldin olib tashlangan yoki rad etilgan):');
    }
    return ctx.reply('Sizga hozircha ruxsat yo\'q. Adminga qayta so\'rov yuborish uchun /start ni bosing.');
  }
  ctx.state.user = u;
  return next();
});

// ---------- /start ----------
bot.start((ctx) => {
  const admin = ctx.state.user.rol === 'admin';
  let t =
    '/qolgan - chiqarilmagan birkalar (tur va rang bo\'yicha)\n' +
    '/panel - web panel (brauzerda ochiladi)\n' +
    '/bugun - bugun nechta chiqarildi\n' +
    '/hisobot - umumiy holat\n' +
    '/excel - Excel hisobot\n\n' +
    'Birka raqamini yozsangiz, u "chiqarildi" deb belgilanadi.';
  if (admin) {
    t =
      'ADMIN PANEL\n\n' +
      '📎 Excel jadval yuboring (Birka | Rang | Tur) - yangi vazifa yaratiladi\n' +
      '/qosh Qo\'y Sariq 1001-1050 - birkalarni yozib qo\'shish\n' +
      '/ishchilar - ishchilar ro\'yxati\n' +
      t;
  }
  ctx.reply(t);
});

// ---------- Web panel (bir martalik havola bilan, parolsiz kirish) ----------
const loginTokens = new Map(); // token -> { rol, ism, exp }

function panelLink(u, from) {
  const t = crypto.randomBytes(24).toString('hex');
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || u.ism;
  loginTokens.set(t, { rol: u.rol === 'admin' ? 'admin' : 'ishchi', ism: `${name} (web)`, exp: Date.now() + 5 * 60 * 1000 });
  for (const [k, v] of loginTokens) if (v.exp < Date.now()) loginTokens.delete(k);
  const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
  return `${base}/auth?t=${t}`;
}

bot.command('panel', async (ctx) => {
  const admin = ctx.state.user.rol === 'admin';
  const url = panelLink(ctx.state.user, ctx.from);
  const text = admin
    ? '🌐 Admin web panel. Tugmani bosing (havola 5 daqiqa amal qiladi).'
    : '🌐 Web panel. Tugmani bosing (havola 5 daqiqa amal qiladi).';
  try {
    await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.url('🌐 Web panelni ochish', url)]]));
  } catch (e) {
    // Telegram localhost havolali tugmani qabul qilmaydi - oddiy matn qilib yuboramiz
    await ctx.reply(`${text}\n\nHavolani brauzerga nusxalab qo'ying:\n${url}`);
  }
});

// ---------- Ishchilarni tasdiqlash (admin) ----------
bot.action(/^A:(\d+)$/, adminOnly(async (ctx) => {
  const id = Number(ctx.match[1]);
  db.prepare("UPDATE users SET rol='ishchi' WHERE id=?").run(id);
  await ctx.answerCbQuery('Tasdiqlandi');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Tasdiqlandi');
  await notify([id], '✅ Siz tasdiqlandingiz. /start ni bosing.');
}));
bot.action(/^X:(\d+)$/, adminOnly(async (ctx) => {
  const id = Number(ctx.match[1]);
  db.prepare("UPDATE users SET rol='rad' WHERE id=?").run(id);
  await ctx.answerCbQuery('Rad etildi');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ Rad etildi');
}));

bot.command('ishchilar', adminOnly((ctx) => {
  const w = db.prepare("SELECT id, ism FROM users WHERE rol='ishchi'").all();
  if (!w.length) return ctx.reply('Hozircha ishchi yo\'q.');
  ctx.reply(
    `Ishchilar (${w.length}). Olib tashlash uchun bosing:`,
    Markup.inlineKeyboard(w.map((x) => [Markup.button.callback(`❌ ${x.ism}`, `DEL:${x.id}`)]))
  );
}));
bot.action(/^DEL:(\d+)$/, adminOnly(async (ctx) => {
  db.prepare("UPDATE users SET rol='rad' WHERE id=? AND rol='ishchi'").run(Number(ctx.match[1]));
  await ctx.answerCbQuery('Olib tashlandi');
  await ctx.editMessageText('Ishchi olib tashlandi. /ishchilar');
}));

// ---------- Birka qo'shish va ishchilarga xabar ----------
async function qosh(items) {
  const p = db.prepare('SELECT COALESCE(MAX(partiya),0)+1 n FROM birka').get().n;
  const ins = db.prepare(
    'INSERT OR IGNORE INTO birka(raqam,rang,tur,partiya,qoshilgan) VALUES(?,?,?,?,?)'
  );
  let yangi = 0;
  db.transaction(() => {
    for (const it of items) yangi += ins.run(it.raqam, it.rang, it.tur, p, now()).changes;
  })();
  if (!yangi) return { yangi: 0, p: null, sum: [] };

  const sum = db
    .prepare('SELECT tur, rang, COUNT(*) n FROM birka WHERE partiya=? GROUP BY tur, rang')
    .all(p);
  await notify(
    idsOf('ishchi'),
    `🔔 Yangi vazifa (#${p}): ${yangi} ta birka chiqarish kerak\n\n${lines(sum)}`,
    Markup.inlineKeyboard([[Markup.button.callback('📋 Ko\'rish', 'OPEN')]])
  );
  return { yangi, p, sum };
}

async function qoshVaXabar(ctx, items) {
  const r = await qosh(items);
  if (!r.yangi) return ctx.reply('Yangi birka qo\'shilmadi (hammasi oldin bor edi).');
  return ctx.reply(
    `✅ Partiya #${r.p} qo'shildi: ${r.yangi} ta birka\n\n${lines(r.sum)}\n\nIshchilarga xabar yuborildi.`
  );
}

// Excel orqali
bot.on('document', adminOnly(async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.file_name || !doc.file_name.toLowerCase().endsWith('.xlsx')) {
    return ctx.reply('Iltimos, .xlsx (Excel) fayl yuboring.');
  }
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const buf = Buffer.from(await (await fetch(link.href)).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];

    const head = {};
    ws.getRow(1).eachCell((c, i) => (head[String(c.text).trim().toLowerCase()] = i));
    const iR = head['birka'] || head['raqam'] || head['nomer'];
    const iC = head['rang'];
    const iT = head['tur'];
    if (!iR || !iC || !iT) return ctx.reply('Sarlavha topilmadi. Ustunlar: Birka | Rang | Tur');

    const items = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const raqam = String(row.getCell(iR).text || '').trim();
      if (raqam) items.push({ raqam, rang: cap(row.getCell(iC).text), tur: cap(row.getCell(iT).text) });
    });
    await qoshVaXabar(ctx, items);
  } catch (e) {
    console.error(e);
    ctx.reply('Faylni o\'qishda xato bo\'ldi.');
  }
}));

// Yozib qo'shish: /qosh Qo'y Sariq 1001-1050
bot.command('qosh', adminOnly((ctx) => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const m = parts.length >= 3 && parts[parts.length - 1].match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return ctx.reply('Format: /qosh Qo\'y Sariq 1001-1050\nyoki: /qosh Mol Ko\'k 2001');
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (to < from || to - from > 5000) return ctx.reply('Oraliq noto\'g\'ri (eng ko\'pi 5000 ta).');
  const tur = cap(parts[0]);
  const rang = cap(parts.slice(1, -1).join(' '));
  const items = [];
  for (let i = from; i <= to; i++) items.push({ raqam: String(i).padStart(m[1].length, '0'), rang, tur });
  return qoshVaXabar(ctx, items);
}));

// ---------- Chiqarilmaganlarni ko'rish ----------
function qolganMenu(ctx) {
  const turlar = db
    .prepare('SELECT tur, COUNT(*) n FROM birka WHERE chiqarilgan IS NULL GROUP BY tur')
    .all();
  if (!turlar.length) return ctx.reply('Chiqarilmagan birka yo\'q 🎉');
  return ctx.reply(
    'Turini tanlang:',
    Markup.inlineKeyboard(turlar.map((t) => [Markup.button.callback(`${t.tur} (${t.n})`, `T:${t.tur}`)]))
  );
}
bot.command('qolgan', qolganMenu);
bot.action('OPEN', async (ctx) => {
  await ctx.answerCbQuery();
  return qolganMenu(ctx);
});

bot.action(/^T:(.+)$/, async (ctx) => {
  const tur = ctx.match[1];
  const ranglar = db
    .prepare('SELECT rang, COUNT(*) n FROM birka WHERE chiqarilgan IS NULL AND tur=? GROUP BY rang')
    .all(tur);
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `${tur} - rangini tanlang:`,
    Markup.inlineKeyboard(ranglar.map((r) => [Markup.button.callback(`${r.rang} (${r.n})`, `R:${tur}:${r.rang}`)]))
  );
});

async function royxat(ctx, tur, rang) {
  const rows = db
    .prepare(
      `SELECT id, raqam FROM birka WHERE chiqarilgan IS NULL AND tur=? AND rang=?
       ORDER BY CAST(raqam AS INTEGER), raqam LIMIT 40`
    )
    .all(tur, rang);
  const jami = db
    .prepare('SELECT COUNT(*) n FROM birka WHERE chiqarilgan IS NULL AND tur=? AND rang=?')
    .get(tur, rang).n;
  try {
    if (!rows.length) return await ctx.editMessageText(`${tur} / ${rang}: hammasi chiqarilgan ✅`);
    const keys = rows.map((r) => Markup.button.callback(`✅ ${r.raqam}`, `D:${r.id}`));
    await ctx.editMessageText(
      `${tur} / ${rang}: chiqarilmagan ${jami} ta.\nChiqarilganini bosing (ro'yxatdan o'chadi):`,
      Markup.inlineKeyboard(chunk(keys, 3))
    );
  } catch (e) {
    /* "message is not modified" ni e'tiborsiz qoldiramiz */
  }
}
bot.action(/^R:([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return royxat(ctx, ctx.match[1], ctx.match[2]);
});

// ---------- Chiqarildi deb belgilash + adminga xabar ----------
const belgila = (ctx, row) => markDone(row, ctx.state.user);

async function markDone(row, u) {
  db.prepare('UPDATE birka SET chiqarilgan=?, kim_id=?, kim_ism=? WHERE id=?').run(now(), u.id, u.ism, row.id);
  const others = idsOf('admin').filter((id) => id !== u.id);
  await notify(others, `✅ ${u.ism}: ${row.raqam} (${row.tur}, ${row.rang}) chiqarildi`);

  if (row.partiya) {
    const left = db
      .prepare('SELECT COUNT(*) n FROM birka WHERE partiya=? AND chiqarilgan IS NULL')
      .get(row.partiya).n;
    if (left === 0) await notify(others, `🎉 Partiya #${row.partiya} to'liq bajarildi!`);
  }
}

bot.action(/^D:(\d+)$/, async (ctx) => {
  const row = db.prepare('SELECT * FROM birka WHERE id=?').get(Number(ctx.match[1]));
  if (!row) return ctx.answerCbQuery('Topilmadi');
  if (row.chiqarilgan) {
    await ctx.answerCbQuery('Bu allaqachon chiqarilgan');
  } else {
    await belgila(ctx, row);
    await ctx.answerCbQuery('Chiqarildi ✅');
  }
  return royxat(ctx, row.tur, row.rang);
});

// ---------- Hisobotlar ----------
function bugunMatn() {
  const kun = now().slice(0, 10);
  const rows = db
    .prepare('SELECT tur, rang, COUNT(*) n FROM birka WHERE chiqarilgan LIKE ? GROUP BY tur, rang')
    .all(kun + '%');
  const kim = db
    .prepare('SELECT kim_ism, COUNT(*) n FROM birka WHERE chiqarilgan LIKE ? GROUP BY kim_ism')
    .all(kun + '%');
  const qolgan = db.prepare('SELECT COUNT(*) n FROM birka WHERE chiqarilgan IS NULL').get().n;
  const jami = rows.reduce((s, r) => s + r.n, 0);
  if (!jami) return `📅 ${kun}\nBugun birka chiqarilmadi.\nQolgan: ${qolgan} ta`;
  return (
    `📅 ${kun}\nBugun chiqarildi: ${jami} ta\n\n${lines(rows)}\n\n` +
    `👷 Ishchilar bo'yicha:\n${kim.map((k) => `• ${k.kim_ism}: ${k.n} ta`).join('\n')}\n\n` +
    `Hali qolgan: ${qolgan} ta`
  );
}
bot.command('bugun', (ctx) => ctx.reply(bugunMatn()));

bot.command('hisobot', (ctx) => {
  const rows = db
    .prepare(
      `SELECT tur, rang, COUNT(*) n, SUM(chiqarilgan IS NOT NULL) d FROM birka GROUP BY tur, rang`
    )
    .all();
  if (!rows.length) return ctx.reply('Jadval bo\'sh.');
  ctx.reply(
    '📊 Umumiy holat:\n\n' +
      rows.map((r) => `• ${r.tur} / ${r.rang}: jami ${r.n}, chiqarilgan ${r.d || 0}, qolgan ${r.n - (r.d || 0)}`).join('\n')
  );
});

bot.command('excel', async (ctx) => {
  const admin = ctx.state.user.rol === 'admin';
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Birkalar');
  ws.addRow(['Birka', 'Rang', 'Tur', 'Holat', 'Kim chiqargan', 'Vaqt', 'Partiya']);
  const q = admin
    ? 'SELECT * FROM birka ORDER BY partiya, id'
    : 'SELECT * FROM birka WHERE chiqarilgan IS NULL ORDER BY partiya, id';
  db.prepare(q).all().forEach((r) =>
    ws.addRow([r.raqam, r.rang, r.tur, r.chiqarilgan ? 'Chiqarilgan' : 'Qolgan', r.kim_ism || '', r.chiqarilgan || '', r.partiya])
  );
  const buf = await wb.xlsx.writeBuffer();
  await ctx.replyWithDocument({ source: Buffer.from(buf), filename: 'birkalar_hisobot.xlsx' });
});

// Kunlik avtomatik hisobot adminga (har kuni soat REPORT_HOUR da, default 20:00)
cron.schedule(
  `0 ${Number(process.env.REPORT_HOUR || 20)} * * *`,
  () => notify(idsOf('admin'), '📊 Kunlik hisobot\n\n' + bugunMatn()),
  { timezone: process.env.TIMEZONE || 'Asia/Tashkent' }
);

// ---------- Raqam yozib belgilash ----------
bot.on('text', async (ctx) => {
  const raqam = ctx.message.text.trim();
  const row = db.prepare('SELECT * FROM birka WHERE raqam=?').get(raqam);
  if (!row) return ctx.reply('Bunday birka jadvalda yo\'q.');
  if (row.chiqarilgan) return ctx.reply(`${raqam} oldin chiqarilgan (${row.chiqarilgan}).`);
  await belgila(ctx, row);
  ctx.reply(`✅ ${raqam} (${row.tur}, ${row.rang}) chiqarildi.`);
});

bot.catch((err) => console.error('Bot xatosi:', err));

// Brauzerdagi panel
require('./web')({ db, now, cap, qosh, markDone, bugunMatn, idsOf, notify, loginTokens });

// Telegram bot (ulanmasa sababi aniq chiqadi)
if (BOT_ON) {
  bot
    .launch({}, () => {
      console.log('✅ Telegram bot ishga tushdi');

      // Telegramdagi "Menu" tugmasi ro'yxati (buyruqlar orasida "Web panel" ko'rinadi)
      const common = [
        { command: 'qolgan', description: 'Chiqarilmagan birkalar' },
        { command: 'bugun', description: 'Bugungi hisobot' },
        { command: 'hisobot', description: 'Umumiy holat' },
        { command: 'excel', description: 'Excel hisobot' },
        { command: 'panel', description: '🌐 Web panel' },
      ];
      const adminCmds = [
        { command: 'panel', description: '🌐 Admin web panel' },
        { command: 'qosh', description: 'Birka qo\'shish (matn bilan)' },
        { command: 'ishchilar', description: 'Ishchilar ro\'yxati' },
        ...common.filter((c) => c.command !== 'panel'),
      ];
      bot.telegram.setMyCommands(common).catch(() => {});
      idsOf('admin').forEach((id) =>
        bot.telegram.setMyCommands(adminCmds, { scope: { type: 'chat', chat_id: id } }).catch(() => {})
      );
      bot.telegram
        .getMe()
        .then((me) => console.log(`🤖 Ulangan bot: @${me.username}  <- Telegramda aynan shu botga yozing`))
        .catch(() => {});
    })
    .catch((e) => {
      console.error('❌ Telegram bot ulanmadi:', e.message);
      console.error('   BOT_TOKEN to\'g\'ri ekanini va serverda internet borligini tekshiring.');
    });
}
const toxta = (sig) => {
  try { if (BOT_ON) bot.stop(sig); } catch (e) { /* bot hali ishlamagan */ }
  process.exit(0);
};
process.once('SIGINT', () => toxta('SIGINT'));
process.once('SIGTERM', () => toxta('SIGTERM'));

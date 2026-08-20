
const { Telegraf, Markup } = require('telegraf');
const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const BOT_TOKEN      = '8214220902:AAFcrsmIcGHZTIiMh0dnZ0o8uZosHHWCEyI';
const OWNER_ID       = 1669925773;
const DB_PATH        = path.join(__dirname, 'db.json');
const LOGO_PATH      = path.join(__dirname, 'media', 'logo.png');
const BOT_NAME       = 'Acamedia';
const OWNER_USERNAME = '@sofunsyabi';

// ── Pakasir QRIS ──────────────────────────────────────────────
const PAKASIR_SLUG   = 'acamedia';
const PAKASIR_APIKEY = 'ZU0JBrZtUZSqI8nAqz73zbtgJFtj0tY5';
const QRIS_EXPIRED_MENIT = 5; // menit sampai QRIS kadaluarsa

// ── Hitung nominal + biaya admin Pakasir (0.7% + Rp340) ───────
function hitungTotal(harga) {
  return Math.ceil(harga + 0.007 * harga + 340);
}

// ================================================================
// DATABASE
// ================================================================
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); }
  catch { return { deposits: [], items: [], orders: [], tickets: [] }; }
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
function chunkArray(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

// ================================================================
// PAKASIR API
// ================================================================
async function createQris(amount, orderId) {
  const res = await axios.post('https://app.pakasir.com/api/transactioncreate/qris', {
    project : PAKASIR_SLUG,
    order_id: orderId,
    amount,
    api_key : PAKASIR_APIKEY,
  });
  return res.data.payment; // { order_id, payment_number, expired_at, total_payment, ... }
}

async function checkQrisStatus(orderId, amount) {
  try {
    const res = await axios.get('https://app.pakasir.com/api/transactiondetail', {
      params: { project: PAKASIR_SLUG, amount, order_id: orderId, api_key: PAKASIR_APIKEY }
    });
    return res.data.transaction; // { status: 'completed'|'pending'|... }
  } catch { return null; }
}

function qrisImageUrl(paymentNumber) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=750x750&data=${encodeURIComponent(paymentNumber)}&qzone=4&format=gif&bgcolor=576A8F&color=FFF8DE`;
}

// ================================================================
// SESSION
// ================================================================
const sessions = {};
const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    timeout: 30000 // Memperpanjang batas waktu koneksi ke 30 detik
  }
});

bot.use((ctx, next) => {
  const from = ctx.from;
  if (from) {
    const u   = from.username || from.first_name || '?';
    const act = ctx.message?.text || ctx.callbackQuery?.data || 'other';
    console.log(`[${new Date().toISOString()}] @${u}(${from.id}) -> ${act}`);
  }
  return next();
});

// ================================================================
// HELPER: HOME
// ================================================================
async function sendHome(ctx) {
  const uname = ctx.from?.username || ctx.from?.first_name || 'User';
  const caption =
    `👋 *Selamat datang di ${BOT_NAME}!*\n` +
    `Halo, *${uname}*! 🎉\n\n` +
    `📌 *Produk tersedia:*\n` +
    `• 🏢 Bermassa (Akun bersama)\n• 💎 Topup Game\n• 📱 Topup Pulsa / Kuota\n\n` +
    `💳 *Pembayaran:* Pakasir QRIS (otomatis)\n` +
    `👤 *Owner:* ${OWNER_USERNAME}\n\n` +
    `_Pilih menu di bawah ini:_`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('📦 Buka Katalog (2×7)', 'page_1')],
    [
      Markup.button.callback('💰 Deposit Saldo', 'deposit_menu'),
    ],
    [
      Markup.button.callback('📊 History Deposit', 'history_deposit'),
      Markup.button.callback('📜 History Order',   'history_order'),
    ],
    [
      Markup.button.callback('🎫 Tiket Support', 'support_ticket'),
      Markup.button.callback('ℹ️ Info Bot',      'info_bot'),
    ],
  ]);

  try { await ctx.deleteMessage(); } catch (_) {}
  try {
    await ctx.replyWithPhoto({ source: LOGO_PATH }, { caption, parse_mode: 'Markdown', ...kb });
  } catch {
    await ctx.reply(caption, { parse_mode: 'Markdown', ...kb });
  }
}

// ================================================================
// KATALOG
// ================================================================
function buildCatalog(page = 1) {
  const db = readDB();
  const PER = 14, total = db.items.length;
  const totalPages = Math.ceil(total / PER) || 1;
  const cur   = Math.max(1, Math.min(page, totalPages));
  const slice = db.items.slice((cur - 1) * PER, cur * PER);

  if (!total) return {
    text : '📭 Belum ada item di katalog.',
    extra: Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'go_home')]]),
  };

  const btns = slice.map(item => {
    const dot  = item.stock > 0 ? '🟢' : '🔴';
    const cat  = item.category === 'Topup Game' ? '💎' : item.category === 'Topup Pulsa' ? '📱' : '🏢';
    const xtra = item.category === 'Bermassa' ? item.waktu : item.count;
    let lbl = `${cat}${dot} ${item.name}`;
    if (xtra) lbl += ` | ${xtra}`;
    if (lbl.length > 64) lbl = lbl.substring(0, 61) + '...';
    return Markup.button.callback(lbl, `detail_${item.id}_${cur}`);
  });

  const grid = chunkArray(btns, 2);
  const nav  = [];
  if (cur > 1)          nav.push(Markup.button.callback('⬅️ Prev', `page_${cur - 1}`));
  nav.push(Markup.button.callback(`📄 ${cur}/${totalPages}`, 'noop'));
  if (cur < totalPages) nav.push(Markup.button.callback('Next ➡️', `page_${cur + 1}`));
  if (nav.length) grid.push(nav);
  grid.push([Markup.button.callback('🔄 Refresh', `page_${cur}`), Markup.button.callback('➕ Tambah', 'help_add')]);
  grid.push([Markup.button.callback('🏠 Home', 'go_home')]);

  return {
    text :
      `🛍️ *KATALOG ${BOT_NAME}*\n` +
      `Hal. *${cur}/${totalPages}* — Total: *${total}* item\n\n` +
      `💎=Game  📱=Pulsa  🏢=Bermassa  🟢=Ada  🔴=Habis\n\nPilih produk:`,
    extra: { parse_mode: 'Markdown', ...Markup.inlineKeyboard(grid) },
  };
}

// ================================================================
// EDIT HELPER (caption atau text)
// ================================================================
async function editMsg(ctx, txt, kb) {
  try { await ctx.editMessageCaption(txt, { parse_mode: 'Markdown', ...kb }); }
  catch { await ctx.editMessageText(txt,  { parse_mode: 'Markdown', ...kb }).catch(() => {}); }
}

// ================================================================
// START / HOME
// ================================================================
bot.start(async (ctx) => sendHome(ctx));
bot.command('ping', (ctx) => ctx.reply('🏓 Pong!'));

bot.action('go_home', async (ctx) => { await ctx.answerCbQuery(); await sendHome(ctx); });
bot.action('noop',    (ctx) => ctx.answerCbQuery());

// ================================================================
// INFO BOT
// ================================================================
bot.action('info_bot', async (ctx) => {
  await ctx.answerCbQuery();
  await editMsg(ctx,
    `🤖 *${BOT_NAME}*\n${'─'.repeat(25)}\n\n` +
    `📌 Bot katalog & topup produk digital.\n\n` +
    `💳 *Pembayaran:* Pakasir QRIS (otomatis)\n` +
    `👤 *Owner:* ${OWNER_USERNAME}\n🔖 *Versi:* 3.0.0  ⚡ Online`,
    Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'go_home')]])
  );
});

// ================================================================
// KATALOG NAVIGASI
// ================================================================
bot.action(/^page_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const cat = buildCatalog(Number(ctx.match[1]));
  await editMsg(ctx, cat.text, cat.extra);
});

// ================================================================
// DETAIL PRODUK
// ================================================================
bot.action(/^detail_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const itemId   = Number(ctx.match[1]);
  const fromPage = Number(ctx.match[2]);
  const item     = readDB().items.find(i => i.id === itemId);
  if (!item) return ctx.reply('⚠️ Item tidak ditemukan.');

  const catE  = item.category === 'Topup Game' ? '💎' : item.category === 'Topup Pulsa' ? '📱' : '🏢';
  const badge = item.stock > 0 ? '🟢 Tersedia' : '🔴 Habis';
  let xtraLine = '';
  if (item.category === 'Bermassa' && item.waktu) xtraLine = `⏳ *Durasi:* ${item.waktu}\n`;
  else if (item.count) xtraLine = `🔢 *Jumlah:* ${item.count}\n`;

  const total = hitungTotal(item.price);

  const txt =
    `📦 *DETAIL PRODUK*\n${'─'.repeat(25)}\n` +
    `🆔 *ID:* \`${item.id}\`\n` +
    `🏷️ *Nama:* ${item.name}\n` +
    `📁 *Kategori:* ${catE} ${item.category}\n` +
    xtraLine +
    `💰 *Harga:* Rp${item.price.toLocaleString('id-ID')}\n` +
    `💳 *Total Bayar (QRIS):* Rp${total.toLocaleString('id-ID')}\n` +
    `📊 *Stok:* ${item.stock} (${badge})\n` +
    `${'─'.repeat(25)}\n📝 *Deskripsi:*\n_${item.description}_`;

  const btns = [];
  btns.push([item.stock > 0
    ? Markup.button.callback('🛒 Beli via QRIS', `buy_${item.id}_${fromPage}`)
    : Markup.button.callback('❌ Stok Habis', 'noop')]);
  if (ctx.from.id === OWNER_ID) {
    btns.push([
      Markup.button.callback('✏️ Edit',  `help_edit_${item.id}`),
      Markup.button.callback('🗑️ Hapus', `confirm_delete_${item.id}_${fromPage}`),
    ]);
  }
  btns.push([
    Markup.button.callback('⬅️ Katalog', `page_${fromPage}`),
    Markup.button.callback('🏠 Home',    'go_home'),
  ]);

  await editMsg(ctx, txt, Markup.inlineKeyboard(btns));
});

// ================================================================
// ██████╗  ██████╗ ██████╗ ██████╗ ███████╗██████╗
// ██╔══██╗██╔═══██╗╚════██╗╚════██╗██╔════╝██╔══██╗
// ██████╔╝██║   ██║ █████╔╝ █████╔╝█████╗  ██████╔╝
// ██╔══██╗██║   ██║██╔═══╝  ╚═══██╗██╔══╝  ██╔══██╗
// ██║  ██║╚██████╔╝███████╗██████╔╝███████╗██║  ██║
// ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═════╝ ╚══════╝╚═╝  ╚═╝
// QRIS untuk BELI ITEM
// ================================================================
bot.action(/^buy_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const itemId   = Number(ctx.match[1]);
  const fromPage = Number(ctx.match[2]);
  const userId   = ctx.from.id;
  const db       = readDB();
  const item     = db.items.find(i => i.id === itemId);

  if (!item)           return ctx.reply('⚠️ Item tidak ditemukan.');
  if (item.stock <= 0) return ctx.reply('❌ Stok habis.');

  const orderId    = `ORD-${Date.now()}-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
  const totalBayar = hitungTotal(item.price);

  // Kirim pesan "membuat QRIS..."
  let loadMsg;
  try {
    loadMsg = await ctx.reply('⏳ Membuat QRIS, mohon tunggu...');
  } catch (_) {}

  let qrisData;
  try {
    qrisData = await createQris(totalBayar, orderId);
  } catch (e) {
    if (loadMsg) ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    return ctx.reply(`❌ Gagal membuat QRIS: ${e.message}`);
  }

  if (loadMsg) ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});

  // Hitung waktu expired
  const expiredAt = new Date();
  expiredAt.setMinutes(expiredAt.getMinutes() + QRIS_EXPIRED_MENIT);

  const expStr = expiredAt.toLocaleTimeString('id-ID', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta'
  });

  const caption =
    `💳 *PEMBAYARAN QRIS*\n${'─'.repeat(25)}\n\n` +
    `📦 *Produk:* ${item.name}\n` +
    `💰 *Total Bayar:* Rp${totalBayar.toLocaleString('id-ID')}\n` +
    `📋 *Order ID:* \`${orderId}\`\n` +
    `⏳ *Expired:* ${expStr} WIB (${QRIS_EXPIRED_MENIT} menit)\n\n` +
    `*Scan QR di atas* menggunakan aplikasi e-wallet / m-banking Anda.\n` +
    `_Bayar tepat sesuai nominal agar terdeteksi otomatis._`;

  // Kirim gambar QR
  let qrMsg;
  try {
    qrMsg = await ctx.replyWithPhoto(
      { url: qrisImageUrl(qrisData.payment_number) },
      {
        caption,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Batalkan', `cancel_order_${orderId}`)],
        ]),
      }
    );
  } catch (e) {
    return ctx.reply(`❌ Gagal kirim QR: ${e.message}`);
  }

  // Simpan tracking di session
  sessions[`order_${orderId}`] = {
    type      : 'pending_order',
    userId,
    itemId,
    fromPage,
    orderId,
    totalBayar,
    qrMsgId   : qrMsg.message_id,
    chatId    : ctx.chat.id,
    expiredAt : expiredAt.getTime(),
  };

  // ── Polling cek status ──────────────────────────────────────
  const pollInterval = setInterval(async () => {
    const trx = sessions[`order_${orderId}`];
    if (!trx) { clearInterval(pollInterval); return; } // dibatalkan

    // Cek expired
    if (Date.now() >= trx.expiredAt) {
      clearInterval(pollInterval);
      delete sessions[`order_${orderId}`];
      ctx.telegram.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => {});
      ctx.telegram.sendMessage(trx.chatId,
        `⏰ *QRIS Expired*\nOrder \`${orderId}\` sudah kadaluarsa.\nSilakan beli ulang.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      return;
    }

    // Cek status
    const res = await checkQrisStatus(orderId, totalBayar);
    if (res && res.status === 'completed') {
      clearInterval(pollInterval);
      delete sessions[`order_${orderId}`];

      // Update DB: kurangi stok, catat order
      const db2 = readDB();
      const it  = db2.items.find(i => i.id === itemId);
      if (it) {
        it.stock -= 1;
        if (it.stock <= 0) it.status = 'Habis';
      }
      if (!db2.orders) db2.orders = [];
      db2.orders.push({
        userId,
        itemId,
        itemName : item.name,
        category : item.category,
        price    : item.price,
        totalBayar,
        orderId,
        timestamp: Date.now(),
      });
      writeDB(db2);

      // Hapus pesan QR
      ctx.telegram.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => {});

      // Notif sukses ke user
      const uname = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
      ctx.telegram.sendMessage(trx.chatId,
        `✅ *PEMBAYARAN BERHASIL!*\n${'─'.repeat(25)}\n\n` +
        `📦 *Produk:* ${item.name}\n` +
        `💰 *Dibayar:* Rp${totalBayar.toLocaleString('id-ID')}\n` +
        `📋 *Order ID:* \`${orderId}\`\n\n` +
        `Hubungi ${OWNER_USERNAME} untuk proses pengiriman produk.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📜 History Order', 'history_order')],
            [Markup.button.callback('🏠 Home', 'go_home')],
          ]),
        }
      ).catch(() => {});

      // Notif ke owner
      ctx.telegram.sendMessage(OWNER_ID,
        `🛒 *PESANAN BARU (LUNAS)*\n${'─'.repeat(20)}\n` +
        `👤 User: ${uname} (${userId})\n` +
        `📦 ${item.name}\n` +
        `💰 Rp${totalBayar.toLocaleString('id-ID')}\n` +
        `📋 Order: \`${orderId}\`\n` +
        `📊 Sisa stok: ${item.stock - 1}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  }, 5000); // cek tiap 5 detik
});

// Batalkan order
bot.action(/^cancel_order_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('❌ Order dibatalkan');
  const orderId = ctx.match[1];
  delete sessions[`order_${orderId}`];
  try { await ctx.deleteMessage(); } catch (_) {}
  await ctx.reply('❌ Order dibatalkan.', {
    ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'go_home')]]),
  });
});

// ================================================================
// ██████╗ ███████╗██████╗  ██████╗ ███████╗██╗████████╗
// ██╔══██╗██╔════╝██╔══██╗██╔═══██╗██╔════╝██║╚══██╔══╝
// ██║  ██║█████╗  ██████╔╝██║   ██║███████╗██║   ██║
// ██║  ██║██╔══╝  ██╔═══╝ ██║   ██║╚════██║██║   ██║
// ██████╔╝███████╗██║     ╚██████╔╝███████║██║   ██║
// ╚═════╝ ╚══════╝╚═╝      ╚═════╝ ╚══════╝╚═╝   ╚═╝
// DEPOSIT SALDO via QRIS
// ================================================================
bot.action('deposit_menu', async (ctx) => {
  await ctx.answerCbQuery();

  await editMsg(ctx,
    `💰 *DEPOSIT SALDO*\n${'─'.repeat(25)}\n\n` +
    `Pilih nominal deposit:\n\n` +
    `_Biaya admin Pakasir (0.7% + Rp340) sudah termasuk dalam total bayar._`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Rp10.000',  'dep_10000'),
        Markup.button.callback('Rp20.000',  'dep_20000'),
        Markup.button.callback('Rp50.000',  'dep_50000'),
      ],
      [
        Markup.button.callback('Rp100.000', 'dep_100000'),
        Markup.button.callback('Rp200.000', 'dep_200000'),
        Markup.button.callback('Rp500.000', 'dep_500000'),
      ],
      [Markup.button.callback('✏️ Nominal Lain', 'dep_custom')],
      [Markup.button.callback('🏠 Home', 'go_home')],
    ])
  );
});

// Nominal preset
for (const nominal of [10000, 20000, 50000, 100000, 200000, 500000]) {
  bot.action(`dep_${nominal}`, async (ctx) => {
    await ctx.answerCbQuery();
    await prosesDeposit(ctx, nominal);
  });
}

// Nominal custom — masuk ke session
bot.action('dep_custom', async (ctx) => {
  await ctx.answerCbQuery();
  sessions[ctx.from.id] = { type: 'deposit_custom' };
  await editMsg(ctx,
    `✏️ *Nominal Custom*\n\nKirim nominal deposit (min Rp10.000):\nContoh: `+"`50000`",
    Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'deposit_menu')]])
  );
});

// ── Fungsi utama buat QRIS deposit ────────────────────────────
async function prosesDeposit(ctx, nominal) {
  if (nominal < 10000) return ctx.reply('❌ Minimal deposit Rp10.000');
  const userId     = ctx.from.id;
  const orderId    = `DEP-${Date.now()}-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
  const totalBayar = hitungTotal(nominal);

  let loadMsg;
  try { loadMsg = await ctx.reply('⏳ Membuat QRIS deposit, tunggu sebentar...'); } catch (_) {}

  let qrisData;
  try {
    qrisData = await createQris(totalBayar, orderId);
  } catch (e) {
    if (loadMsg) ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
    return ctx.reply(`❌ Gagal buat QRIS: ${e.message}`);
  }

  if (loadMsg) ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});

  const expiredAt = new Date();
  expiredAt.setMinutes(expiredAt.getMinutes() + QRIS_EXPIRED_MENIT);
  const expStr = expiredAt.toLocaleTimeString('id-ID', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta'
  });

  // Simpan ke DB sebagai pending
  const db = readDB();
  if (!db.deposits) db.deposits = [];
  db.deposits.push({
    id       : orderId,
    userId,
    nominal,
    totalBayar,
    status   : 'Pending',
    timestamp: Date.now(),
  });
  writeDB(db);

  const caption =
    `💳 *DEPOSIT QRIS*\n${'─'.repeat(25)}\n\n` +
    `💵 *Nominal Deposit:* Rp${nominal.toLocaleString('id-ID')}\n` +
    `💰 *Total Bayar:* Rp${totalBayar.toLocaleString('id-ID')}\n` +
    `📋 *Order ID:* \`${orderId}\`\n` +
    `⏳ *Expired:* ${expStr} WIB (${QRIS_EXPIRED_MENIT} menit)\n\n` +
    `*Scan QR di atas* dan bayar tepat sesuai nominal.\n` +
    `_Saldo akan otomatis masuk setelah pembayaran terdeteksi._`;

  let qrMsg;
  try {
    qrMsg = await ctx.replyWithPhoto(
      { url: qrisImageUrl(qrisData.payment_number) },
      {
        caption,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Batalkan', `cancel_dep_${orderId}`)],
        ]),
      }
    );
  } catch (e) {
    return ctx.reply(`❌ Gagal kirim QR: ${e.message}`);
  }

  // Track di session
  sessions[`dep_${orderId}`] = {
    type     : 'pending_deposit',
    userId,
    nominal,
    orderId,
    totalBayar,
    qrMsgId  : qrMsg.message_id,
    chatId   : ctx.chat.id,
    expiredAt: expiredAt.getTime(),
  };

  // Polling
  const pollInterval = setInterval(async () => {
    const trx = sessions[`dep_${orderId}`];
    if (!trx) { clearInterval(pollInterval); return; }

    if (Date.now() >= trx.expiredAt) {
      clearInterval(pollInterval);
      delete sessions[`dep_${orderId}`];
      // Update status DB jadi Expired
      const db2 = readDB();
      const dep  = db2.deposits?.find(d => d.id === orderId);
      if (dep) dep.status = 'Expired';
      writeDB(db2);
      ctx.telegram.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => {});
      ctx.telegram.sendMessage(trx.chatId,
        `⏰ *QRIS Deposit Expired*\nOrder \`${orderId}\` sudah kadaluarsa.\nSilakan buat deposit baru.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      return;
    }

    const res = await checkQrisStatus(orderId, totalBayar);
    if (res && res.status === 'completed') {
      clearInterval(pollInterval);
      delete sessions[`dep_${orderId}`];

      // Update status DB jadi Lunas
      const db2 = readDB();
      const dep  = db2.deposits?.find(d => d.id === orderId);
      if (dep) dep.status = 'Lunas';
      writeDB(db2);

      ctx.telegram.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => {});

      const uname = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

      ctx.telegram.sendMessage(trx.chatId,
        `✅ *DEPOSIT BERHASIL!*\n${'─'.repeat(25)}\n\n` +
        `💵 *Nominal:* Rp${nominal.toLocaleString('id-ID')}\n` +
        `💰 *Dibayar:* Rp${totalBayar.toLocaleString('id-ID')}\n` +
        `📋 *Order ID:* \`${orderId}\`\n\n` +
        `Saldo deposit Anda telah dicatat. 🎉`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📊 History Deposit', 'history_deposit')],
            [Markup.button.callback('🏠 Home', 'go_home')],
          ]),
        }
      ).catch(() => {});

      // Notif owner
      ctx.telegram.sendMessage(OWNER_ID,
        `💰 *DEPOSIT MASUK (LUNAS)*\n` +
        `👤 ${uname} (${userId})\n` +
        `💵 Rp${nominal.toLocaleString('id-ID')}\n` +
        `💰 Dibayar: Rp${totalBayar.toLocaleString('id-ID')}\n` +
        `📋 \`${orderId}\``,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  }, 5000);
}

// Batalkan deposit
bot.action(/^cancel_dep_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('❌ Deposit dibatalkan');
  const orderId = ctx.match[1];
  delete sessions[`dep_${orderId}`];
  // Update DB jadi Cancelled
  const db  = readDB();
  const dep = db.deposits?.find(d => d.id === orderId);
  if (dep) dep.status = 'Cancelled';
  writeDB(db);
  try { await ctx.deleteMessage(); } catch (_) {}
  await ctx.reply('❌ Deposit dibatalkan.', {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💰 Deposit Lagi', 'deposit_menu')],
      [Markup.button.callback('🏠 Home', 'go_home')],
    ]),
  });
});

// ================================================================
// HISTORY
// ================================================================
bot.action('history_order', async (ctx) => {
  await ctx.answerCbQuery();
  const db     = readDB();
  const orders = (db.orders || []).filter(o => o.userId === ctx.from.id);
  const kb     = Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'go_home')]]);

  let txt;
  if (!orders.length) {
    txt = '📭 *Belum ada order.*\n\nBelum pernah melakukan pembelian.';
  } else {
    txt = `📜 *History Order*\n${'─'.repeat(25)}\n`;
    orders.slice(-10).reverse().forEach((o, i) => {
      const e  = o.category === 'Topup Game' ? '💎' : o.category === 'Topup Pulsa' ? '📱' : '🏢';
      const dt = new Date(o.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      txt += `\n${i+1}. ${e} *${o.itemName}*\n` +
             `   💰 Rp${o.price.toLocaleString('id-ID')} • ${dt}\n` +
             `   📋 \`${o.orderId || '-'}\`\n`;
    });
    txt += `\n_${Math.min(10, orders.length)} dari ${orders.length} order_`;
  }
  await editMsg(ctx, txt, kb);
});

bot.action('history_deposit', async (ctx) => {
  await ctx.answerCbQuery();
  const db   = readDB();
  const deps = (db.deposits || []).filter(d => d.userId === ctx.from.id);
  const kb   = Markup.inlineKeyboard([
    [Markup.button.callback('💰 Deposit Baru', 'deposit_menu')],
    [Markup.button.callback('🏠 Home', 'go_home')],
  ]);

  let txt;
  if (!deps.length) {
    txt = '📭 *Belum ada deposit.*\n\nTekan tombol di bawah untuk deposit pertama Anda.';
  } else {
    txt = `📊 *History Deposit*\n${'─'.repeat(25)}\n`;
    deps.slice(-10).reverse().forEach((d, i) => {
      const e  = d.status === 'Lunas' ? '✅' : d.status === 'Expired' ? '⏰' : d.status === 'Cancelled' ? '❌' : '⏳';
      const dt = new Date(d.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      txt += `\n${i+1}. ${e} *Rp${d.nominal.toLocaleString('id-ID')}*\n` +
             `   Status: *${d.status}* • ${dt}\n`;
    });
    txt += `\n_${Math.min(10, deps.length)} dari ${deps.length} deposit_`;
  }
  await editMsg(ctx, txt, kb);
});

// ================================================================
// TIKET SUPPORT
// ================================================================
bot.action('support_ticket', async (ctx) => {
  await ctx.answerCbQuery();
  sessions[ctx.from.id] = { type: 'ticket', active: true };
  await editMsg(ctx,
    `🎫 *Tiket Support ${BOT_NAME}*\n${'─'.repeat(25)}\n\n` +
    `Kirim pesan Anda sekarang.\n` +
    `Pesan diteruskan ke admin secara *anonim*.\n\n` +
    `_Ketik /endticket untuk menutup tiket_`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔒 Tutup Tiket', 'close_ticket')],
      [Markup.button.callback('🏠 Home', 'go_home')],
    ])
  );
});

bot.action('close_ticket', async (ctx) => {
  await ctx.answerCbQuery();
  delete sessions[ctx.from.id];
  await ctx.reply('🔒 Tiket ditutup. Terima kasih!');
  await sendHome(ctx);
});

// ================================================================
// SATU-SATUNYA bot.on('text')
// ================================================================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text   = ctx.message.text;
  console.log(`[TEXT] ${userId} | "${text}" | sess=${JSON.stringify(sessions[userId] || null)}`);

  // 1. Owner /reply
  if (userId === OWNER_ID && text.startsWith('/reply ')) {
    const parts    = text.split(' ');
    const targetId = Number(parts[1]);
    const msg      = parts.slice(2).join(' ');
    if (!targetId || !msg) return ctx.reply('Format: /reply [user_id] [pesan]');
    try {
      await ctx.telegram.sendMessage(targetId, `📩 *Balasan Admin ${BOT_NAME}:*\n\n${msg}`, { parse_mode: 'Markdown' });
      return ctx.reply(`✅ Terkirim ke ${targetId}`);
    } catch (e) { return ctx.reply(`❌ Gagal: ${e.message}`); }
  }

  const sess = sessions[userId];

  // 2. Tiket support
  if (sess?.type === 'ticket' && sess.active) {
    if (text === '/endticket') { delete sessions[userId]; return ctx.reply('🔒 Tiket ditutup.'); }
    const uname = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    try {
      await ctx.telegram.sendMessage(OWNER_ID,
        `🎫 *Tiket Baru*\n${'─'.repeat(20)}\n👤 ${uname} (\`${userId}\`)\n\n💬 ${text}\n\n_Balas: /reply ${userId} [pesan]_`,
        { parse_mode: 'Markdown' }
      );
      return ctx.reply('✅ Pesan terkirim ke admin. Tunggu balasan.');
    } catch { return ctx.reply('❌ Gagal kirim.'); }
  }

  // 3. Deposit custom nominal
  if (sess?.type === 'deposit_custom') {
    delete sessions[userId];
    const nominal = Number(text.replace(/[^0-9]/g, ''));
    if (isNaN(nominal) || nominal < 10000) {
      return ctx.reply('⚠️ Nominal tidak valid (min Rp10.000). Coba lagi /start lalu Deposit Saldo.');
    }
    return prosesDeposit(ctx, nominal);
  }

  // 4. Additem flow
  if (sess?.type === 'additem') {
    if (userId !== OWNER_ID) { delete sessions[userId]; return ctx.reply('⛔ Bukan owner.'); }
    if (text.startsWith('/') && !text.startsWith('/additem')) {
      delete sessions[userId];
      return ctx.reply('⛔ Sesi additem dibatalkan.');
    }
    return processAddItem(ctx, userId, text);
  }
  // Default: diam
});

// ================================================================
// ADDITEM
// ================================================================
bot.command('additem', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.reply('⛔ Hanya owner.');
  delete sessions[ctx.from.id];
  sessions[ctx.from.id] = { type: 'additem', step: 'name', data: {} };
  console.log(`[ADDITEM] Session dibuat untuk ${ctx.from.id}`);
  return ctx.reply('📝 *Tambah Item — Langkah 1/6*\n\nKirim *nama item*:\nContoh: `Zoom Pro 1 Bulan`', { parse_mode: 'Markdown' });
});

async function processAddItem(ctx, userId, text) {
  const sess = sessions[userId];
  if (!sess) return ctx.reply('⚠️ Sesi hilang. /additem');
  console.log(`[ADDITEM] step=${sess.step} text="${text}"`);

  switch (sess.step) {
    case 'name':
      sess.data.name = text; sess.step = 'category';
      return ctx.reply('📝 *Langkah 2/6: Pilih Kategori*', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🏢 Bermassa',   'add_cat_bermassa'),
            Markup.button.callback('💎 Topup Game', 'add_cat_topupgame'),
            Markup.button.callback('📱 Topup Pulsa','add_cat_topuppulsa'),
          ],
          [Markup.button.callback('❌ Batalkan', 'cancel_additem')],
        ]),
      });

    case 'extra':
      sess.data.extra = text; sess.step = 'price';
      return ctx.reply('📝 *Langkah 4/6: Harga*\n\nKirim harga (angka):\nContoh: `15000`', { parse_mode: 'Markdown' });

    case 'price': {
      const p = Number(text);
      if (isNaN(p) || p < 0) return ctx.reply('⚠️ Harus angka positif. Ulangi:');
      sess.data.price = p; sess.step = 'stock';
      return ctx.reply('📝 *Langkah 5/6: Stok*\n\nKirim jumlah stok:', { parse_mode: 'Markdown' });
    }

    case 'stock': {
      const s = Number(text);
      if (isNaN(s) || s < 0) return ctx.reply('⚠️ Harus angka positif. Ulangi:');
      sess.data.stock = s; sess.step = 'description';
      return ctx.reply('📝 *Langkah 6/6: Deskripsi*\n\nKirim deskripsi produk:', { parse_mode: 'Markdown' });
    }

    case 'description': {
      sess.data.description = text;
      const { name, category, extra, price, stock, description } = sess.data;
      if (!name || !category || price == null || stock == null || !description) {
        delete sessions[userId];
        return ctx.reply('❌ Data tidak lengkap. Mulai ulang /additem');
      }
      const newItem = { id: Date.now(), name, category, price, stock, description, status: stock > 0 ? 'Tersedia' : 'Habis' };
      if (category === 'Bermassa') newItem.waktu = extra || '-';
      else newItem.count = extra || '-';

      const db = readDB();
      if (!db.items) db.items = [];
      db.items.push(newItem);
      writeDB(db);
      delete sessions[userId];

      const total = hitungTotal(price);
      return ctx.reply(
        `✅ *Item Ditambahkan!*\n${'─'.repeat(25)}\n` +
        `🏷️ ${name} | 📁 ${category}\n` +
        `💰 Harga: Rp${price.toLocaleString('id-ID')} → QRIS: Rp${total.toLocaleString('id-ID')}\n` +
        `📊 Stok: ${stock}\n📝 ${description}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📦 Katalog', 'page_1')],
            [Markup.button.callback('➕ Tambah Lagi', 'restart_additem')],
            [Markup.button.callback('🏠 Home', 'go_home')],
          ]),
        }
      );
    }

    default:
      delete sessions[userId];
      return ctx.reply('⚠️ Sesi error. /additem');
  }
}

// Callbacks kategori (tanpa spasi)
bot.action('add_cat_bermassa', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery('✅ Bermassa');
  const sess = sessions[ctx.from.id];
  if (!sess || sess.step !== 'category') return ctx.reply('⚠️ Sesi tidak valid. /additem');
  sess.data.category = 'Bermassa'; sess.step = 'extra';
  await ctx.editMessageText('📝 *Langkah 3/6: Durasi*\n\nContoh: `1 Bulan`, `3 Hari`', { parse_mode: 'Markdown' });
});

bot.action('add_cat_topupgame', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery('✅ Topup Game');
  const sess = sessions[ctx.from.id];
  if (!sess || sess.step !== 'category') return ctx.reply('⚠️ Sesi tidak valid. /additem');
  sess.data.category = 'Topup Game'; sess.step = 'extra';
  await ctx.editMessageText('💎 *Langkah 3/6: Jumlah*\n\nContoh: `100 Diamond`, `60 UC`', { parse_mode: 'Markdown' });
});

bot.action('add_cat_topuppulsa', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery('✅ Topup Pulsa');
  const sess = sessions[ctx.from.id];
  if (!sess || sess.step !== 'category') return ctx.reply('⚠️ Sesi tidak valid. /additem');
  sess.data.category = 'Topup Pulsa'; sess.step = 'extra';
  await ctx.editMessageText('📱 *Langkah 3/6: Nominal/Kuota*\n\nContoh: `Rp100.000`, `10GB`', { parse_mode: 'Markdown' });
});

bot.action('cancel_additem', async (ctx) => {
  await ctx.answerCbQuery('❌ Dibatalkan');
  delete sessions[ctx.from.id];
  await ctx.editMessageText('❌ Tambah item dibatalkan.', {
    ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'go_home')]]),
  });
});

bot.action('restart_additem', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery();
  delete sessions[ctx.from.id];
  sessions[ctx.from.id] = { type: 'additem', step: 'name', data: {} };
  await ctx.reply('📝 *Tambah Item — Langkah 1/6*\n\nKirim *nama item*:', { parse_mode: 'Markdown' });
});

// ================================================================
// EDITITEM / HAPUS
// ================================================================
bot.command('edititem', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.reply('⛔ Hanya owner.');
  const parts = (ctx.payload || '').split('|').map(s => s.trim());
  const [idStr, name, category, extra, priceStr, stockStr, description] = parts;
  const id = Number(idStr), price = Number(priceStr), stock = Number(stockStr);
  if (!id || !name || !category || !extra || !description || isNaN(price) || isNaN(stock))
    return ctx.reply('❌ Format: `/edititem [ID] | [Nama] | [Kat] | [Field] | [Harga] | [Stok] | [Deskripsi]`', { parse_mode: 'Markdown' });
  if (!['Bermassa', 'Topup Game', 'Topup Pulsa'].includes(category)) return ctx.reply('❌ Kategori invalid.');
  const db  = readDB();
  const idx = db.items.findIndex(i => i.id === id);
  if (idx === -1) return ctx.reply('⚠️ Item tidak ditemukan.');
  const updated = { id, name, category, price, stock, description, status: stock > 0 ? 'Tersedia' : 'Habis' };
  if (category === 'Bermassa') updated.waktu = extra; else updated.count = extra;
  db.items[idx] = updated;
  writeDB(db);
  ctx.reply(`✏️ Item \`${id}\` diperbarui!`, { parse_mode: 'Markdown' });
});

bot.action('help_add', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== OWNER_ID) return ctx.reply('⛔ Hanya owner.');
  ctx.reply('📌 Ketik `/additem` dan ikuti langkah-langkah.', { parse_mode: 'Markdown' });
});

bot.action(/^help_edit_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery();
  ctx.reply(`📌 Edit \`${ctx.match[1]}\`:\n\`/edititem ${ctx.match[1]} | Nama | Kat | Field | Harga | Stok | Desc\``, { parse_mode: 'Markdown' });
});

bot.action(/^confirm_delete_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery();
  const itemId = Number(ctx.match[1]), fromPage = Number(ctx.match[2]);
  const item   = readDB().items.find(i => i.id === itemId);
  await editMsg(ctx,
    `⚠️ *Konfirmasi Hapus*\n\nHapus: *${item?.name || itemId}*?`,
    Markup.inlineKeyboard([[
      Markup.button.callback('✅ Ya Hapus', `delete_${itemId}_${fromPage}`),
      Markup.button.callback('❌ Batal',    `detail_${itemId}_${fromPage}`),
    ]])
  );
});

bot.action(/^delete_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery('🗑️ Dihapus!');
  const itemId = Number(ctx.match[1]), fromPage = Number(ctx.match[2]);
  const db = readDB();
  db.items = db.items.filter(i => i.id !== itemId);
  writeDB(db);
  const cat = buildCatalog(fromPage);
  await editMsg(ctx, cat.text, cat.extra);
});

// ================================================================
// LAUNCH
// ================================================================
bot.launch()
  .then(() => console.log(`✅ ${BOT_NAME} aktif! QRIS via Pakasir enabled.`))
  .catch(e => console.error('❌ Launch error:', e));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

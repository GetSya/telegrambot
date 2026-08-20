const TelegramBot = require('node-telegram-bot-api');
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ================================================================
// KONFIGURASI
// ================================================================
const BOT_TOKEN       = '8214220902:AAFcrsmIcGHZTIiMh0dnZ0o8uZosHHWCEyI';
const OWNER_ID        = 1669925773;
const DB_PATH        = path.join(__dirname, 'db.json');
const LOGO_PATH      = path.join(__dirname, 'media', 'logo.png');
const BOT_NAME       = 'Acamedia';
const OWNER_USERNAME = '@sofunsyabi';

// ── Pakasir QRIS ──────────────────────────────────────────────
const PAKASIR_SLUG   = 'acamedia';
const PAKASIR_APIKEY = 'ZU0JBrZtUZSqI8nAqz73zbtgJFtj0tY5';
const QRIS_EXPIRED_MENIT = 5; // menit sampai QRIS kadaluarsa

// ── (Opsional) Proxy — isi kalau perlu ──────────────────────────
// Contoh: 'http://user:pass@ip_proxy:port'
const PROXY_URL = '';

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
// INISIALISASI BOT (node-telegram-bot-api)
// ================================================================
const botOptions = { polling: true };
if (PROXY_URL) {
  // node-telegram-bot-api meneruskan opsi ini ke library `request` di baliknya.
  // Kalau kamu pakai versi terbaru yang berbasis fetch, cara paling stabil untuk proxy
  // adalah lewat env var HTTPS_PROXY sebelum menjalankan proses Node, contoh:
  //   HTTPS_PROXY=http://user:pass@ip_proxy:port node bot.js
  botOptions.request = { proxy: PROXY_URL };
}
const bot = new TelegramBot(BOT_TOKEN, botOptions);

// Session in-memory (sama seperti sebelumnya)
const sessions = {};

// ================================================================
// LOGGER (pengganti Telegraf middleware bot.use)
// ================================================================
bot.on('message', (msg) => {
  const from = msg.from;
  if (from) {
    const u   = from.username || from.first_name || '?';
    const act = msg.text || 'other';
    console.log(`[${new Date().toISOString()}] @${u}(${from.id}) -> ${act}`);
  }
});
bot.on('callback_query', (query) => {
  const from = query.from;
  if (from) {
    const u = from.username || from.first_name || '?';
    console.log(`[${new Date().toISOString()}] @${u}(${from.id}) -> ${query.data}`);
  }
});

// ================================================================
// KEYBOARD HELPERS (pengganti Markup dari Telegraf)
// ================================================================
function btn(text, callback_data) { return { text, callback_data }; }
function ik(rows) { return { reply_markup: { inline_keyboard: rows } }; }

// ================================================================
// HELPER: HOME
// ================================================================
async function sendHome(chatId, from, msgToDelete) {
  const uname = from?.username || from?.first_name || 'User';
  const caption =
    `👋 *Selamat datang di ${BOT_NAME}!*\n` +
    `Halo, *${uname}*! 🎉\n\n` +
    `📌 *Produk tersedia:*\n` +
    `• 🏢 Bermassa (Akun bersama)\n• 💎 Topup Game\n• 📱 Topup Pulsa / Kuota\n\n` +
    `💳 *Pembayaran:* Pakasir QRIS (otomatis)\n` +
    `👤 *Owner:* ${OWNER_USERNAME}\n\n` +
    `_Pilih menu di bawah ini:_`;

  const kb = ik([
    [btn('📦 Buka Katalog (2×7)', 'page_1')],
    [btn('💰 Deposit Saldo', 'deposit_menu')],
    [btn('📊 History Deposit', 'history_deposit'), btn('📜 History Order', 'history_order')],
    [btn('🎫 Tiket Support', 'support_ticket'), btn('ℹ️ Info Bot', 'info_bot')],
  ]);

  if (msgToDelete) {
    try { await bot.deleteMessage(chatId, msgToDelete); } catch (_) {}
  }
  try {
    await bot.sendPhoto(chatId, LOGO_PATH, { caption, parse_mode: 'Markdown', ...kb });
  } catch {
    await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', ...kb });
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
    extra: ik([[btn('🏠 Home', 'go_home')]]),
  };

  const btns = slice.map(item => {
    const dot  = item.stock > 0 ? '🟢' : '🔴';
    const cat  = item.category === 'Topup Game' ? '💎' : item.category === 'Topup Pulsa' ? '📱' : '🏢';
    const xtra = item.category === 'Bermassa' ? item.waktu : item.count;
    let lbl = `${cat}${dot} ${item.name}`;
    if (xtra) lbl += ` | ${xtra}`;
    if (lbl.length > 64) lbl = lbl.substring(0, 61) + '...';
    return btn(lbl, `detail_${item.id}_${cur}`);
  });

  const grid = chunkArray(btns, 2);
  const nav  = [];
  if (cur > 1)          nav.push(btn('⬅️ Prev', `page_${cur - 1}`));
  nav.push(btn(`📄 ${cur}/${totalPages}`, 'noop'));
  if (cur < totalPages) nav.push(btn('Next ➡️', `page_${cur + 1}`));
  if (nav.length) grid.push(nav);
  grid.push([btn('🔄 Refresh', `page_${cur}`), btn('➕ Tambah', 'help_add')]);
  grid.push([btn('🏠 Home', 'go_home')]);

  return {
    text :
      `🛍️ *KATALOG ${BOT_NAME}*\n` +
      `Hal. *${cur}/${totalPages}* — Total: *${total}* item\n\n` +
      `💎=Game  📱=Pulsa  🏢=Bermassa  🟢=Ada  🔴=Habis\n\nPilih produk:`,
    extra: ik(grid),
  };
}

// ================================================================
// EDIT HELPER (caption atau text)
// ================================================================
async function editMsg(chatId, messageId, txt, extra) {
  const opts = { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', ...(extra || {}) };
  try {
    await bot.editMessageCaption(txt, opts);
  } catch {
    try { await bot.editMessageText(txt, opts); } catch (_) {}
  }
}

// ================================================================
// START / COMMANDS
// ================================================================
bot.onText(/^\/start$/, (msg) => sendHome(msg.chat.id, msg.from));
bot.onText(/^\/ping$/, (msg) => bot.sendMessage(msg.chat.id, '🏓 Pong!'));

// ================================================================
// ADDITEM (command)
// ================================================================
bot.onText(/^\/additem$/, (msg) => {
  if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, '⛔ Hanya owner.');
  const userId = msg.from.id;
  delete sessions[userId];
  sessions[userId] = { type: 'additem', step: 'name', data: {} };
  console.log(`[ADDITEM] Session dibuat untuk ${userId}`);
  return bot.sendMessage(msg.chat.id, '📝 *Tambah Item — Langkah 1/6*\n\nKirim *nama item*:\nContoh: `Zoom Pro 1 Bulan`', { parse_mode: 'Markdown' });
});

// ================================================================
// EDITITEM (command)
// ================================================================
bot.onText(/^\/edititem(?:\s+([\s\S]*))?$/, (msg, match) => {
  if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, '⛔ Hanya owner.');
  const payload = match[1] || '';
  const parts = payload.split('|').map(s => s.trim());
  const [idStr, name, category, extra, priceStr, stockStr, description] = parts;
  const id = Number(idStr), price = Number(priceStr), stock = Number(stockStr);
  if (!id || !name || !category || !extra || !description || isNaN(price) || isNaN(stock))
    return bot.sendMessage(msg.chat.id, '❌ Format: `/edititem [ID] | [Nama] | [Kat] | [Field] | [Harga] | [Stok] | [Deskripsi]`', { parse_mode: 'Markdown' });
  if (!['Bermassa', 'Topup Game', 'Topup Pulsa'].includes(category)) return bot.sendMessage(msg.chat.id, '❌ Kategori invalid.');
  const db  = readDB();
  const idx = db.items.findIndex(i => i.id === id);
  if (idx === -1) return bot.sendMessage(msg.chat.id, '⚠️ Item tidak ditemukan.');
  const updated = { id, name, category, price, stock, description, status: stock > 0 ? 'Tersedia' : 'Habis' };
  if (category === 'Bermassa') updated.waktu = extra; else updated.count = extra;
  db.items[idx] = updated;
  writeDB(db);
  bot.sendMessage(msg.chat.id, `✏️ Item \`${id}\` diperbarui!`, { parse_mode: 'Markdown' });
});

// Owner /reply, ticket, deposit custom, additem flow — ditangani di handler 'message' generik di bawah.

// ================================================================
// PROSES DEPOSIT (dipakai oleh callback & text handler)
// ================================================================
async function prosesDeposit(chatId, from, nominal) {
  if (nominal < 10000) return bot.sendMessage(chatId, '❌ Minimal deposit Rp10.000');
  const userId     = from.id;
  const orderId    = `DEP-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const totalBayar = hitungTotal(nominal);

  let loadMsg;
  try { loadMsg = await bot.sendMessage(chatId, '⏳ Membuat QRIS deposit, tunggu sebentar...'); } catch (_) {}

  let qrisData;
  try {
    qrisData = await createQris(totalBayar, orderId);
  } catch (e) {
    if (loadMsg) bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
    return bot.sendMessage(chatId, `❌ Gagal buat QRIS: ${e.message}`);
  }

  if (loadMsg) bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});

  const expiredAt = new Date();
  expiredAt.setMinutes(expiredAt.getMinutes() + QRIS_EXPIRED_MENIT);
  const expStr = expiredAt.toLocaleTimeString('id-ID', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta'
  });

  const db = readDB();
  if (!db.deposits) db.deposits = [];
  db.deposits.push({
    id: orderId, userId, nominal, totalBayar, status: 'Pending', timestamp: Date.now(),
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
    qrMsg = await bot.sendPhoto(chatId, qrisImageUrl(qrisData.payment_number), {
      caption, parse_mode: 'Markdown',
      ...ik([[btn('❌ Batalkan', `cancel_dep_${orderId}`)]]),
    });
  } catch (e) {
    return bot.sendMessage(chatId, `❌ Gagal kirim QR: ${e.message}`);
  }

  sessions[`dep_${orderId}`] = {
    type: 'pending_deposit', userId, nominal, orderId, totalBayar,
    qrMsgId: qrMsg.message_id, chatId, expiredAt: expiredAt.getTime(),
  };

  const pollInterval = setInterval(async () => {
    const trx = sessions[`dep_${orderId}`];
    if (!trx) { clearInterval(pollInterval); return; }

    if (Date.now() >= trx.expiredAt) {
      clearInterval(pollInterval);
      delete sessions[`dep_${orderId}`];
      const db2 = readDB();
      const dep = db2.deposits?.find(d => d.id === orderId);
      if (dep) dep.status = 'Expired';
      writeDB(db2);
      bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => {});
      bot.sendMessage(trx.chatId,
        `⏰ *QRIS Deposit Expired*\nOrder \`${orderId}\` sudah kadaluarsa.\nSilakan buat deposit baru.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      return;
    }

    const res = await checkQrisStatus(orderId, totalBayar);
    if (res && res.status === 'completed') {
      clearInterval(pollInterval);
      delete sessions[`dep_${orderId}`];

      const db2 = readDB();
      const dep = db2.deposits?.find(d => d.id === orderId);
      if (dep) dep.status = 'Lunas';
      writeDB(db2);

      bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => {});

      const uname = from.username ? `@${from.username}` : from.first_name;

      bot.sendMessage(trx.chatId,
        `✅ *DEPOSIT BERHASIL!*\n${'─'.repeat(25)}\n\n` +
        `💵 *Nominal:* Rp${nominal.toLocaleString('id-ID')}\n` +
        `💰 *Dibayar:* Rp${totalBayar.toLocaleString('id-ID')}\n` +
        `📋 *Order ID:* \`${orderId}\`\n\n` +
        `Saldo deposit Anda telah dicatat. 🎉`,
        {
          parse_mode: 'Markdown',
          ...ik([[btn('📊 History Deposit', 'history_deposit')], [btn('🏠 Home', 'go_home')]]),
        }
      ).catch(() => {});

      bot.sendMessage(OWNER_ID,
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

// ================================================================
// PROSES ADDITEM (dipakai oleh text handler)
// ================================================================
async function processAddItem(chatId, userId, text) {
  const sess = sessions[userId];
  if (!sess) return bot.sendMessage(chatId, '⚠️ Sesi hilang. /additem');
  console.log(`[ADDITEM] step=${sess.step} text="${text}"`);

  switch (sess.step) {
    case 'name':
      sess.data.name = text; sess.step = 'category';
      return bot.sendMessage(chatId, '📝 *Langkah 2/6: Pilih Kategori*', {
        parse_mode: 'Markdown',
        ...ik([
          [btn('🏢 Bermassa', 'add_cat_bermassa'), btn('💎 Topup Game', 'add_cat_topupgame'), btn('📱 Topup Pulsa', 'add_cat_topuppulsa')],
          [btn('❌ Batalkan', 'cancel_additem')],
        ]),
      });

    case 'extra':
      sess.data.extra = text; sess.step = 'price';
      return bot.sendMessage(chatId, '📝 *Langkah 4/6: Harga*\n\nKirim harga (angka):\nContoh: `15000`', { parse_mode: 'Markdown' });

    case 'price': {
      const p = Number(text);
      if (isNaN(p) || p < 0) return bot.sendMessage(chatId, '⚠️ Harus angka positif. Ulangi:');
      sess.data.price = p; sess.step = 'stock';
      return bot.sendMessage(chatId, '📝 *Langkah 5/6: Stok*\n\nKirim jumlah stok:', { parse_mode: 'Markdown' });
    }

    case 'stock': {
      const s = Number(text);
      if (isNaN(s) || s < 0) return bot.sendMessage(chatId, '⚠️ Harus angka positif. Ulangi:');
      sess.data.stock = s; sess.step = 'description';
      return bot.sendMessage(chatId, '📝 *Langkah 6/6: Deskripsi*\n\nKirim deskripsi produk:', { parse_mode: 'Markdown' });
    }

    case 'description': {
      sess.data.description = text;
      const { name, category, extra, price, stock, description } = sess.data;
      if (!name || !category || price == null || stock == null || !description) {
        delete sessions[userId];
        return bot.sendMessage(chatId, '❌ Data tidak lengkap. Mulai ulang /additem');
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
      return bot.sendMessage(chatId,
        `✅ *Item Ditambahkan!*\n${'─'.repeat(25)}\n` +
        `🏷️ ${name} | 📁 ${category}\n` +
        `💰 Harga: Rp${price.toLocaleString('id-ID')} → QRIS: Rp${total.toLocaleString('id-ID')}\n` +
        `📊 Stok: ${stock}\n📝 ${description}`,
        {
          parse_mode: 'Markdown',
          ...ik([[btn('📦 Katalog', 'page_1')], [btn('➕ Tambah Lagi', 'restart_additem')], [btn('🏠 Home', 'go_home')]]),
        }
      );
    }

    default:
      delete sessions[userId];
      return bot.sendMessage(chatId, '⚠️ Sesi error. /additem');
  }
}

// ================================================================
// CALLBACK QUERY ROUTER (pengganti bot.action dari Telegraf)
// ================================================================
const callbackRoutes = [
  { re: /^go_home$/, fn: async (q) => { await sendHome(q.message.chat.id, q.from, q.message.message_id); } },
  { re: /^noop$/,     fn: async () => {} },

  { re: /^info_bot$/, fn: async (q) => {
    await editMsg(q.message.chat.id, q.message.message_id,
      `🤖 *${BOT_NAME}*\n${'─'.repeat(25)}\n\n` +
      `📌 Bot katalog & topup produk digital.\n\n` +
      `💳 *Pembayaran:* Pakasir QRIS (otomatis)\n` +
      `👤 *Owner:* ${OWNER_USERNAME}\n🔖 *Versi:* 3.0.0  ⚡ Online`,
      ik([[btn('🏠 Home', 'go_home')]])
    );
  }},

  { re: /^page_(\d+)$/, fn: async (q, m) => {
    const cat = buildCatalog(Number(m[1]));
    await editMsg(q.message.chat.id, q.message.message_id, cat.text, cat.extra);
  }},

  { re: /^detail_(\d+)_(\d+)$/, fn: async (q, m) => {
    const itemId = Number(m[1]), fromPage = Number(m[2]);
    const item = readDB().items.find(i => i.id === itemId);
    if (!item) return bot.sendMessage(q.message.chat.id, '⚠️ Item tidak ditemukan.');

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

    const rows = [];
    rows.push([item.stock > 0 ? btn('🛒 Beli via QRIS', `buy_${item.id}_${fromPage}`) : btn('❌ Stok Habis', 'noop')]);
    if (q.from.id === OWNER_ID) {
      rows.push([btn('✏️ Edit', `help_edit_${item.id}`), btn('🗑️ Hapus', `confirm_delete_${item.id}_${fromPage}`)]);
    }
    rows.push([btn('⬅️ Katalog', `page_${fromPage}`), btn('🏠 Home', 'go_home')]);

    await editMsg(q.message.chat.id, q.message.message_id, txt, ik(rows));
  }},

  { re: /^buy_(\d+)_(\d+)$/, fn: async (q, m) => {
    const itemId = Number(m[1]), fromPage = Number(m[2]);
    const chatId = q.message.chat.id, userId = q.from.id;
    const db = readDB();
    const item = db.items.find(i => i.id === itemId);

    if (!item)           return bot.sendMessage(chatId, '⚠️ Item tidak ditemukan.');
    if (item.stock <= 0) return bot.sendMessage(chatId, '❌ Stok habis.');

    const orderId    = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const totalBayar = hitungTotal(item.price);

    let loadMsg;
    try { loadMsg = await bot.sendMessage(chatId, '⏳ Membuat QRIS, mohon tunggu...'); } catch (_) {}

    let qrisData;
    try {
      qrisData = await createQris(totalBayar, orderId);
    } catch (e) {
      if (loadMsg) bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ Gagal membuat QRIS: ${e.message}`);
    }

    if (loadMsg) bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});

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

    let qrMsg;
    try {
      qrMsg = await bot.sendPhoto(chatId, qrisImageUrl(qrisData.payment_number), {
        caption, parse_mode: 'Markdown',
        ...ik([[btn('❌ Batalkan', `cancel_order_${orderId}`)]]),
      });
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Gagal kirim QR: ${e.message}`);
    }

    sessions[`order_${orderId}`] = {
      type: 'pending_order', userId, itemId, fromPage, orderId, totalBayar,
      qrMsgId: qrMsg.message_id, chatId, expiredAt: expiredAt.getTime(),
    };

    const pollInterval = setInterval(async () => {
      const trx = sessions[`order_${orderId}`];
      if (!trx) { clearInterval(pollInterval); return; }

      if (Date.now() >= trx.expiredAt) {
        clearInterval(pollInterval);
        delete sessions[`order_${orderId}`];
        bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => {});
        bot.sendMessage(trx.chatId,
          `⏰ *QRIS Expired*\nOrder \`${orderId}\` sudah kadaluarsa.\nSilakan beli ulang.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        return;
      }

      const res = await checkQrisStatus(orderId, totalBayar);
      if (res && res.status === 'completed') {
        clearInterval(pollInterval);
        delete sessions[`order_${orderId}`];

        const db2 = readDB();
        const it  = db2.items.find(i => i.id === itemId);
        if (it) {
          it.stock -= 1;
          if (it.stock <= 0) it.status = 'Habis';
        }
        if (!db2.orders) db2.orders = [];
        db2.orders.push({
          userId, itemId, itemName: item.name, category: item.category,
          price: item.price, totalBayar, orderId, timestamp: Date.now(),
        });
        writeDB(db2);

        bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => {});

        const uname = q.from.username ? `@${q.from.username}` : q.from.first_name;
        bot.sendMessage(trx.chatId,
          `✅ *PEMBAYARAN BERHASIL!*\n${'─'.repeat(25)}\n\n` +
          `📦 *Produk:* ${item.name}\n` +
          `💰 *Dibayar:* Rp${totalBayar.toLocaleString('id-ID')}\n` +
          `📋 *Order ID:* \`${orderId}\`\n\n` +
          `Hubungi ${OWNER_USERNAME} untuk proses pengiriman produk.`,
          {
            parse_mode: 'Markdown',
            ...ik([[btn('📜 History Order', 'history_order')], [btn('🏠 Home', 'go_home')]]),
          }
        ).catch(() => {});

        bot.sendMessage(OWNER_ID,
          `🛒 *PESANAN BARU (LUNAS)*\n${'─'.repeat(20)}\n` +
          `👤 User: ${uname} (${userId})\n` +
          `📦 ${item.name}\n` +
          `💰 Rp${totalBayar.toLocaleString('id-ID')}\n` +
          `📋 Order: \`${orderId}\`\n` +
          `📊 Sisa stok: ${item.stock - 1}`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    }, 5000);
  }},

  { re: /^cancel_order_(.+)$/, fn: async (q, m) => {
    const orderId = m[1];
    delete sessions[`order_${orderId}`];
    try { await bot.deleteMessage(q.message.chat.id, q.message.message_id); } catch (_) {}
    await bot.sendMessage(q.message.chat.id, '❌ Order dibatalkan.', ik([[btn('🏠 Home', 'go_home')]]));
  }, cbText: '❌ Order dibatalkan' },

  { re: /^deposit_menu$/, fn: async (q) => {
    await editMsg(q.message.chat.id, q.message.message_id,
      `💰 *DEPOSIT SALDO*\n${'─'.repeat(25)}\n\n` +
      `Pilih nominal deposit:\n\n` +
      `_Biaya admin Pakasir (0.7% + Rp340) sudah termasuk dalam total bayar._`,
      ik([
        [btn('Rp10.000', 'dep_10000'), btn('Rp20.000', 'dep_20000'), btn('Rp50.000', 'dep_50000')],
        [btn('Rp100.000', 'dep_100000'), btn('Rp200.000', 'dep_200000'), btn('Rp500.000', 'dep_500000')],
        [btn('✏️ Nominal Lain', 'dep_custom')],
        [btn('🏠 Home', 'go_home')],
      ])
    );
  }},

  { re: /^dep_(10000|20000|50000|100000|200000|500000)$/, fn: async (q, m) => {
    await prosesDeposit(q.message.chat.id, q.from, Number(m[1]));
  }},

  { re: /^dep_custom$/, fn: async (q) => {
    sessions[q.from.id] = { type: 'deposit_custom' };
    await editMsg(q.message.chat.id, q.message.message_id,
      `✏️ *Nominal Custom*\n\nKirim nominal deposit (min Rp10.000):\nContoh: ` + '`50000`',
      ik([[btn('❌ Batal', 'deposit_menu')]])
    );
  }},

  { re: /^cancel_dep_(.+)$/, fn: async (q, m) => {
    const orderId = m[1];
    delete sessions[`dep_${orderId}`];
    const db  = readDB();
    const dep = db.deposits?.find(d => d.id === orderId);
    if (dep) dep.status = 'Cancelled';
    writeDB(db);
    try { await bot.deleteMessage(q.message.chat.id, q.message.message_id); } catch (_) {}
    await bot.sendMessage(q.message.chat.id, '❌ Deposit dibatalkan.',
      ik([[btn('💰 Deposit Lagi', 'deposit_menu')], [btn('🏠 Home', 'go_home')]]));
  }, cbText: '❌ Deposit dibatalkan' },

  { re: /^history_order$/, fn: async (q) => {
    const db     = readDB();
    const orders = (db.orders || []).filter(o => o.userId === q.from.id);
    const kb     = ik([[btn('🏠 Home', 'go_home')]]);

    let txt;
    if (!orders.length) {
      txt = '📭 *Belum ada order.*\n\nBelum pernah melakukan pembelian.';
    } else {
      txt = `📜 *History Order*\n${'─'.repeat(25)}\n`;
      orders.slice(-10).reverse().forEach((o, i) => {
        const e  = o.category === 'Topup Game' ? '💎' : o.category === 'Topup Pulsa' ? '📱' : '🏢';
        const dt = new Date(o.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        txt += `\n${i + 1}. ${e} *${o.itemName}*\n` +
               `   💰 Rp${o.price.toLocaleString('id-ID')} • ${dt}\n` +
               `   📋 \`${o.orderId || '-'}\`\n`;
      });
      txt += `\n_${Math.min(10, orders.length)} dari ${orders.length} order_`;
    }
    await editMsg(q.message.chat.id, q.message.message_id, txt, kb);
  }},

  { re: /^history_deposit$/, fn: async (q) => {
    const db   = readDB();
    const deps = (db.deposits || []).filter(d => d.userId === q.from.id);
    const kb   = ik([[btn('💰 Deposit Baru', 'deposit_menu')], [btn('🏠 Home', 'go_home')]]);

    let txt;
    if (!deps.length) {
      txt = '📭 *Belum ada deposit.*\n\nTekan tombol di bawah untuk deposit pertama Anda.';
    } else {
      txt = `📊 *History Deposit*\n${'─'.repeat(25)}\n`;
      deps.slice(-10).reverse().forEach((d, i) => {
        const e  = d.status === 'Lunas' ? '✅' : d.status === 'Expired' ? '⏰' : d.status === 'Cancelled' ? '❌' : '⏳';
        const dt = new Date(d.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        txt += `\n${i + 1}. ${e} *Rp${d.nominal.toLocaleString('id-ID')}*\n` +
               `   Status: *${d.status}* • ${dt}\n`;
      });
      txt += `\n_${Math.min(10, deps.length)} dari ${deps.length} deposit_`;
    }
    await editMsg(q.message.chat.id, q.message.message_id, txt, kb);
  }},

  { re: /^support_ticket$/, fn: async (q) => {
    sessions[q.from.id] = { type: 'ticket', active: true };
    await editMsg(q.message.chat.id, q.message.message_id,
      `🎫 *Tiket Support ${BOT_NAME}*\n${'─'.repeat(25)}\n\n` +
      `Kirim pesan Anda sekarang.\n` +
      `Pesan diteruskan ke admin secara *anonim*.\n\n` +
      `_Ketik /endticket untuk menutup tiket_`,
      ik([[btn('🔒 Tutup Tiket', 'close_ticket')], [btn('🏠 Home', 'go_home')]])
    );
  }},

  { re: /^close_ticket$/, fn: async (q) => {
    delete sessions[q.from.id];
    await bot.sendMessage(q.message.chat.id, '🔒 Tiket ditutup. Terima kasih!');
    await sendHome(q.message.chat.id, q.from);
  }},

  { re: /^add_cat_bermassa$/, fn: async (q) => {
    if (q.from.id !== OWNER_ID) return;
    const sess = sessions[q.from.id];
    if (!sess || sess.step !== 'category') return bot.sendMessage(q.message.chat.id, '⚠️ Sesi tidak valid. /additem');
    sess.data.category = 'Bermassa'; sess.step = 'extra';
    await bot.editMessageText('📝 *Langkah 3/6: Durasi*\n\nContoh: `1 Bulan`, `3 Hari`', {
      chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown',
    });
  }, cbText: '✅ Bermassa', ownerOnly: true },

  { re: /^add_cat_topupgame$/, fn: async (q) => {
    if (q.from.id !== OWNER_ID) return;
    const sess = sessions[q.from.id];
    if (!sess || sess.step !== 'category') return bot.sendMessage(q.message.chat.id, '⚠️ Sesi tidak valid. /additem');
    sess.data.category = 'Topup Game'; sess.step = 'extra';
    await bot.editMessageText('💎 *Langkah 3/6: Jumlah*\n\nContoh: `100 Diamond`, `60 UC`', {
      chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown',
    });
  }, cbText: '✅ Topup Game', ownerOnly: true },

  { re: /^add_cat_topuppulsa$/, fn: async (q) => {
    if (q.from.id !== OWNER_ID) return;
    const sess = sessions[q.from.id];
    if (!sess || sess.step !== 'category') return bot.sendMessage(q.message.chat.id, '⚠️ Sesi tidak valid. /additem');
    sess.data.category = 'Topup Pulsa'; sess.step = 'extra';
    await bot.editMessageText('📱 *Langkah 3/6: Nominal/Kuota*\n\nContoh: `Rp100.000`, `10GB`', {
      chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown',
    });
  }, cbText: '✅ Topup Pulsa', ownerOnly: true },

  { re: /^cancel_additem$/, fn: async (q) => {
    delete sessions[q.from.id];
    await bot.editMessageText('❌ Tambah item dibatalkan.', {
      chat_id: q.message.chat.id, message_id: q.message.message_id,
      ...ik([[btn('🏠 Home', 'go_home')]]),
    });
  }, cbText: '❌ Dibatalkan' },

  { re: /^restart_additem$/, fn: async (q) => {
    if (q.from.id !== OWNER_ID) return;
    delete sessions[q.from.id];
    sessions[q.from.id] = { type: 'additem', step: 'name', data: {} };
    await bot.sendMessage(q.message.chat.id, '📝 *Tambah Item — Langkah 1/6*\n\nKirim *nama item*:', { parse_mode: 'Markdown' });
  }, ownerOnly: true },

  { re: /^help_add$/, fn: async (q) => {
    if (q.from.id !== OWNER_ID) return bot.sendMessage(q.message.chat.id, '⛔ Hanya owner.');
    await bot.sendMessage(q.message.chat.id, '📌 Ketik `/additem` dan ikuti langkah-langkah.', { parse_mode: 'Markdown' });
  }},

  { re: /^help_edit_(\d+)$/, fn: async (q, m) => {
    if (q.from.id !== OWNER_ID) return;
    await bot.sendMessage(q.message.chat.id, `📌 Edit \`${m[1]}\`:\n\`/edititem ${m[1]} | Nama | Kat | Field | Harga | Stok | Desc\``, { parse_mode: 'Markdown' });
  }, ownerOnly: true },

  { re: /^confirm_delete_(\d+)_(\d+)$/, fn: async (q, m) => {
    if (q.from.id !== OWNER_ID) return;
    const itemId = Number(m[1]), fromPage = Number(m[2]);
    const item = readDB().items.find(i => i.id === itemId);
    await editMsg(q.message.chat.id, q.message.message_id,
      `⚠️ *Konfirmasi Hapus*\n\nHapus: *${item?.name || itemId}*?`,
      ik([[btn('✅ Ya Hapus', `delete_${itemId}_${fromPage}`), btn('❌ Batal', `detail_${itemId}_${fromPage}`)]])
    );
  }, ownerOnly: true },

  { re: /^delete_(\d+)_(\d+)$/, fn: async (q, m) => {
    if (q.from.id !== OWNER_ID) return;
    const itemId = Number(m[1]), fromPage = Number(m[2]);
    const db = readDB();
    db.items = db.items.filter(i => i.id !== itemId);
    writeDB(db);
    const cat = buildCatalog(fromPage);
    await editMsg(q.message.chat.id, q.message.message_id, cat.text, cat.extra);
  }, cbText: '🗑️ Dihapus!', ownerOnly: true },
];

bot.on('callback_query', async (query) => {
  const data = query.data || '';
  for (const route of callbackRoutes) {
    const m = data.match(route.re);
    if (m) {
      if (route.ownerOnly && query.from.id !== OWNER_ID) {
        return bot.answerCallbackQuery(query.id, { text: '⛔' }).catch(() => {});
      }
      try {
        await bot.answerCallbackQuery(query.id, route.cbText ? { text: route.cbText } : {});
      } catch (_) {}
      try {
        await route.fn(query, m);
      } catch (e) {
        console.error('Callback handler error:', e);
      }
      return;
    }
  }
  // Tidak ada route yang cocok
  bot.answerCallbackQuery(query.id).catch(() => {});
});

// ================================================================
// SATU-SATUNYA text handler (pengganti bot.on('text') Telegraf)
// ================================================================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/start') || msg.text.startsWith('/ping') ||
      msg.text.startsWith('/additem') || msg.text.startsWith('/edititem')) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text   = msg.text;
  console.log(`[TEXT] ${userId} | "${text}" | sess=${JSON.stringify(sessions[userId] || null)}`);

  // 1. Owner /reply
  if (userId === OWNER_ID && text.startsWith('/reply ')) {
    const parts    = text.split(' ');
    const targetId = Number(parts[1]);
    const m        = parts.slice(2).join(' ');
    if (!targetId || !m) return bot.sendMessage(chatId, 'Format: /reply [user_id] [pesan]');
    try {
      await bot.sendMessage(targetId, `📩 *Balasan Admin ${BOT_NAME}:*\n\n${m}`, { parse_mode: 'Markdown' });
      return bot.sendMessage(chatId, `✅ Terkirim ke ${targetId}`);
    } catch (e) { return bot.sendMessage(chatId, `❌ Gagal: ${e.message}`); }
  }

  const sess = sessions[userId];

  // 2. Tiket support
  if (sess?.type === 'ticket' && sess.active) {
    if (text === '/endticket') { delete sessions[userId]; return bot.sendMessage(chatId, '🔒 Tiket ditutup.'); }
    const uname = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
    try {
      await bot.sendMessage(OWNER_ID,
        `🎫 *Tiket Baru*\n${'─'.repeat(20)}\n👤 ${uname} (\`${userId}\`)\n\n💬 ${text}\n\n_Balas: /reply ${userId} [pesan]_`,
        { parse_mode: 'Markdown' }
      );
      return bot.sendMessage(chatId, '✅ Pesan terkirim ke admin. Tunggu balasan.');
    } catch { return bot.sendMessage(chatId, '❌ Gagal kirim.'); }
  }

  // 3. Deposit custom nominal
  if (sess?.type === 'deposit_custom') {
    delete sessions[userId];
    const nominal = Number(text.replace(/[^0-9]/g, ''));
    if (isNaN(nominal) || nominal < 10000) {
      return bot.sendMessage(chatId, '⚠️ Nominal tidak valid (min Rp10.000). Coba lagi /start lalu Deposit Saldo.');
    }
    return prosesDeposit(chatId, msg.from, nominal);
  }

  // 4. Additem flow
  if (sess?.type === 'additem') {
    if (userId !== OWNER_ID) { delete sessions[userId]; return bot.sendMessage(chatId, '⛔ Bukan owner.'); }
    if (text.startsWith('/') && !text.startsWith('/additem')) {
      delete sessions[userId];
      return bot.sendMessage(chatId, '⛔ Sesi additem dibatalkan.');
    }
    return processAddItem(chatId, userId, text);
  }
  // Default: diam
});

// ================================================================
// LAUNCH
// ================================================================
bot.on('polling_error', (err) => console.error('❌ Polling error:', err.message));
console.log(`✅ ${BOT_NAME} aktif! QRIS via Pakasir enabled (node-telegram-bot-api).`);

process.once('SIGINT',  () => { bot.stopPolling(); process.exit(0); });
process.once('SIGTERM', () => { bot.stopPolling(); process.exit(0); });

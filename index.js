process.env.NTBA_FIX_350 = 1;
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ================================================================
// KONFIGURASI
// ================================================================
const BOT_TOKEN = process.env.BOT_TOKEN || '8214220902:AAHNw7g5XyX49URMdiIBnLCnmKgDJmSyFMM';
const OWNER_ID = 1669925773;
const DB_PATH = path.join(__dirname, 'db.json');
const LOGO_PATH = path.join(__dirname, 'media', 'logo.png');
const BOT_NAME = 'Acamedia';
const OWNER_USERNAME = '@sofunsyabi';

const axios = require('axios');

// ── Payment Gateway Pakasir ────────────────────────────────────
const PAKASIR_CONFIG = {
  slug: 'acamedia',
  apikey: 'ZU0JBrZtUZSqI8nAqz73zbtgJFtj0tY5',
  expiredMinutes: 15,
};

// Hitung manual biaya admin Pakasir (0.7% + Rp340)
function hitungTotalPakasir(hargaDasar) {
  let pajakPersen = 0.007 * hargaDasar;
  let biayaFlat = 340;
  return Math.ceil(hargaDasar + pajakPersen + biayaFlat);
}

// Buat QRIS via Pakasir API
async function createQrisPakasir(orderId, amount) {
  const totalInput = hitungTotalPakasir(amount);
  const res = await axios.post('https://app.pakasir.com/api/transactioncreate/qris', {
    project: PAKASIR_CONFIG.slug,
    order_id: orderId,
    amount: totalInput,
    api_key: PAKASIR_CONFIG.apikey,
  });
  if (!res.data || !res.data.payment) {
    throw new Error(res.data?.message || 'Gagal membuat QRIS Pakasir');
  }
  return {
    ...res.data.payment,
    totalInput,
  };
}

// Cek status transaksi via Pakasir API
async function checkStatusPakasir(orderId, amount) {
  try {
    const res = await axios.get(`https://app.pakasir.com/api/transactiondetail?project=${PAKASIR_CONFIG.slug}&amount=${amount}&order_id=${orderId}&api_key=${PAKASIR_CONFIG.apikey}`);
    return res.data?.transaction;
  } catch (e) {
    return null;
  }
}

// Buat URL gambar QR Code dari payment string
function getQrCodeImageUrl(paymentNumber) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=750x750&data=${encodeURIComponent(paymentNumber)}&qzone=4&format=gif&bgcolor=576A8F&color=FFF8DE`;
}

// ── (Opsional) Proxy — isi kalau perlu ──────────────────────────
// Contoh: 'http://user:pass@ip_proxy:port'
const PROXY_URL = '';

// ================================================================
// SETTINGS HOME PAGE (bisa diedit owner lewat tombol ⚙️ Edit Home)
// ================================================================
const DEFAULT_SETTINGS = {
  botName: BOT_NAME,
  productList: '• 🏢 Bermassa (Akun bersama)\n• 💎 Topup Game\n• 📱 Topup Pulsa / Kuota',
  paymentInfo: 'Pakasir QRIS (Otomatis)',
  ownerUsername: OWNER_USERNAME,
  footerText: '_Pilih menu di bawah ini:_',
  logoFileId: null, // null = pakai file lokal LOGO_PATH
};

function getSettings() {
  const db = readDB();
  return { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
}

function saveSetting(field, value) {
  const db = readDB();
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}), [field]: value };
  writeDB(db);
  return db.settings;
}

function resetSettings() {
  const db = readDB();
  delete db.settings;
  writeDB(db);
}

// ================================================================
// DATABASE
// ================================================================
function readDB() {
  const defaults = { deposits: [], items: [], orders: [], tickets: [], reservations: [], tables: [], areas: [], blockedDates: [], activities: [], reviews: [], users: {}, vouchers: [] };
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    return { ...defaults, ...data };
  }
  catch { return defaults; }
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
function getUserSaldo(userId) {
  const db = readDB();
  const u = db.users?.[String(userId)];
  return u?.saldo || 0;
}
function updateUserSaldo(userId, delta, fromObj = null) {
  const db = readDB();
  if (!db.users) db.users = {};
  const key = String(userId);
  if (!db.users[key]) {
    db.users[key] = {
      id: Number(userId),
      username: fromObj?.username || '',
      firstName: fromObj?.first_name || 'User',
      saldo: 0,
      firstSeen: new Date().toISOString(),
    };
  }
  db.users[key].saldo = Math.max(0, (db.users[key].saldo || 0) + delta);
  if (fromObj) {
    if (fromObj.username) db.users[key].username = fromObj.username;
    if (fromObj.first_name) db.users[key].firstName = fromObj.first_name;
    db.users[key].lastSeen = new Date().toISOString();
  }
  writeDB(db);
  return db.users[key].saldo;
}
function ensureUser(fromObj) {
  if (!fromObj || !fromObj.id) return;
  const db = readDB();
  if (!db.users) db.users = {};
  const key = String(fromObj.id);
  if (!db.users[key]) {
    db.users[key] = {
      id: fromObj.id,
      username: fromObj.username || '',
      firstName: fromObj.first_name || 'User',
      saldo: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    writeDB(db);
  } else {
    let updated = false;
    if (fromObj.username && db.users[key].username !== fromObj.username) {
      db.users[key].username = fromObj.username;
      updated = true;
    }
    if (db.users[key].saldo === undefined) {
      db.users[key].saldo = 0;
      updated = true;
    }
    db.users[key].lastSeen = new Date().toISOString();
    writeDB(db);
  }
}
function chunkArray(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
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
    const u = from.username || from.first_name || '?';
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
  ensureUser(from);
  const uname = from?.username || from?.first_name || 'User';
  const settings = getSettings();
  const saldo = getUserSaldo(from.id);
  const caption =
    `👋 *Selamat datang di ${settings.botName}!*\n` +
    `Halo, *${uname}*! 🎉\n\n` +
    `💰 *Saldo Anda:* Rp${saldo.toLocaleString('id-ID')}\n\n` +
    `📌 *Produk tersedia:*\n` +
    `${settings.productList}\n\n` +
    `💳 *Pembayaran:* ${settings.paymentInfo}\n` +
    `👤 *Owner:* ${settings.ownerUsername}\n\n` +
    `${settings.footerText}`;

  const rows = [
    [btn('📦 Buka Katalog (2×7)', 'page_1')],
    [btn('💰 Deposit Saldo', 'deposit_menu'), btn('🎟️ Klaim Voucher', 'claim_voucher_menu')],
    [btn('📊 History Deposit', 'history_deposit'), btn('📜 History Order', 'history_order')],
    [btn('🎫 Tiket Support', 'support_ticket'), btn('ℹ️ Info Bot', 'info_bot')],
  ];
  if (from?.id === OWNER_ID) {
    rows.push([btn('⚙️ Panel Admin', 'admin_panel'), btn('⚙️ Edit Tampilan Home', 'edithome_menu')]);
  }
  const kb = ik(rows);

  // Hapus pesan sebelumnya (baik itu foto Home lama, maupun pesan teks menu lain)
  if (msgToDelete) {
    try { await bot.deleteMessage(chatId, msgToDelete); } catch (_) { }
  }

  // Home SELALU dikirim sebagai FOTO (logo) — ini satu-satunya tempat logo muncul
  const photoSource = settings.logoFileId || LOGO_PATH;
  try {
    await bot.sendPhoto(chatId, photoSource, { caption, parse_mode: 'Markdown', ...kb });
  } catch {
    await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', ...kb });
  }
}

// ================================================================
// KATALOG
// ================================================================
function buildCatalog(page = 1) {
  const db = readDB();
  const items = db.items || [];
  const PER = 14, total = items.length;
  const totalPages = Math.ceil(total / PER) || 1;
  const cur = Math.max(1, Math.min(page, totalPages));
  const slice = items.slice((cur - 1) * PER, cur * PER);

  if (!total) return {
    text: '📭 Belum ada item di katalog.',
    extra: ik([[btn('🏠 Home', 'go_home')]]),
  };

  const btns = slice.map(item => {
    const dot = item.stock > 0 ? '🟢' : '🔴';
    const cat = item.category === 'Topup Game' ? '💎' : item.category === 'Topup Pulsa' ? '📱' : '🏢';
    const xtra = item.category === 'Bermassa' ? item.waktu : item.count;
    let lbl = `${cat}${dot} ${item.name}`;
    if (xtra) lbl += ` | ${xtra}`;
    if (lbl.length > 64) lbl = lbl.substring(0, 61) + '...';
    return btn(lbl, `detail_${item.id}_${cur}`);
  });

  const grid = chunkArray(btns, 2);
  const nav = [];
  if (cur > 1) nav.push(btn('⬅️ Prev', `page_${cur - 1}`));
  nav.push(btn(`📄 ${cur}/${totalPages}`, 'noop'));
  if (cur < totalPages) nav.push(btn('Next ➡️', `page_${cur + 1}`));
  if (nav.length) grid.push(nav);
  grid.push([btn('🔄 Refresh', `page_${cur}`), btn('➕ Tambah', 'help_add')]);
  grid.push([btn('🏠 Home', 'go_home')]);

  return {
    text:
      `🛍️ *KATALOG ${BOT_NAME}*\n` +
      `Hal. *${cur}/${totalPages}* — Total: *${total}* item\n\n` +
      `💎=Game  📱=Pulsa  🏢=Bermassa  🟢=Ada  🔴=Habis\n\nPilih produk:`,
    extra: ik(grid),
  };
}

// ================================================================
// EDIT HELPER (SELALU pesan teks — logo hanya muncul di sendHome)
// ================================================================
// Sebelumnya fungsi ini mencoba editMessageCaption dulu (karena
// pesan Home berupa foto), sehingga logo ikut nempel di semua menu
// turunan. Sekarang: hapus pesan lama apa pun bentuknya (foto atau
// teks), lalu kirim pesan TEKS BARU. Foto/logo jadi eksklusif hanya
// muncul lewat sendHome().
async function editMsg(chatId, messageId, txt, extra) {
  // Hapus pesan sebelumnya (foto Home atau teks menu lain)
  try { await bot.deleteMessage(chatId, messageId); } catch (_) { }

  // Kirim sebagai pesan teks biasa, tanpa foto
  try {
    return await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', ...(extra || {}) });
  } catch (e) {
    console.error('editMsg: gagal kirim pesan teks:', e.message);
  }
}

// ================================================================
// START / COMMANDS
// ================================================================
bot.onText(/^\/start$/, (msg) => sendHome(msg.chat.id, msg.from));
bot.onText(/^\/ping$/, (msg) => bot.sendMessage(msg.chat.id, '🏓 Pong!'));

// ── BACKUP & RESTORE COMMANDS ──
bot.onText(/^\/backup$/, async (msg) => {
  if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, '⛔ Hanya owner.');
  try {
    await bot.sendDocument(msg.chat.id, DB_PATH, {
      caption: `💾 *Backup Database Telegram Bot*\nTanggal: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Gagal backup: ${e.message}`);
  }
});

bot.onText(/^\/restore$/, (msg) => {
  if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, '⛔ Hanya owner.');
  sessions[msg.from.id] = { type: 'restore_db' };
  bot.sendMessage(msg.chat.id, '📥 *RESTORE DATABASE*\n\nSilakan kirimkan file `db.json` ke bot ini sebagai dokumen file.', { parse_mode: 'Markdown' });
});

// ── ADMIN SALDO COMMANDS ──
bot.onText(/^\/addsaldo(?:\s+(\d+)\s+(-?\d+))?$/, (msg, match) => {
  if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, '⛔ Hanya owner.');
  const targetId = Number(match[1]);
  const nominal = Number(match[2]);
  if (!targetId || isNaN(nominal)) return bot.sendMessage(msg.chat.id, 'Format: `/addsaldo [userId] [nominal]`\nContoh: `/addsaldo 1669925773 50000`', { parse_mode: 'Markdown' });
  const newBal = updateUserSaldo(targetId, nominal);
  bot.sendMessage(targetId, `ℹ️ Saldo Anda telah ditambah Admin sebesar *Rp${nominal.toLocaleString('id-ID')}*. Saldo saat ini: *Rp${newBal.toLocaleString('id-ID')}*`, { parse_mode: 'Markdown' }).catch(() => {});
  bot.sendMessage(msg.chat.id, `✅ Saldo user \`${targetId}\` ditambah Rp${nominal.toLocaleString('id-ID')}. Saldo baru: Rp${newBal.toLocaleString('id-ID')}`, { parse_mode: 'Markdown' });
});

bot.onText(/^\/deductsaldo(?:\s+(\d+)\s+(\d+))?$/, (msg, match) => {
  if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, '⛔ Hanya owner.');
  const targetId = Number(match[1]);
  const nominal = Number(match[2]);
  if (!targetId || isNaN(nominal)) return bot.sendMessage(msg.chat.id, 'Format: `/deductsaldo [userId] [nominal]`\nContoh: `/deductsaldo 1669925773 20000`', { parse_mode: 'Markdown' });
  const newBal = updateUserSaldo(targetId, -nominal);
  bot.sendMessage(targetId, `ℹ️ Saldo Anda dipotong Admin sebesar *Rp${nominal.toLocaleString('id-ID')}*. Saldo saat ini: *Rp${newBal.toLocaleString('id-ID')}*`, { parse_mode: 'Markdown' }).catch(() => {});
  bot.sendMessage(msg.chat.id, `✅ Saldo user \`${targetId}\` dipotong Rp${nominal.toLocaleString('id-ID')}. Saldo baru: Rp${newBal.toLocaleString('id-ID')}`, { parse_mode: 'Markdown' });
});

// ── BROADCAST COMMAND ──
bot.onText(/^\/broadcast(?:\s+([\s\S]+))?$/, async (msg, match) => {
  if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, '⛔ Hanya owner.');
  const text = match[1];
  if (!text) return bot.sendMessage(msg.chat.id, 'Format: `/broadcast [pesan]`\nContoh: `/broadcast Halo guys, promo hari ini diskon 20%!`,', { parse_mode: 'Markdown' });
  const db = readDB();
  const userIds = Object.keys(db.users || {});
  bot.sendMessage(msg.chat.id, `⏳ Mengirim broadcast ke ${userIds.length} user...`);
  let count = 0;
  for (const uid of userIds) {
    try {
      await bot.sendMessage(uid, `📢 *PENGUMUMAN:* \n\n${text}`, { parse_mode: 'Markdown' });
      count++;
    } catch (_) {}
  }
  bot.sendMessage(msg.chat.id, `✅ *Broadcast Selesai!*\nPesan terkirim ke ${count} dari ${userIds.length} user.`, { parse_mode: 'Markdown' });
});

// ── VOUCHER COMMANDS ──
bot.onText(/^\/addvoucher(?:\s+(\w+)\s+(\d+))?$/, (msg, match) => {
  if (msg.from.id !== OWNER_ID) return bot.sendMessage(msg.chat.id, '⛔ Hanya owner.');
  const code = (match[1] || '').toUpperCase();
  const nominal = Number(match[2]);
  if (!code || isNaN(nominal) || nominal <= 0) return bot.sendMessage(msg.chat.id, 'Format: `/addvoucher [KODE] [NOMINAL]`\nContoh: `/addvoucher PROMO10K 10000`', { parse_mode: 'Markdown' });
  const db = readDB();
  if (!db.vouchers) db.vouchers = [];
  db.vouchers.push({ code, nominal, usedBy: [], createdAt: Date.now() });
  writeDB(db);
  bot.sendMessage(msg.chat.id, `✅ Voucher \`${code}\` berharga Rp${nominal.toLocaleString('id-ID')} berhasil dibuat!`, { parse_mode: 'Markdown' });
});

bot.onText(/^\/voucher(?:\s+(\w+))?$/, (msg, match) => {
  const code = (match[1] || '').toUpperCase();
  if (!code) return bot.sendMessage(msg.chat.id, 'Format: `/voucher [KODE]`\nContoh: `/voucher PROMO10K`', { parse_mode: 'Markdown' });
  const userId = msg.from.id;
  const db = readDB();
  const v = (db.vouchers || []).find(vc => vc.code === code);
  if (!v) return bot.sendMessage(msg.chat.id, '❌ Kode voucher tidak ditemukan/invalid.');
  if (!v.usedBy) v.usedBy = [];
  if (v.usedBy.includes(userId)) return bot.sendMessage(msg.chat.id, '⚠️ Anda sudah pernah mengklaim voucher ini.');
  v.usedBy.push(userId);
  writeDB(db);
  const newBal = updateUserSaldo(userId, v.nominal, msg.from);
  bot.sendMessage(msg.chat.id, `🎉 *VOUCHER BERHASIL DIKLAIM!*\n\nBonus Saldo: +Rp${v.nominal.toLocaleString('id-ID')}\nSaldo saat ini: Rp${newBal.toLocaleString('id-ID')}`, { parse_mode: 'Markdown' });
});

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
// EDITITEM (command lama — tetap dipertahankan untuk owner yang mau cara cepat)
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
  const db = readDB();
  const idx = db.items.findIndex(i => i.id === id);
  if (idx === -1) return bot.sendMessage(msg.chat.id, '⚠️ Item tidak ditemukan.');
  const updated = { id, name, category, price, stock, description, status: stock > 0 ? 'Tersedia' : 'Habis' };
  if (category === 'Bermassa') updated.waktu = extra; else updated.count = extra;
  db.items[idx] = updated;
  writeDB(db);
  bot.sendMessage(msg.chat.id, `✏️ Item \`${id}\` diperbarui!`, { parse_mode: 'Markdown' });
});

// Owner /reply, ticket, deposit custom, additem/edititem flow — ditangani di handler 'message' generik di bawah.

// ================================================================
// LABEL FIELD EDIT (dipakai di beberapa tempat)
// ================================================================
const EDIT_FIELD_LABELS = {
  name: '🏷️ Nama',
  category: '📁 Kategori',
  extra: '⏳🔢 Field Tambahan (Durasi/Jumlah)',
  price: '💰 Harga',
  stock: '📊 Stok',
  description: '📝 Deskripsi',
};

const EDIT_HOME_FIELD_LABELS = {
  botName: '🏷️ Nama Bot',
  productList: '📦 Daftar Produk',
  paymentInfo: '💳 Info Pembayaran',
  ownerUsername: '👤 Owner',
  footerText: '📝 Footer Text',
  logo: '🖼️ Logo',
};

// ================================================================
// PROSES DEPOSIT (Pakasir QRIS)
// QR dikirim ke buyer dengan total tagihan + pajak.
// Auto-check status via Pakasir API (polling per 5 detik).
// ================================================================
async function prosesDeposit(chatId, from, nominal) {
  if (nominal < 10000) return bot.sendMessage(chatId, '❌ Minimal deposit Rp10.000');
  const userId = from.id;
  const orderId = `DEP-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  let cqris;
  try {
    cqris = await createQrisPakasir(orderId, nominal);
  } catch (e) {
    console.error('Pakasir deposit error:', e);
    return bot.sendMessage(chatId, `❌ Gagal membuat QRIS: ${e.message}`);
  }

  const totalInput = cqris.totalInput;
  const totalFinal = cqris.total_payment || totalInput;

  const db = readDB();
  if (!db.deposits) db.deposits = [];
  db.deposits.push({
    id: orderId, userId, nominal, totalBayar: totalFinal, status: 'Pending', timestamp: Date.now(),
  });
  writeDB(db);

  const expiredAt = new Date();
  expiredAt.setMinutes(expiredAt.getMinutes() + PAKASIR_CONFIG.expiredMinutes);
  const expStr = expiredAt.toLocaleTimeString('id-ID', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta'
  });

  const qrImageUrl = getQrCodeImageUrl(cqris.payment_number);

  const caption =
    `💳 *DEPOSIT QRIS PAKASIR*\n${'─'.repeat(25)}\n\n` +
    `💵 *Nominal Deposit:* Rp${nominal.toLocaleString('id-ID')}\n` +
    `💰 *TOTAL TAGIHAN:* Rp${totalFinal.toLocaleString('id-ID')}\n` +
    `📋 *Order ID:* \`${orderId}\`\n` +
    `⏳ *Expired:* ${expStr} WIB\n\n` +
    `*Scan QR di atas* dan bayar tepat sesuai nominal total tagihan.\n` +
    `_Sistem akan otomatis mendeteksi pembayaran Anda._`;

  let qrMsg;
  try {
    qrMsg = await bot.sendPhoto(chatId, qrImageUrl, {
      caption, parse_mode: 'Markdown',
      ...ik([
        [btn('🔔 Saya Sudah Bayar', `notify_dep_${orderId}`)],
        [btn('❌ Batalkan', `cancel_dep_${orderId}`)],
      ]),
    });
  } catch (e) {
    return bot.sendMessage(chatId, `❌ Gagal kirim QR: ${e.message}`);
  }

  const intervalId = setInterval(async () => {
    const trx = sessions[`dep_${orderId}`];
    if (!trx) {
      clearInterval(intervalId);
      return;
    }

    if (new Date() >= trx.expiredAt) {
      clearInterval(intervalId);
      delete sessions[`dep_${orderId}`];
      const db2 = readDB();
      const dep = db2.deposits?.find(d => d.id === orderId);
      if (dep && dep.status === 'Pending') dep.status = 'Expired';
      writeDB(db2);

      bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => { });
      bot.sendMessage(trx.chatId,
        `⚠️ *QRIS Expired*\nOrder deposit \`${orderId}\` telah kedaluwarsa. Silakan buat deposit baru.`,
        { parse_mode: 'Markdown' }
      ).catch(() => { });
      return;
    }

    const res = await checkStatusPakasir(orderId, totalInput);
    if (res && res.status === 'completed') {
      clearInterval(intervalId);
      const db2 = readDB();
      const dep = db2.deposits?.find(d => d.id === orderId);
      if (dep && dep.status === 'Pending') {
        dep.status = 'Lunas';
        writeDB(db2);
        updateUserSaldo(dep.userId, dep.nominal, from);
      }
      delete sessions[`dep_${orderId}`];

      bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => { });
      bot.sendMessage(trx.chatId,
        `✅ *PEMBAYARAN DEPOSIT BERHASIL!*\n${'─'.repeat(25)}\n\n` +
        `💵 *Nominal Deposit:* Rp${nominal.toLocaleString('id-ID')}\n` +
        `💰 *Dibayar:* Rp${totalFinal.toLocaleString('id-ID')}\n` +
        `📋 *Order ID:* \`${orderId}\`\n\nSaldo deposit Anda telah dicatat. 🎉`,
        { parse_mode: 'Markdown', ...ik([[btn('📊 History Deposit', 'history_deposit')], [btn('🏠 Home', 'go_home')]]) }
      ).catch(() => { });

      const uname = from.username ? `@${from.username}` : from.first_name;
      bot.sendMessage(OWNER_ID,
        `✅ *DEPOSIT OTOMATIS LUNAS (Pakasir)*\n${'─'.repeat(25)}\n` +
        `👤 User: ${uname} (${userId})\n` +
        `💵 Nominal: Rp${nominal.toLocaleString('id-ID')}\n` +
        `💰 Total: Rp${totalFinal.toLocaleString('id-ID')}\n` +
        `📋 Order: \`${orderId}\``,
        { parse_mode: 'Markdown' }
      ).catch(() => { });
    }
  }, 5000);

  sessions[`dep_${orderId}`] = {
    type: 'pending_deposit', userId, nominal, totalInput, orderId,
    qrMsgId: qrMsg.message_id, chatId, expiredAt, intervalId
  };

  const uname = from.username ? `@${from.username}` : from.first_name;
  bot.sendMessage(OWNER_ID,
    `💰 *DEPOSIT BARU (Pakasir)*\n${'─'.repeat(25)}\n` +
    `👤 ${uname} (${userId})\n` +
    `💵 Nominal: Rp${nominal.toLocaleString('id-ID')}\n` +
    `💰 Total (+Pajak): Rp${totalFinal.toLocaleString('id-ID')}\n` +
    `📋 Order: \`${orderId}\`\n\n` +
    `Menunggu pembayaran otomatis dari user...`,
    {
      parse_mode: 'Markdown',
      ...ik([[btn('✅ Konfirmasi Manual', `confirm_dep_${orderId}`), btn('❌ Tolak', `reject_dep_${orderId}`)]]),
    }
  ).catch(() => { });
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

      return bot.sendMessage(chatId,
        `✅ *Item Ditambahkan!*\n${'─'.repeat(25)}\n` +
        `🏷️ ${name} | 📁 ${category}\n` +
        `💰 Harga: Rp${price.toLocaleString('id-ID')}\n` +
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
// PROSES EDITITEM (session-based, dipakai oleh text handler)
// ================================================================
async function processEditItem(chatId, userId, text) {
  const sess = sessions[userId];
  if (!sess || sess.type !== 'edititem') return bot.sendMessage(chatId, '⚠️ Sesi edit hilang. Buka detail item lalu tekan ✏️ Edit lagi.');

  const db = readDB();
  const item = db.items.find(i => i.id === sess.itemId);
  if (!item) {
    delete sessions[userId];
    return bot.sendMessage(chatId, '⚠️ Item tidak ditemukan (mungkin sudah dihapus).');
  }

  switch (sess.field) {
    case 'name': {
      item.name = text;
      break;
    }

    case 'price': {
      const p = Number(text);
      if (isNaN(p) || p < 0) return bot.sendMessage(chatId, '⚠️ Harga harus angka positif. Kirim ulang:');
      item.price = p;
      break;
    }

    case 'stock': {
      const s = Number(text);
      if (isNaN(s) || s < 0) return bot.sendMessage(chatId, '⚠️ Stok harus angka positif. Kirim ulang:');
      item.stock = s;
      item.status = s > 0 ? 'Tersedia' : 'Habis';
      break;
    }

    case 'description': {
      item.description = text;
      break;
    }

    case 'extra': {
      // Kalau sebelumnya user juga mengganti kategori (lewat edit_setcat_...),
      // sess.newCategory akan berisi kategori baru.
      if (sess.newCategory && sess.newCategory !== item.category) {
        // Bersihkan field lama sesuai kategori sebelumnya
        if (item.category === 'Bermassa') delete item.waktu; else delete item.count;
        item.category = sess.newCategory;
      }
      if (item.category === 'Bermassa') item.waktu = text; else item.count = text;
      break;
    }

    default: {
      delete sessions[userId];
      return bot.sendMessage(chatId, '⚠️ Field edit tidak dikenali.');
    }
  }

  writeDB(db);
  const fromPage = sess.fromPage || 1;
  const fieldLabel = EDIT_FIELD_LABELS[sess.field] || sess.field;
  delete sessions[userId];

  return bot.sendMessage(chatId,
    `✅ *${fieldLabel} berhasil diperbarui!*\n${'─'.repeat(25)}\n\n` +
    `🏷️ *Nama:* ${item.name}\n` +
    `📁 *Kategori:* ${item.category}\n` +
    `💰 *Harga:* Rp${item.price.toLocaleString('id-ID')}\n` +
    `📊 *Stok:* ${item.stock}\n` +
    `📝 *Deskripsi:* ${item.description}`,
    {
      parse_mode: 'Markdown',
      ...ik([
        [btn('✏️ Edit Field Lain', `help_edit_${item.id}_${fromPage}`)],
        [btn('📦 Lihat Detail', `detail_${item.id}_${fromPage}`)],
        [btn('🏠 Home', 'go_home')],
      ]),
    }
  );
}

// ================================================================
// PROSES EDIT HOME (session-based, field teks saja — logo lewat foto)
// ================================================================
async function processEditHome(chatId, userId, text) {
  const sess = sessions[userId];
  if (!sess || sess.type !== 'edithome') return bot.sendMessage(chatId, '⚠️ Sesi edit home hilang. Buka Home lalu tekan ⚙️ Edit Tampilan Home lagi.');

  if (sess.field === 'logo') {
    return bot.sendMessage(chatId, '⚠️ Untuk logo, kirim *foto*, bukan teks. Atau ketik /start untuk batal.', { parse_mode: 'Markdown' });
  }

  const value = text.trim();
  if (!value) return bot.sendMessage(chatId, '⚠️ Tidak boleh kosong. Kirim ulang:');

  saveSetting(sess.field, value);
  const fieldLabel = EDIT_HOME_FIELD_LABELS[sess.field] || sess.field;
  delete sessions[userId];

  await bot.sendMessage(chatId, `✅ *${fieldLabel} berhasil diperbarui!*`, {
    parse_mode: 'Markdown',
    ...ik([[btn('⚙️ Edit Lagi', 'edithome_menu')], [btn('🏠 Lihat Home', 'go_home')]]),
  });
}

// ================================================================
// CALLBACK QUERY ROUTER (pengganti bot.action dari Telegraf)
// ================================================================
const callbackRoutes = [
  { re: /^go_home$/, fn: async (q) => { await sendHome(q.message.chat.id, q.from, q.message.message_id); } },
  { re: /^noop$/, fn: async () => { } },

  {
    re: /^info_bot$/, fn: async (q) => {
      const settings = getSettings();
      await editMsg(q.message.chat.id, q.message.message_id,
        `🤖 *${settings.botName}*\n${'─'.repeat(25)}\n\n` +
        `📌 Bot katalog & topup produk digital.\n\n` +
        `💳 *Pembayaran:* ${settings.paymentInfo}\n` +
        `👤 *Owner:* ${settings.ownerUsername}\n🔖 *Versi:* 3.0.0  ⚡ Online`,
        ik([[btn('🏠 Home', 'go_home')]])
      );
    }
  },

  {
    re: /^page_(\d+)$/, fn: async (q, m) => {
      const cat = buildCatalog(Number(m[1]));
      await editMsg(q.message.chat.id, q.message.message_id, cat.text, cat.extra);
    }
  },

  {
    re: /^detail_(\d+)_(\d+)$/, fn: async (q, m) => {
      const itemId = Number(m[1]), fromPage = Number(m[2]);
      const item = readDB().items.find(i => i.id === itemId);
      if (!item) return bot.sendMessage(q.message.chat.id, '⚠️ Item tidak ditemukan.');

      const catE = item.category === 'Topup Game' ? '💎' : item.category === 'Topup Pulsa' ? '📱' : '🏢';
      const badge = item.stock > 0 ? '🟢 Tersedia' : '🔴 Habis';
      let xtraLine = '';
      if (item.category === 'Bermassa' && item.waktu) xtraLine = `⏳ *Durasi:* ${item.waktu}\n`;
      else if (item.count) xtraLine = `🔢 *Jumlah:* ${item.count}\n`;

      const txt =
        `📦 *DETAIL PRODUK*\n${'─'.repeat(25)}\n` +
        `🆔 *ID:* \`${item.id}\`\n` +
        `🏷️ *Nama:* ${item.name}\n` +
        `📁 *Kategori:* ${catE} ${item.category}\n` +
        xtraLine +
        `💰 *Harga:* Rp${item.price.toLocaleString('id-ID')}\n` +
        `📊 *Stok:* ${item.stock} (${badge})\n` +
        `${'─'.repeat(25)}\n📝 *Deskripsi:*\n_${item.description}_`;

      const rows = [];
      if (item.stock > 0) {
        rows.push([
          btn('🛒 Beli via QRIS', `buy_${item.id}_${fromPage}`),
          btn('💰 Bayar via Saldo', `buy_saldo_${item.id}_${fromPage}`)
        ]);
      } else {
        rows.push([btn('❌ Stok Habis', 'noop')]);
      }
      if (q.from.id === OWNER_ID) {
        rows.push([btn('✏️ Edit', `help_edit_${item.id}_${fromPage}`), btn('🗑️ Hapus', `confirm_delete_${item.id}_${fromPage}`)]);
      }
      rows.push([btn('⬅️ Katalog', `page_${fromPage}`), btn('🏠 Home', 'go_home')]);

      await editMsg(q.message.chat.id, q.message.message_id, txt, ik(rows));
    }
  },

  {
    re: /^buy_(\d+)_(\d+)$/, fn: async (q, m) => {
      const itemId = Number(m[1]), fromPage = Number(m[2]);
      const chatId = q.message.chat.id, userId = q.from.id;
      const db = readDB();
      const item = db.items.find(i => i.id === itemId);

      if (!item) return bot.sendMessage(chatId, '⚠️ Item tidak ditemukan.');
      if (item.stock <= 0) return bot.sendMessage(chatId, '❌ Stok habis.');

      const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

      let cqris;
      try {
        cqris = await createQrisPakasir(orderId, item.price);
      } catch (e) {
        console.error('Pakasir order error:', e);
        return bot.sendMessage(chatId, `❌ Gagal membuat QRIS: ${e.message}`);
      }

      const totalInput = cqris.totalInput;
      const totalFinal = cqris.total_payment || totalInput;

      if (!db.orders) db.orders = [];
      db.orders.push({
        orderId, userId, itemId, itemName: item.name, category: item.category,
        price: item.price, totalBayar: totalFinal, status: 'Pending', timestamp: Date.now(),
      });
      writeDB(db);

      const expiredAt = new Date();
      expiredAt.setMinutes(expiredAt.getMinutes() + PAKASIR_CONFIG.expiredMinutes);
      const expStr = expiredAt.toLocaleTimeString('id-ID', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta'
      });

      const qrImageUrl = getQrCodeImageUrl(cqris.payment_number);

      const caption =
        `💳 *PEMBAYARAN QRIS PAKASIR*\n${'─'.repeat(25)}\n\n` +
        `📦 *Produk:* ${item.name}\n` +
        `💵 *Harga Produk:* Rp${item.price.toLocaleString('id-ID')}\n` +
        `💰 *TOTAL TAGIHAN:* Rp${totalFinal.toLocaleString('id-ID')}\n` +
        `📋 *Order ID:* \`${orderId}\`\n` +
        `⏳ *Expired:* ${expStr} WIB\n\n` +
        `*Scan QR di atas* menggunakan aplikasi e-wallet / m-banking Anda.\n` +
        `_Sistem akan otomatis mendeteksi pembayaran Anda._`;

      let qrMsg;
      try {
        qrMsg = await bot.sendPhoto(chatId, qrImageUrl, {
          caption, parse_mode: 'Markdown',
          ...ik([
            [btn('🔔 Saya Sudah Bayar', `notify_order_${orderId}`)],
            [btn('❌ Batalkan', `cancel_order_${orderId}`)],
          ]),
        });
      } catch (e) {
        return bot.sendMessage(chatId, `❌ Gagal kirim QR: ${e.message}`);
      }

      const intervalId = setInterval(async () => {
        const trx = sessions[`order_${orderId}`];
        if (!trx) {
          clearInterval(intervalId);
          return;
        }

        if (new Date() >= trx.expiredAt) {
          clearInterval(intervalId);
          delete sessions[`order_${orderId}`];
          const db2 = readDB();
          const ord = db2.orders?.find(o => o.orderId === orderId);
          if (ord && ord.status === 'Pending') ord.status = 'Expired';
          writeDB(db2);

          bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => { });
          bot.sendMessage(trx.chatId,
            `⚠️ *QRIS Expired*\nOrder \`${orderId}\` telah kedaluwarsa. Silakan beli ulang.`,
            { parse_mode: 'Markdown' }
          ).catch(() => { });
          return;
        }

        const res = await checkStatusPakasir(orderId, totalInput);
        if (res && res.status === 'completed') {
          clearInterval(intervalId);
          const db2 = readDB();
          const ord = db2.orders?.find(o => o.orderId === orderId);
          if (ord && ord.status === 'Pending') {
            const itemInDb = db2.items.find(i => i.id === ord.itemId);
            if (itemInDb) {
              itemInDb.stock -= 1;
              if (itemInDb.stock <= 0) itemInDb.status = 'Habis';
            }
            ord.status = 'Lunas';
            writeDB(db2);
          }
          delete sessions[`order_${orderId}`];

          bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => { });
          bot.sendMessage(trx.chatId,
            `✅ *PEMBAYARAN BERHASIL!*\n${'─'.repeat(25)}\n\n` +
            `📦 *Produk:* ${ord.itemName}\n` +
            `💰 *Total Dibayar:* Rp${totalFinal.toLocaleString('id-ID')}\n` +
            `📋 *Order ID:* \`${orderId}\`\n\n` +
            `Hubungi ${OWNER_USERNAME} untuk proses pengiriman produk.`,
            { parse_mode: 'Markdown', ...ik([[btn('📜 History Order', 'history_order')], [btn('🏠 Home', 'go_home')]]) }
          ).catch(() => { });

          const uname = q.from.username ? `@${q.from.username}` : q.from.first_name;
          bot.sendMessage(OWNER_ID,
            `✅ *PESANAN OTOMATIS LUNAS (Pakasir)*\n${'─'.repeat(25)}\n` +
            `👤 User: ${uname} (${userId})\n` +
            `📦 ${ord.itemName}\n` +
            `💰 Rp${totalFinal.toLocaleString('id-ID')}\n` +
            `📋 Order: \`${orderId}\``,
            { parse_mode: 'Markdown' }
          ).catch(() => { });
        }
      }, 5000);

      sessions[`order_${orderId}`] = {
        type: 'pending_order', userId, itemId, fromPage, orderId, totalInput,
        qrMsgId: qrMsg.message_id, chatId, expiredAt, intervalId
      };

      const uname = q.from.username ? `@${q.from.username}` : q.from.first_name;
      bot.sendMessage(OWNER_ID,
        `🛒 *PESANAN BARU (Pakasir)*\n${'─'.repeat(20)}\n` +
        `👤 User: ${uname} (${userId})\n` +
        `📦 ${item.name}\n` +
        `💰 Rp${totalFinal.toLocaleString('id-ID')}\n` +
        `📋 Order: \`${orderId}\`\n\n` +
        `Menunggu pembayaran otomatis dari user...`,
        {
          parse_mode: 'Markdown',
          ...ik([[btn('✅ Konfirmasi Manual', `confirm_order_${orderId}`), btn('❌ Tolak', `reject_order_${orderId}`)]]),
        }
      ).catch(() => { });
    }
  },

  // ── Buyer klik "🔔 Saya Sudah Bayar" → kirim reminder ke owner ──
  {
    re: /^notify_order_(.+)$/, fn: async (q, m) => {
      const orderId = m[1];
      const uname = q.from.username ? `@${q.from.username}` : q.from.first_name;
      await bot.sendMessage(OWNER_ID,
        `🔔 *Reminder:* ${uname} bilang sudah bayar untuk order \`${orderId}\`.\nSegera cek & konfirmasi:`,
        { parse_mode: 'Markdown', ...ik([[btn('✅ Konfirmasi Lunas', `confirm_order_${orderId}`), btn('❌ Tolak', `reject_order_${orderId}`)]]) }
      ).catch(() => { });
    }, cbText: '🔔 Admin sudah diberitahu'
  },

  // ── Owner konfirmasi order lunas ──
  {
    re: /^confirm_order_(.+)$/, fn: async (q, m) => {
      const orderId = m[1];
      const trx = sessions[`order_${orderId}`];
      if (trx && trx.intervalId) clearInterval(trx.intervalId);
      const db = readDB();
      const ord = db.orders?.find(o => o.orderId === orderId);
      if (!ord) return bot.sendMessage(q.message.chat.id, '⚠️ Order tidak ditemukan.');
      if (ord.status !== 'Pending') return bot.sendMessage(q.message.chat.id, `⚠️ Status order ini sudah *${ord.status}*.`, { parse_mode: 'Markdown' });

      const item = db.items.find(i => i.id === ord.itemId);
      if (item) {
        item.stock -= 1;
        if (item.stock <= 0) item.status = 'Habis';
      }
      ord.status = 'Lunas';
      writeDB(db);
      delete sessions[`order_${orderId}`];

      const targetChat = trx ? trx.chatId : ord.userId;
      if (trx) bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => { });
      bot.sendMessage(targetChat,
        `✅ *PEMBAYARAN DIKONFIRMASI!*\n${'─'.repeat(25)}\n\n` +
        `📦 *Produk:* ${ord.itemName}\n` +
        `💰 *Dibayar:* Rp${ord.price.toLocaleString('id-ID')}\n` +
        `📋 *Order ID:* \`${orderId}\`\n\n` +
        `Hubungi ${OWNER_USERNAME} untuk proses pengiriman produk.`,
        { parse_mode: 'Markdown', ...ik([[btn('📜 History Order', 'history_order')], [btn('🏠 Home', 'go_home')]]) }
      ).catch(() => { });

      await editMsg(q.message.chat.id, q.message.message_id,
        `✅ *Order \`${orderId}\` dikonfirmasi LUNAS.*\n📊 Sisa stok: ${item ? item.stock : '-'}`,
        ik([[btn('🏠 Home', 'go_home')]])
      );
    }, cbText: '✅ Dikonfirmasi', ownerOnly: true
  },

  // ── Owner tolak/batalkan order ──
  {
    re: /^reject_order_(.+)$/, fn: async (q, m) => {
      const orderId = m[1];
      const trx = sessions[`order_${orderId}`];
      if (trx && trx.intervalId) clearInterval(trx.intervalId);
      const db = readDB();
      const ord = db.orders?.find(o => o.orderId === orderId);
      if (!ord) return bot.sendMessage(q.message.chat.id, '⚠️ Order tidak ditemukan.');
      if (ord.status !== 'Pending') return bot.sendMessage(q.message.chat.id, `⚠️ Status order ini sudah *${ord.status}*.`, { parse_mode: 'Markdown' });

      ord.status = 'Ditolak';
      writeDB(db);
      delete sessions[`order_${orderId}`];

      const targetChat = trx ? trx.chatId : ord.userId;
      if (trx) bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => { });
      bot.sendMessage(targetChat,
        `❌ *Pembayaran Ditolak*\nOrder \`${orderId}\` tidak dapat dikonfirmasi admin.\nHubungi ${OWNER_USERNAME} bila ini keliru.`,
        { parse_mode: 'Markdown' }
      ).catch(() => { });

      await editMsg(q.message.chat.id, q.message.message_id,
        `❌ *Order \`${orderId}\` ditolak.*`, ik([[btn('🏠 Home', 'go_home')]])
      );
    }, cbText: '❌ Ditolak', ownerOnly: true
  },

  {
    re: /^cancel_order_(.+)$/, fn: async (q, m) => {
      const orderId = m[1];
      const trx = sessions[`order_${orderId}`];
      if (trx && trx.intervalId) clearInterval(trx.intervalId);
      delete sessions[`order_${orderId}`];
      const db = readDB();
      const ord = db.orders?.find(o => o.orderId === orderId);
      if (ord && ord.status === 'Pending') ord.status = 'Dibatalkan';
      writeDB(db);
      try { await bot.deleteMessage(q.message.chat.id, q.message.message_id); } catch (_) { }
      await bot.sendMessage(q.message.chat.id, '❌ Order dibatalkan.', ik([[btn('🏠 Home', 'go_home')]]));
    }, cbText: '❌ Order dibatalkan'
  },

  {
    re: /^deposit_menu$/, fn: async (q) => {
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
    }
  },

  {
    re: /^dep_(10000|20000|50000|100000|200000|500000)$/, fn: async (q, m) => {
      await prosesDeposit(q.message.chat.id, q.from, Number(m[1]));
    }
  },

  {
    re: /^dep_custom$/, fn: async (q) => {
      sessions[q.from.id] = { type: 'deposit_custom' };
      await editMsg(q.message.chat.id, q.message.message_id,
        `✏️ *Nominal Custom*\n\nKirim nominal deposit (min Rp10.000):\nContoh: ` + '`50000`',
        ik([[btn('❌ Batal', 'deposit_menu')]])
      );
    }
  },

  {
    re: /^cancel_dep_(.+)$/, fn: async (q, m) => {
      const orderId = m[1];
      const trx = sessions[`dep_${orderId}`];
      if (trx && trx.intervalId) clearInterval(trx.intervalId);
      delete sessions[`dep_${orderId}`];
      const db = readDB();
      const dep = db.deposits?.find(d => d.id === orderId);
      if (dep && dep.status === 'Pending') dep.status = 'Cancelled';
      writeDB(db);
      try { await bot.deleteMessage(q.message.chat.id, q.message.message_id); } catch (_) { }
      await bot.sendMessage(q.message.chat.id, '❌ Deposit dibatalkan.',
        ik([[btn('💰 Deposit Lagi', 'deposit_menu')], [btn('🏠 Home', 'go_home')]]));
    }, cbText: '❌ Deposit dibatalkan'
  },

  // ── Buyer klik "🔔 Saya Sudah Bayar" (deposit) → reminder ke owner ──
  {
    re: /^notify_dep_(.+)$/, fn: async (q, m) => {
      const orderId = m[1];
      const uname = q.from.username ? `@${q.from.username}` : q.from.first_name;
      await bot.sendMessage(OWNER_ID,
        `🔔 *Reminder:* ${uname} bilang sudah bayar untuk deposit \`${orderId}\`.\nSegera cek & konfirmasi:`,
        { parse_mode: 'Markdown', ...ik([[btn('✅ Konfirmasi Lunas', `confirm_dep_${orderId}`), btn('❌ Tolak', `reject_dep_${orderId}`)]]) }
      ).catch(() => { });
    }, cbText: '🔔 Admin sudah diberitahu'
  },

  // ── Owner konfirmasi deposit lunas ──
  {
    re: /^confirm_dep_(.+)$/, fn: async (q, m) => {
      const orderId = m[1];
      const trx = sessions[`dep_${orderId}`];
      if (trx && trx.intervalId) clearInterval(trx.intervalId);
      const db = readDB();
      const dep = db.deposits?.find(d => d.id === orderId);
      if (!dep) return bot.sendMessage(q.message.chat.id, '⚠️ Deposit tidak ditemukan.');
      if (dep.status !== 'Pending') return bot.sendMessage(q.message.chat.id, `⚠️ Status deposit ini sudah *${dep.status}*.`, { parse_mode: 'Markdown' });

      dep.status = 'Lunas';
      writeDB(db);
      updateUserSaldo(dep.userId, dep.nominal, q.from);
      delete sessions[`dep_${orderId}`];

      const targetChat = trx ? trx.chatId : dep.userId;
      if (trx) bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => { });
      bot.sendMessage(targetChat,
        `✅ *DEPOSIT DIKONFIRMASI!*\n${'─'.repeat(25)}\n\n` +
        `💵 *Nominal:* Rp${dep.nominal.toLocaleString('id-ID')}\n` +
        `📋 *Order ID:* \`${orderId}\`\n\nSaldo deposit Anda telah dicatat. 🎉`,
        { parse_mode: 'Markdown', ...ik([[btn('📊 History Deposit', 'history_deposit')], [btn('🏠 Home', 'go_home')]]) }
      ).catch(() => { });

      await editMsg(q.message.chat.id, q.message.message_id,
        `✅ *Deposit \`${orderId}\` dikonfirmasi LUNAS.*`, ik([[btn('🏠 Home', 'go_home')]])
      );
    }, cbText: '✅ Dikonfirmasi', ownerOnly: true
  },

  // ── Owner tolak deposit ──
  {
    re: /^reject_dep_(.+)$/, fn: async (q, m) => {
      const orderId = m[1];
      const trx = sessions[`dep_${orderId}`];
      if (trx && trx.intervalId) clearInterval(trx.intervalId);
      const db = readDB();
      const dep = db.deposits?.find(d => d.id === orderId);
      if (!dep) return bot.sendMessage(q.message.chat.id, '⚠️ Deposit tidak ditemukan.');
      if (dep.status !== 'Pending') return bot.sendMessage(q.message.chat.id, `⚠️ Status deposit ini sudah *${dep.status}*.`, { parse_mode: 'Markdown' });

      dep.status = 'Ditolak';
      writeDB(db);
      delete sessions[`dep_${orderId}`];

      const targetChat = trx ? trx.chatId : dep.userId;
      if (trx) bot.deleteMessage(trx.chatId, trx.qrMsgId).catch(() => { });
      bot.sendMessage(targetChat,
        `❌ *Deposit Ditolak*\nOrder \`${orderId}\` tidak dapat dikonfirmasi admin.\nHubungi ${OWNER_USERNAME} bila ini keliru.`,
        { parse_mode: 'Markdown' }
      ).catch(() => { });

      await editMsg(q.message.chat.id, q.message.message_id,
        `❌ *Deposit \`${orderId}\` ditolak.*`, ik([[btn('🏠 Home', 'go_home')]])
      );
    }, cbText: '❌ Ditolak', ownerOnly: true
  },

  {
    re: /^history_order$/, fn: async (q) => {
      const db = readDB();
      const orders = (db.orders || []).filter(o => o.userId === q.from.id && o.status === 'Lunas');
      const kb = ik([[btn('🏠 Home', 'go_home')]]);

      let txt;
      if (!orders.length) {
        txt = '📭 *Belum ada order.*\n\nBelum pernah melakukan pembelian.';
      } else {
        txt = `📜 *History Order*\n${'─'.repeat(25)}\n`;
        orders.slice(-10).reverse().forEach((o, i) => {
          const e = o.category === 'Topup Game' ? '💎' : o.category === 'Topup Pulsa' ? '📱' : '🏢';
          const dt = new Date(o.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
          txt += `\n${i + 1}. ${e} *${o.itemName}*\n` +
            `   💰 Rp${o.price.toLocaleString('id-ID')} • ${dt}\n` +
            `   📋 \`${o.orderId || '-'}\`\n`;
        });
        txt += `\n_${Math.min(10, orders.length)} dari ${orders.length} order_`;
      }
      await editMsg(q.message.chat.id, q.message.message_id, txt, kb);
    }
  },

  {
    re: /^history_deposit$/, fn: async (q) => {
      const db = readDB();
      const deps = (db.deposits || []).filter(d => d.userId === q.from.id);
      const kb = ik([[btn('💰 Deposit Baru', 'deposit_menu')], [btn('🏠 Home', 'go_home')]]);

      let txt;
      if (!deps.length) {
        txt = '📭 *Belum ada deposit.*\n\nTekan tombol di bawah untuk deposit pertama Anda.';
      } else {
        txt = `📊 *History Deposit*\n${'─'.repeat(25)}\n`;
        deps.slice(-10).reverse().forEach((d, i) => {
          const e = d.status === 'Lunas' ? '✅' : d.status === 'Expired' ? '⏰' : (d.status === 'Cancelled' || d.status === 'Ditolak') ? '❌' : '⏳';
          const dt = new Date(d.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
          txt += `\n${i + 1}. ${e} *Rp${d.nominal.toLocaleString('id-ID')}*\n` +
            `   Status: *${d.status}* • ${dt}\n`;
        });
        txt += `\n_${Math.min(10, deps.length)} dari ${deps.length} deposit_`;
      }
      await editMsg(q.message.chat.id, q.message.message_id, txt, kb);
    }
  },

  {
    re: /^support_ticket$/, fn: async (q) => {
      sessions[q.from.id] = { type: 'ticket', active: true };
      await editMsg(q.message.chat.id, q.message.message_id,
        `🎫 *Tiket Support ${getSettings().botName}*\n${'─'.repeat(25)}\n\n` +
        `Kirim pesan Anda sekarang.\n` +
        `Pesan diteruskan ke admin secara *anonim*.\n\n` +
        `_Ketik /endticket untuk menutup tiket_`,
        ik([[btn('🔒 Tutup Tiket', 'close_ticket')], [btn('🏠 Home', 'go_home')]])
      );
    }
  },

  {
    re: /^close_ticket$/, fn: async (q) => {
      delete sessions[q.from.id];
      await bot.sendMessage(q.message.chat.id, '🔒 Tiket ditutup. Terima kasih!');
      await sendHome(q.message.chat.id, q.from);
    }
  },

  {
    re: /^add_cat_bermassa$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      const sess = sessions[q.from.id];
      if (!sess || sess.step !== 'category') return bot.sendMessage(q.message.chat.id, '⚠️ Sesi tidak valid. /additem');
      sess.data.category = 'Bermassa'; sess.step = 'extra';
      await bot.editMessageText('📝 *Langkah 3/6: Durasi*\n\nContoh: `1 Bulan`, `3 Hari`', {
        chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown',
      });
    }, cbText: '✅ Bermassa', ownerOnly: true
  },

  {
    re: /^add_cat_topupgame$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      const sess = sessions[q.from.id];
      if (!sess || sess.step !== 'category') return bot.sendMessage(q.message.chat.id, '⚠️ Sesi tidak valid. /additem');
      sess.data.category = 'Topup Game'; sess.step = 'extra';
      await bot.editMessageText('💎 *Langkah 3/6: Jumlah*\n\nContoh: `100 Diamond`, `60 UC`', {
        chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown',
      });
    }, cbText: '✅ Topup Game', ownerOnly: true
  },

  {
    re: /^add_cat_topuppulsa$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      const sess = sessions[q.from.id];
      if (!sess || sess.step !== 'category') return bot.sendMessage(q.message.chat.id, '⚠️ Sesi tidak valid. /additem');
      sess.data.category = 'Topup Pulsa'; sess.step = 'extra';
      await bot.editMessageText('📱 *Langkah 3/6: Nominal/Kuota*\n\nContoh: `Rp100.000`, `10GB`', {
        chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'Markdown',
      });
    }, cbText: '✅ Topup Pulsa', ownerOnly: true
  },

  {
    re: /^cancel_additem$/, fn: async (q) => {
      delete sessions[q.from.id];
      await bot.editMessageText('❌ Tambah item dibatalkan.', {
        chat_id: q.message.chat.id, message_id: q.message.message_id,
        ...ik([[btn('🏠 Home', 'go_home')]]),
      });
    }, cbText: '❌ Dibatalkan'
  },

  {
    re: /^restart_additem$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      delete sessions[q.from.id];
      sessions[q.from.id] = { type: 'additem', step: 'name', data: {} };
      await bot.sendMessage(q.message.chat.id, '📝 *Tambah Item — Langkah 1/6*\n\nKirim *nama item*:', { parse_mode: 'Markdown' });
    }, ownerOnly: true
  },

  {
    re: /^help_add$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return bot.sendMessage(q.message.chat.id, '⛔ Hanya owner.');
      await bot.sendMessage(q.message.chat.id, '📌 Ketik `/additem` dan ikuti langkah-langkah.', { parse_mode: 'Markdown' });
    }
  },

  // ── EDIT ITEM: langkah 1 — tanya field mana yang mau diedit ──
  {
    re: /^help_edit_(\d+)_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const itemId = Number(m[1]), fromPage = Number(m[2]);
      const item = readDB().items.find(i => i.id === itemId);
      if (!item) return bot.sendMessage(q.message.chat.id, '⚠️ Item tidak ditemukan.');

      delete sessions[q.from.id]; // pastikan tidak ada sesi lain yang nyangkut

      const xtraLabel = item.category === 'Bermassa' ? item.waktu : item.count;
      const txt =
        `✏️ *Edit Item: ${item.name}*\n${'─'.repeat(25)}\n\n` +
        `🆔 ID: \`${item.id}\`\n` +
        `📁 Kategori: ${item.category}\n` +
        `⏳🔢 Field Tambahan: ${xtraLabel || '-'}\n` +
        `💰 Harga: Rp${item.price.toLocaleString('id-ID')}\n` +
        `📊 Stok: ${item.stock}\n` +
        `📝 Deskripsi: ${item.description}\n\n` +
        `*Pilih field yang ingin diedit:*`;

      await editMsg(q.message.chat.id, q.message.message_id, txt, ik([
        [btn('🏷️ Nama', `edit_field_name_${itemId}_${fromPage}`), btn('📁 Kategori', `edit_field_category_${itemId}_${fromPage}`)],
        [btn('⏳🔢 Field Tambahan', `edit_field_extra_${itemId}_${fromPage}`), btn('💰 Harga', `edit_field_price_${itemId}_${fromPage}`)],
        [btn('📊 Stok', `edit_field_stock_${itemId}_${fromPage}`), btn('📝 Deskripsi', `edit_field_description_${itemId}_${fromPage}`)],
        [btn('❌ Batal', `detail_${itemId}_${fromPage}`)],
      ]));
    }, ownerOnly: true
  },

  // ── EDIT ITEM: langkah 2 — user pilih field, minta input baru ──
  {
    re: /^edit_field_(name|extra|price|stock|description)_(\d+)_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const field = m[1], itemId = Number(m[2]), fromPage = Number(m[3]);
      const item = readDB().items.find(i => i.id === itemId);
      if (!item) return bot.sendMessage(q.message.chat.id, '⚠️ Item tidak ditemukan.');

      sessions[q.from.id] = { type: 'edititem', field, itemId, fromPage };

      const prompts = {
        name: `🏷️ *Edit Nama*\n\nNama saat ini: *${item.name}*\n\nKirim nama baru:`,
        extra: item.category === 'Bermassa'
          ? `⏳ *Edit Durasi*\n\nDurasi saat ini: *${item.waktu || '-'}*\n\nKirim durasi baru:\nContoh: \`1 Bulan\`, \`3 Hari\``
          : `🔢 *Edit Jumlah*\n\nJumlah saat ini: *${item.count || '-'}*\n\nKirim jumlah baru:\nContoh: \`100 Diamond\`, \`10GB\``,
        price: `💰 *Edit Harga*\n\nHarga saat ini: *Rp${item.price.toLocaleString('id-ID')}*\n\nKirim harga baru (angka):`,
        stock: `📊 *Edit Stok*\n\nStok saat ini: *${item.stock}*\n\nKirim jumlah stok baru (angka):`,
        description: `📝 *Edit Deskripsi*\n\nDeskripsi saat ini:\n_${item.description}_\n\nKirim deskripsi baru:`,
      };

      await editMsg(q.message.chat.id, q.message.message_id, prompts[field], ik([
        [btn('❌ Batal', `help_edit_${itemId}_${fromPage}`)],
      ]));
    }, ownerOnly: true
  },

  // ── EDIT ITEM: kategori butuh sub-menu pilihan kategori baru ──
  {
    re: /^edit_field_category_(\d+)_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const itemId = Number(m[1]), fromPage = Number(m[2]);
      const item = readDB().items.find(i => i.id === itemId);
      if (!item) return bot.sendMessage(q.message.chat.id, '⚠️ Item tidak ditemukan.');

      await editMsg(q.message.chat.id, q.message.message_id,
        `📁 *Edit Kategori*\n\nKategori saat ini: *${item.category}*\n\nPilih kategori baru:`,
        ik([
          [btn('🏢 Bermassa', `edit_setcat_bermassa_${itemId}_${fromPage}`)],
          [btn('💎 Topup Game', `edit_setcat_topupgame_${itemId}_${fromPage}`)],
          [btn('📱 Topup Pulsa', `edit_setcat_topuppulsa_${itemId}_${fromPage}`)],
          [btn('❌ Batal', `help_edit_${itemId}_${fromPage}`)],
        ])
      );
    }, ownerOnly: true
  },

  // ── EDIT ITEM: kategori dipilih → lanjut minta field tambahan (waktu/count) ──
  {
    re: /^edit_setcat_(bermassa|topupgame|topuppulsa)_(\d+)_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const catMap = { bermassa: 'Bermassa', topupgame: 'Topup Game', topuppulsa: 'Topup Pulsa' };
      const newCategory = catMap[m[1]];
      const itemId = Number(m[2]), fromPage = Number(m[3]);
      const item = readDB().items.find(i => i.id === itemId);
      if (!item) return bot.sendMessage(q.message.chat.id, '⚠️ Item tidak ditemukan.');

      sessions[q.from.id] = { type: 'edititem', field: 'extra', itemId, fromPage, newCategory };

      const prompt = newCategory === 'Bermassa'
        ? `📁 Kategori baru: *${newCategory}*\n\n⏳ Kirim *durasi* untuk item ini:\nContoh: \`1 Bulan\`, \`3 Hari\``
        : `📁 Kategori baru: *${newCategory}*\n\n🔢 Kirim *jumlah* untuk item ini:\nContoh: \`100 Diamond\`, \`10GB\``;

      await editMsg(q.message.chat.id, q.message.message_id, prompt, ik([
        [btn('❌ Batal', `help_edit_${itemId}_${fromPage}`)],
      ]));
    }, ownerOnly: true
  },

  // ── EDIT HOME: menu utama ──
  {
    re: /^edithome_menu$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      delete sessions[q.from.id];
      const s = getSettings();
      const txt =
        `⚙️ *Edit Tampilan Home*\n${'─'.repeat(25)}\n\n` +
        `*Nilai saat ini:*\n\n` +
        `🏷️ Nama Bot: ${s.botName}\n` +
        `📦 Daftar Produk:\n${s.productList}\n\n` +
        `💳 Pembayaran: ${s.paymentInfo}\n` +
        `👤 Owner: ${s.ownerUsername}\n` +
        `📝 Footer: ${s.footerText}\n` +
        `🖼️ Logo: ${s.logoFileId ? 'Custom (sudah diupload)' : 'Default (media/logo.png)'}\n\n` +
        `*Pilih bagian yang ingin diedit:*`;

      await editMsg(q.message.chat.id, q.message.message_id, txt, ik([
        [btn('🏷️ Nama Bot', 'edithome_field_botName'), btn('📦 Daftar Produk', 'edithome_field_productList')],
        [btn('💳 Info Pembayaran', 'edithome_field_paymentInfo'), btn('👤 Owner', 'edithome_field_ownerUsername')],
        [btn('📝 Footer Text', 'edithome_field_footerText'), btn('🖼️ Logo', 'edithome_field_logo')],
        [btn('♻️ Reset ke Default', 'edithome_reset')],
        [btn('🏠 Kembali', 'go_home')],
      ]));
    }, ownerOnly: true
  },

  // ── EDIT HOME: pilih field teks → minta input baru ──
  {
    re: /^edithome_field_(botName|productList|paymentInfo|ownerUsername|footerText)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const field = m[1];
      const s = getSettings();
      sessions[q.from.id] = { type: 'edithome', field };

      const prompts = {
        botName: `🏷️ *Edit Nama Bot*\n\nSaat ini: *${s.botName}*\n\nKirim nama bot baru:`,
        productList: `📦 *Edit Daftar Produk*\n\nSaat ini:\n${s.productList}\n\n` +
          `Kirim daftar produk baru (satu baris per item, boleh pakai format Markdown):\n` +
          `Contoh:\n\`• 🏢 Bermassa (Akun bersama)\\n• 💎 Topup Game\``,
        paymentInfo: `💳 *Edit Info Pembayaran*\n\nSaat ini: *${s.paymentInfo}*\n\nKirim info pembayaran baru:\nContoh: \`Pakasir QRIS (otomatis)\``,
        ownerUsername: `👤 *Edit Owner*\n\nSaat ini: *${s.ownerUsername}*\n\nKirim username owner baru:\nContoh: \`@username\``,
        footerText: `📝 *Edit Footer Text*\n\nSaat ini: ${s.footerText}\n\nKirim footer text baru:\nContoh: \`_Pilih menu di bawah ini:_\``,
      };

      await editMsg(q.message.chat.id, q.message.message_id, prompts[field], ik([
        [btn('❌ Batal', 'edithome_menu')],
      ]));
    }, ownerOnly: true
  },

  // ── EDIT HOME: logo minta kirim foto ──
  {
    re: /^edithome_field_logo$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      sessions[q.from.id] = { type: 'edithome', field: 'logo' };
      await editMsg(q.message.chat.id, q.message.message_id,
        `🖼️ *Edit Logo*\n\nKirim *foto* yang ingin dijadikan logo home baru (kirim sebagai foto, bukan file/dokumen).`,
        ik([[btn('❌ Batal', 'edithome_menu')]])
      );
    }, ownerOnly: true
  },

  // ── EDIT HOME: reset ke default ──
  {
    re: /^edithome_reset$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      resetSettings();
      await bot.sendMessage(q.message.chat.id, '♻️ Tampilan Home direset ke default.');
      const s = getSettings();
      const txt =
        `⚙️ *Edit Tampilan Home*\n${'─'.repeat(25)}\n\n` +
        `*Nilai saat ini:*\n\n` +
        `🏷️ Nama Bot: ${s.botName}\n` +
        `📦 Daftar Produk:\n${s.productList}\n\n` +
        `💳 Pembayaran: ${s.paymentInfo}\n` +
        `👤 Owner: ${s.ownerUsername}\n` +
        `📝 Footer: ${s.footerText}\n` +
        `🖼️ Logo: Default (media/logo.png)\n\n` +
        `*Pilih bagian yang ingin diedit:*`;
      await bot.sendMessage(q.message.chat.id, txt, {
        parse_mode: 'Markdown',
        ...ik([
          [btn('🏷️ Nama Bot', 'edithome_field_botName'), btn('📦 Daftar Produk', 'edithome_field_productList')],
          [btn('💳 Info Pembayaran', 'edithome_field_paymentInfo'), btn('👤 Owner', 'edithome_field_ownerUsername')],
          [btn('📝 Footer Text', 'edithome_field_footerText'), btn('🖼️ Logo', 'edithome_field_logo')],
          [btn('🏠 Kembali', 'go_home')],
        ]),
      });
    }, cbText: '♻️ Direset', ownerOnly: true
  },

  // ── BUY VIA SALDO ──
  {
    re: /^buy_saldo_(\d+)_(\d+)$/, fn: async (q, m) => {
      const itemId = Number(m[1]), fromPage = Number(m[2]);
      const chatId = q.message.chat.id, userId = q.from.id;
      const db = readDB();
      const item = db.items.find(i => i.id === itemId);

      if (!item) return bot.sendMessage(chatId, '⚠️ Item tidak ditemukan.');
      if (item.stock <= 0) return bot.sendMessage(chatId, '❌ Stok habis.');

      const saldo = getUserSaldo(userId);
      if (saldo < item.price) {
        return editMsg(chatId, q.message.message_id,
          `⚠️ *Saldo Tidak Cukup!*\n${'─'.repeat(25)}\n\n` +
          `📦 *Produk:* ${item.name}\n` +
          `💵 *Harga:* Rp${item.price.toLocaleString('id-ID')}\n` +
          `💰 *Saldo Anda:* Rp${saldo.toLocaleString('id-ID')}\n` +
          `❌ *Kurang:* Rp${(item.price - saldo).toLocaleString('id-ID')}\n\n` +
          `Silakan deposit saldo terlebih dahulu:`,
          ik([[btn('💰 Deposit Saldo', 'deposit_menu')], [btn('🛒 Beli via QRIS', `buy_${itemId}_${fromPage}`)], [btn('🏠 Home', 'go_home')]])
        );
      }

      updateUserSaldo(userId, -item.price, q.from);
      item.stock -= 1;
      if (item.stock <= 0) item.status = 'Habis';

      const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      if (!db.orders) db.orders = [];
      db.orders.push({
        orderId, userId, itemId, itemName: item.name, category: item.category,
        price: item.price, totalBayar: item.price, status: 'Lunas', paymentMethod: 'Saldo', timestamp: Date.now(),
      });
      writeDB(db);

      const sisaSaldo = getUserSaldo(userId);
      await editMsg(chatId, q.message.message_id,
        `✅ *PEMBELIAN BERHASIL (VIA SALDO)*\n${'─'.repeat(25)}\n\n` +
        `📦 *Produk:* ${item.name}\n` +
        `💰 *Harga:* Rp${item.price.toLocaleString('id-ID')}\n` +
        `📋 *Order ID:* \`${orderId}\`\n` +
        `💳 *Sisa Saldo Anda:* Rp${sisaSaldo.toLocaleString('id-ID')}\n\n` +
        `Hubungi ${OWNER_USERNAME} untuk proses pengiriman produk.`,
        ik([[btn('📜 History Order', 'history_order')], [btn('🏠 Home', 'go_home')]])
      );

      const uname = q.from.username ? `@${q.from.username}` : q.from.first_name;
      bot.sendMessage(OWNER_ID,
        `✅ *ORDER BARU (BAYAR VIA SALDO)*\n${'─'.repeat(25)}\n` +
        `👤 User: ${uname} (${userId})\n` +
        `📦 ${item.name}\n` +
        `💰 Rp${item.price.toLocaleString('id-ID')}\n` +
        `📋 Order: \`${orderId}\``,
        { parse_mode: 'Markdown' }
      ).catch(() => { });
    }
  },

  // ── ADMIN PANEL MENU ──
  {
    re: /^admin_panel$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      const db = readDB();
      const pendingOrders = (db.orders || []).filter(o => o.status === 'Pending').length;
      const pendingDeps = (db.deposits || []).filter(d => d.status === 'Pending').length;
      const totalUsers = Object.keys(db.users || {}).length;

      const txt =
        `⚙️ *PANEL KELOLA BOT (ADMIN)*\n${'─'.repeat(25)}\n\n` +
        `📊 *Ringkasan Sistem:*\n` +
        `• Total User: *${totalUsers}*\n` +
        `• Order Pending: *${pendingOrders}*\n` +
        `• Deposit Pending: *${pendingDeps}*\n` +
        `• Total Produk: *${(db.items || []).length}*\n\n` +
        `Pilih menu kelola di bawah ini:`;

      await editMsg(q.message.chat.id, q.message.message_id, txt, ik([
        [btn('📦 Kelola Produk (Katalog)', 'page_1'), btn('➕ Tambah Produk', 'restart_additem')],
        [btn(`📜 Kelola Orderan (${pendingOrders})`, 'admin_orders_1'), btn('💰 Kelola Saldo User', 'admin_users_1')],
        [btn('📊 Dashboard Statistik', 'admin_stats'), btn('🎟️ Kelola Voucher', 'admin_vouchers_menu')],
        [btn('📢 Broadcast Pesan', 'admin_broadcast_prompt'), btn('⚙️ Edit Tampilan Home', 'edithome_menu')],
        [btn('💾 Backup DB', 'admin_backup'), btn('📥 Restore DB', 'admin_restore')],
        [btn('🏠 Kembali ke Home', 'go_home')],
      ]));
    }, ownerOnly: true
  },

  // ── KELOLA ORDERAN ADMIN ──
  {
    re: /^admin_orders_(\d+)(?:_(Pending|Lunas|Dibatalkan|Ditolak))?$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const page = Number(m[1]) || 1;
      const filterStatus = m[2] || null;
      const db = readDB();
      let orders = (db.orders || []).slice().reverse();

      if (filterStatus) {
        orders = orders.filter(o => o.status === filterStatus);
      }

      const PER = 5, total = orders.length;
      const totalPages = Math.ceil(total / PER) || 1;
      const cur = Math.max(1, Math.min(page, totalPages));
      const slice = orders.slice((cur - 1) * PER, cur * PER);

      let txt = `📜 *KELOLA ORDERAN (ADMIN)*\n${'─'.repeat(25)}\n`;
      if (filterStatus) txt += `Filter Status: *${filterStatus}*\n`;
      txt += `Halaman *${cur}/${totalPages}* — Total: *${total}* order\n\n`;

      if (!slice.length) {
        txt += '_Tidak ada orderan ditemukan._';
      }

      const rows = [];
      slice.forEach(o => {
        const icon = o.status === 'Lunas' ? '✅' : o.status === 'Pending' ? '⏳' : o.status === 'Dibatalkan' ? '❌' : '⛔';
        const dt = new Date(o.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        txt += `${icon} \`${o.orderId}\` | Rp${(o.price || 0).toLocaleString('id-ID')}\n` +
               `   📦 ${o.itemName} (${o.status})\n` +
               `   👤 User: \`${o.userId}\` • ${dt}\n\n`;
        rows.push([btn(`🔍 Detail ${o.orderId}`, `admin_ord_detail_${o.orderId}_${cur}`)]);
      });

      const filterBtns = [
        btn(filterStatus === null ? '🔘 Semua' : 'Semua', 'admin_orders_1'),
        btn(filterStatus === 'Pending' ? '🔘 Pending' : 'Pending', 'admin_orders_1_Pending'),
        btn(filterStatus === 'Lunas' ? '🔘 Lunas' : 'Lunas', 'admin_orders_1_Lunas'),
      ];
      rows.push(filterBtns);

      const nav = [];
      const filterSuffix = filterStatus ? `_${filterStatus}` : '';
      if (cur > 1) nav.push(btn('⬅️ Prev', `admin_orders_${cur - 1}${filterSuffix}`));
      nav.push(btn(`📄 ${cur}/${totalPages}`, 'noop'));
      if (cur < totalPages) nav.push(btn('Next ➡️', `admin_orders_${cur + 1}${filterSuffix}`));
      if (nav.length) rows.push(nav);

      rows.push([btn('⚙️ Panel Admin', 'admin_panel'), btn('🏠 Home', 'go_home')]);
      await editMsg(q.message.chat.id, q.message.message_id, txt, ik(rows));
    }, ownerOnly: true
  },

  {
    re: /^admin_ord_detail_(ORD-[\w-]+)_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const orderId = m[1], fromPage = Number(m[2]);
      const db = readDB();
      const ord = db.orders?.find(o => o.orderId === orderId);
      if (!ord) return bot.sendMessage(q.message.chat.id, '⚠️ Order tidak ditemukan.');

      const u = db.users?.[String(ord.userId)];
      const uname = u?.username ? `@${u.username}` : (u?.firstName || ord.userId);
      const dt = new Date(ord.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

      const txt =
        `📦 *DETAIL ORDER (ADMIN)*\n${'─'.repeat(25)}\n\n` +
        `📋 *Order ID:* \`${ord.orderId}\`\n` +
        `👤 *User:* ${uname} (\`${ord.userId}\`)\n` +
        `📦 *Produk:* ${ord.itemName}\n` +
        `💰 *Harga:* Rp${(ord.price || 0).toLocaleString('id-ID')}\n` +
        `💳 *Total Bayar:* Rp${(ord.totalBayar || ord.price || 0).toLocaleString('id-ID')}\n` +
        `💵 *Metode:* ${ord.paymentMethod || 'QRIS Pakasir'}\n` +
        `📊 *Status:* *${ord.status}*\n` +
        `📅 *Waktu:* ${dt}\n\n` +
        `*Pilih Aksi Admin:*`;

      await editMsg(q.message.chat.id, q.message.message_id, txt, ik([
        [btn('✅ Set LUNAS', `admin_ord_setstatus_${orderId}_Lunas_${fromPage}`), btn('❌ Batalkan', `admin_ord_setstatus_${orderId}_Dibatalkan_${fromPage}`)],
        [btn('⛔ Set DITOLAK', `admin_ord_setstatus_${orderId}_Ditolak_${fromPage}`), btn('⏳ Set PENDING', `admin_ord_setstatus_${orderId}_Pending_${fromPage}`)],
        [btn('💰 Refund ke Saldo User', `admin_ord_refund_${orderId}_${fromPage}`), btn('🗑️ Hapus Order', `admin_ord_delete_${orderId}_${fromPage}`)],
        [btn('⬅️ Kembali', `admin_orders_${fromPage}`), btn('⚙️ Panel Admin', 'admin_panel')],
      ]));
    }, ownerOnly: true
  },

  {
    re: /^admin_ord_setstatus_(ORD-[\w-]+)_(Lunas|Pending|Dibatalkan|Ditolak)_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const orderId = m[1], newStatus = m[2], fromPage = Number(m[3]);
      const db = readDB();
      const ord = db.orders?.find(o => o.orderId === orderId);
      if (!ord) return bot.sendMessage(q.message.chat.id, '⚠️ Order tidak ditemukan.');

      const oldStatus = ord.status;
      ord.status = newStatus;

      if (newStatus === 'Lunas' && oldStatus !== 'Lunas') {
        const item = db.items?.find(i => i.id === ord.itemId);
        if (item && item.stock > 0) {
          item.stock -= 1;
          if (item.stock <= 0) item.status = 'Habis';
        }
      }
      writeDB(db);

      bot.sendMessage(ord.userId, `ℹ️ Status order \`${orderId}\` diubah Admin menjadi: *${newStatus}*`, { parse_mode: 'Markdown' }).catch(() => {});
      await editMsg(q.message.chat.id, q.message.message_id, `✅ Status order \`${orderId}\` diubah ke *${newStatus}*.`, ik([[btn('⬅️ Detail Order', `admin_ord_detail_${orderId}_${fromPage}`)]]));
    }, cbText: '✅ Status Diubah', ownerOnly: true
  },

  {
    re: /^admin_ord_refund_(ORD-[\w-]+)_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const orderId = m[1], fromPage = Number(m[2]);
      const db = readDB();
      const ord = db.orders?.find(o => o.orderId === orderId);
      if (!ord) return bot.sendMessage(q.message.chat.id, '⚠️ Order tidak ditemukan.');

      const refundAmount = ord.totalBayar || ord.price;
      updateUserSaldo(ord.userId, refundAmount);
      ord.status = 'Refunded';
      writeDB(db);

      bot.sendMessage(ord.userId, `💰 *REFUND SALDO*\nOrder \`${orderId}\` sebesar Rp${refundAmount.toLocaleString('id-ID')} telah direfund ke saldo akun Anda.`, { parse_mode: 'Markdown' }).catch(() => {});
      await editMsg(q.message.chat.id, q.message.message_id, `✅ Rp${refundAmount.toLocaleString('id-ID')} berhasil direfund ke user \`${ord.userId}\`.`, ik([[btn('⬅️ Detail Order', `admin_ord_detail_${orderId}_${fromPage}`)]]));
    }, cbText: '💰 Refunded', ownerOnly: true
  },

  {
    re: /^admin_ord_delete_(ORD-[\w-]+)_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const orderId = m[1], fromPage = Number(m[2]);
      const db = readDB();
      db.orders = (db.orders || []).filter(o => o.orderId !== orderId);
      writeDB(db);

      await editMsg(q.message.chat.id, q.message.message_id, `🗑️ Order \`${orderId}\` berhasil dihapus.`, ik([[btn('⬅️ Kelola Orderan', `admin_orders_${fromPage}`)]]));
    }, cbText: '🗑️ Dihapus', ownerOnly: true
  },

  // ── KELOLA SALDO USER ADMIN ──
  {
    re: /^admin_users_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const page = Number(m[1]) || 1;
      const db = readDB();
      const userKeys = Object.keys(db.users || {});
      const PER = 6, total = userKeys.length;
      const totalPages = Math.ceil(total / PER) || 1;
      const cur = Math.max(1, Math.min(page, totalPages));
      const slice = userKeys.slice((cur - 1) * PER, cur * PER);

      let txt = `👤 *KELOLA SALDO USER (ADMIN)*\n${'─'.repeat(25)}\nTotal User: *${total}*\n\n`;
      const rows = [];

      slice.forEach(k => {
        const u = db.users[k];
        const uname = u.username ? `@${u.username}` : (u.firstName || k);
        txt += `• *${uname}* (\`${k}\`)\n   💰 Saldo: Rp${(u.saldo || 0).toLocaleString('id-ID')}\n`;
        rows.push([btn(`✏️ Edit Saldo ${uname}`, `admin_user_detail_${k}`)]);
      });

      const nav = [];
      if (cur > 1) nav.push(btn('⬅️ Prev', `admin_users_${cur - 1}`));
      nav.push(btn(`📄 ${cur}/${totalPages}`, 'noop'));
      if (cur < totalPages) nav.push(btn('Next ➡️', `admin_users_${cur + 1}`));
      if (nav.length) rows.push(nav);

      rows.push([btn('⚙️ Panel Admin', 'admin_panel'), btn('🏠 Home', 'go_home')]);
      await editMsg(q.message.chat.id, q.message.message_id, txt, ik(rows));
    }, ownerOnly: true
  },

  {
    re: /^admin_user_detail_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const targetUserId = m[1];
      const db = readDB();
      const u = db.users?.[targetUserId];
      if (!u) return bot.sendMessage(q.message.chat.id, '⚠️ User tidak ditemukan.');

      const uname = u.username ? `@${u.username}` : (u.firstName || targetUserId);
      const txt =
        `👤 *DETAIL USER*\n${'─'.repeat(25)}\n\n` +
        `🆔 *ID:* \`${targetUserId}\`\n` +
        `👤 *Nama:* ${uname}\n` +
        `💰 *Saldo saat ini:* Rp${(u.saldo || 0).toLocaleString('id-ID')}\n\n` +
        `Pilih aksi ubah saldo:`;

      await editMsg(q.message.chat.id, q.message.message_id, txt, ik([
        [btn('➕ Tambah +10.000', `admin_user_addval_${targetUserId}_10000`), btn('➕ Tambah +50.000', `admin_user_addval_${targetUserId}_50000`)],
        [btn('➕ Tambah +100.000', `admin_user_addval_${targetUserId}_100000`), btn('➖ Potong -20.000', `admin_user_addval_${targetUserId}_-20000`)],
        [btn('✏️ Nominal Custom', `admin_user_custom_${targetUserId}`)],
        [btn('⬅️ Daftar User', 'admin_users_1'), btn('⚙️ Panel Admin', 'admin_panel')],
      ]));
    }, ownerOnly: true
  },

  {
    re: /^admin_user_addval_(\d+)_(-?\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const targetUserId = m[1], delta = Number(m[2]);
      const newBal = updateUserSaldo(targetUserId, delta);

      bot.sendMessage(targetUserId, `ℹ️ Saldo Anda telah disesuaikan Admin sebesar *Rp${delta.toLocaleString('id-ID')}*. Saldo saat ini: *Rp${newBal.toLocaleString('id-ID')}*`, { parse_mode: 'Markdown' }).catch(() => {});
      await editMsg(q.message.chat.id, q.message.message_id,
        `✅ Saldo user \`${targetUserId}\` disesuaikan sebesar Rp${delta.toLocaleString('id-ID')}.\nSaldo baru: Rp${newBal.toLocaleString('id-ID')}`,
        ik([[btn('⬅️ Detail User', `admin_user_detail_${targetUserId}`)], [btn('⚙️ Panel Admin', 'admin_panel')]])
      );
    }, cbText: '✅ Saldo Diperbarui', ownerOnly: true
  },

  {
    re: /^admin_user_custom_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const targetUserId = m[1];
      sessions[q.from.id] = { type: 'admin_custom_saldo', targetUserId };
      await editMsg(q.message.chat.id, q.message.message_id,
        `✏️ *Edit Saldo Custom*\n\nKirim nominal penambahan (contoh: \`50000\`) atau pengurangan (contoh: \`-20000\`):`,
        ik([[btn('❌ Batal', `admin_user_detail_${targetUserId}`)]])
      );
    }, ownerOnly: true
  },

  // ── STATISTIK ADMIN ──
  {
    re: /^admin_stats$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      const db = readDB();
      const orders = db.orders || [];
      const deposits = db.deposits || [];
      const users = Object.keys(db.users || {});

      const lunasOrders = orders.filter(o => o.status === 'Lunas');
      const omsetOrders = lunasOrders.reduce((sum, o) => sum + (o.price || 0), 0);
      const lunasDeps = deposits.filter(d => d.status === 'Lunas');
      const totalDepsNominal = lunasDeps.reduce((sum, d) => sum + (d.nominal || 0), 0);

      const itemCounts = {};
      lunasOrders.forEach(o => { itemCounts[o.itemName] = (itemCounts[o.itemName] || 0) + 1; });
      let topItem = '-';
      let topCount = 0;
      for (const [name, cnt] of Object.entries(itemCounts)) {
        if (cnt > topCount) { topItem = name; topCount = cnt; }
      }

      const txt =
        `📊 *DASHBOARD STATISTIK & OMSET*\n${'─'.repeat(25)}\n\n` +
        `💵 *Total Omset Penjualan:* Rp${omsetOrders.toLocaleString('id-ID')}\n` +
        `💰 *Total Deposit Masuk:* Rp${totalDepsNominal.toLocaleString('id-ID')}\n` +
        `📦 *Total Order Lunas:* ${lunasOrders.length} transaksi\n` +
        `👥 *Total User Terdaftar:* ${users.length} user\n` +
        `🔥 *Produk Terlaris:* ${topItem} (${topCount}x)\n\n` +
        `_Data diperbarui secara realtime._`;

      await editMsg(q.message.chat.id, q.message.message_id, txt, ik([
        [btn('📜 Kelola Orderan', 'admin_orders_1'), btn('⚙️ Panel Admin', 'admin_panel')],
        [btn('🏠 Home', 'go_home')],
      ]));
    }, ownerOnly: true
  },

  // ── BROADCAST PROMPT ──
  {
    re: /^admin_broadcast_prompt$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      sessions[q.from.id] = { type: 'admin_broadcast' };
      await editMsg(q.message.chat.id, q.message.message_id,
        `📢 *BROADCAST PESAN MASSAL*\n\nKirimkan teks pengumuman/promo yang ingin disebarkan ke *seluruh user* bot:`,
        ik([[btn('❌ Batal', 'admin_panel')]])
      );
    }, ownerOnly: true
  },

  // ── BACKUP & RESTORE CALLBACKS ──
  {
    re: /^admin_backup$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      try {
        await bot.sendDocument(q.message.chat.id, DB_PATH, {
          caption: `💾 *Backup Database Telegram Bot*\nTanggal: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
          parse_mode: 'Markdown'
        });
      } catch (e) {
        bot.sendMessage(q.message.chat.id, `❌ Gagal backup: ${e.message}`);
      }
    }, cbText: '💾 Sending Backup', ownerOnly: true
  },

  {
    re: /^admin_restore$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      sessions[q.from.id] = { type: 'restore_db' };
      await editMsg(q.message.chat.id, q.message.message_id,
        `📥 *RESTORE DATABASE*\n${'─'.repeat(25)}\n\n` +
        `Kirimkan file *\`db.json\`* (sebagai file dokumen JSON) ke bot ini.\n\n` +
        `⚠️ Backup otomatis \`db.json.bak\` akan dibuat sebelum menimpa data aktif.`,
        ik([[btn('❌ Batal', 'admin_panel')]])
      );
    }, ownerOnly: true
  },

  // ── VOUCHER CALLBACKS ──
  {
    re: /^admin_vouchers_menu$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      const db = readDB();
      const vList = db.vouchers || [];
      let txt = `🎟️ *KELOLA VOUCHER PROMO*\n${'─'.repeat(25)}\nTotal Voucher: *${vList.length}*\n\n`;

      if (!vList.length) {
        txt += '_Belum ada voucher aktif._';
      } else {
        vList.forEach((v, i) => {
          txt += `${i + 1}. Kode: \`${v.code}\` | Rp${v.nominal.toLocaleString('id-ID')} (Diklaim: ${(v.usedBy || []).length}x)\n`;
        });
      }

      await editMsg(q.message.chat.id, q.message.message_id, txt, ik([
        [btn('➕ Buat Voucher Baru', 'admin_addvoucher_prompt')],
        [btn('⚙️ Panel Admin', 'admin_panel'), btn('🏠 Home', 'go_home')],
      ]));
    }, ownerOnly: true
  },

  {
    re: /^admin_addvoucher_prompt$/, fn: async (q) => {
      if (q.from.id !== OWNER_ID) return;
      sessions[q.from.id] = { type: 'admin_addvoucher' };
      await editMsg(q.message.chat.id, q.message.message_id,
        `➕ *BUAT VOUCHER BARU*\n\nKirim *KODE* dan *NOMINAL* (dipisahkan spasi):\nContoh: \`PROMO10K 10000\``,
        ik([[btn('❌ Batal', 'admin_vouchers_menu')]])
      );
    }, ownerOnly: true
  },

  {
    re: /^claim_voucher_menu$/, fn: async (q) => {
      sessions[q.from.id] = { type: 'claim_voucher' };
      await editMsg(q.message.chat.id, q.message.message_id,
        `🎟️ *KLAIM VOUCHER PROMO*\n\nKirimkan *Kode Voucher* diskon Anda:\nContoh: \`PROMO10K\``,
        ik([[btn('❌ Batal', 'go_home')]])
      );
    }
  },

  {
    re: /^confirm_delete_(\d+)_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const itemId = Number(m[1]), fromPage = Number(m[2]);
      const item = readDB().items.find(i => i.id === itemId);
      await editMsg(q.message.chat.id, q.message.message_id,
        `⚠️ *Konfirmasi Hapus*\n\nHapus: *${item?.name || itemId}*?`,
        ik([[btn('✅ Ya Hapus', `delete_${itemId}_${fromPage}`), btn('❌ Batal', `detail_${itemId}_${fromPage}`)]])
      );
    }, ownerOnly: true
  },

  {
    re: /^delete_(\d+)_(\d+)$/, fn: async (q, m) => {
      if (q.from.id !== OWNER_ID) return;
      const itemId = Number(m[1]), fromPage = Number(m[2]);
      const db = readDB();
      db.items = db.items.filter(i => i.id !== itemId);
      writeDB(db);
      const cat = buildCatalog(fromPage);
      await editMsg(q.message.chat.id, q.message.message_id, cat.text, cat.extra);
    }, cbText: '🗑️ Dihapus!', ownerOnly: true
  },
];

bot.on('callback_query', async (query) => {
  const data = query.data || '';
  for (const route of callbackRoutes) {
    const m = data.match(route.re);
    if (m) {
      if (route.ownerOnly && query.from.id !== OWNER_ID) {
        return bot.answerCallbackQuery(query.id, { text: '⛔' }).catch(() => { });
      }
      try {
        await bot.answerCallbackQuery(query.id, route.cbText ? { text: route.cbText } : {});
      } catch (_) { }
      try {
        await route.fn(query, m);
      } catch (e) {
        console.error('Callback handler error:', e);
      }
      return;
    }
  }
  // Tidak ada route yang cocok
  bot.answerCallbackQuery(query.id).catch(() => { });
});

// ================================================================
// SATU-SATUNYA text handler (pengganti bot.on('text') Telegraf)
// ================================================================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/start') || msg.text.startsWith('/ping') ||
    msg.text.startsWith('/additem') || msg.text.startsWith('/edititem')) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text;
  console.log(`[TEXT] ${userId} | "${text}" | sess=${JSON.stringify(sessions[userId] || null)}`);

  // 1. Owner /reply
  if (userId === OWNER_ID && text.startsWith('/reply ')) {
    const parts = text.split(' ');
    const targetId = Number(parts[1]);
    const m = parts.slice(2).join(' ');
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

  // 5. Edititem flow (session-based, dipicu dari tombol ✏️ Edit)
  if (sess?.type === 'edititem') {
    if (userId !== OWNER_ID) { delete sessions[userId]; return bot.sendMessage(chatId, '⛔ Bukan owner.'); }
    if (text.startsWith('/')) {
      delete sessions[userId];
      return bot.sendMessage(chatId, '⛔ Sesi edit item dibatalkan.');
    }
    return processEditItem(chatId, userId, text);
  }

  // 6. Edithome flow
  if (sess?.type === 'edithome') {
    if (userId !== OWNER_ID) { delete sessions[userId]; return bot.sendMessage(chatId, '⛔ Bukan owner.'); }
    if (sess.field !== 'logo' && text.startsWith('/')) {
      delete sessions[userId];
      return bot.sendMessage(chatId, '⛔ Sesi edit home dibatalkan.');
    }
    return processEditHome(chatId, userId, text);
  }

  // 7. Admin Broadcast
  if (sess?.type === 'admin_broadcast') {
    if (userId !== OWNER_ID) { delete sessions[userId]; return; }
    delete sessions[userId];
    const db = readDB();
    const userIds = Object.keys(db.users || {});
    await bot.sendMessage(chatId, `⏳ Mengirim broadcast ke ${userIds.length} user...`);
    let count = 0;
    for (const uid of userIds) {
      try {
        await bot.sendMessage(uid, `📢 *PENGUMUMAN:* \n\n${text}`, { parse_mode: 'Markdown' });
        count++;
      } catch (_) {}
    }
    return bot.sendMessage(chatId, `✅ *Broadcast Selesai!*\nPesan terkirim ke ${count} dari ${userIds.length} user.`, { parse_mode: 'Markdown', ...ik([[btn('⚙️ Panel Admin', 'admin_panel')]]) });
  }

  // 8. Admin custom saldo
  if (sess?.type === 'admin_custom_saldo') {
    if (userId !== OWNER_ID) { delete sessions[userId]; return; }
    delete sessions[userId];
    const targetUserId = sess.targetUserId;
    const nominal = Number(text.replace(/[^0-9-]/g, ''));
    if (isNaN(nominal)) return bot.sendMessage(chatId, '⚠️ Nominal tidak valid. Coba lagi.');
    const newBal = updateUserSaldo(targetUserId, nominal);
    bot.sendMessage(targetUserId, `ℹ️ Saldo Anda telah disesuaikan Admin sebesar *Rp${nominal.toLocaleString('id-ID')}*. Saldo saat ini: *Rp${newBal.toLocaleString('id-ID')}*`, { parse_mode: 'Markdown' }).catch(() => {});
    return bot.sendMessage(chatId, `✅ Saldo user \`${targetUserId}\` disesuaikan sebesar Rp${nominal.toLocaleString('id-ID')}.\nSaldo baru: Rp${newBal.toLocaleString('id-ID')}`, { parse_mode: 'Markdown', ...ik([[btn('👤 Detail User', `admin_user_detail_${targetUserId}`)], [btn('⚙️ Panel Admin', 'admin_panel')]]) });
  }

  // 9. Admin add voucher
  if (sess?.type === 'admin_addvoucher') {
    if (userId !== OWNER_ID) { delete sessions[userId]; return; }
    delete sessions[userId];
    const parts = text.split(' ').map(s => s.trim()).filter(Boolean);
    const code = (parts[0] || '').toUpperCase();
    const nominal = Number(parts[1]);
    if (!code || isNaN(nominal) || nominal <= 0) {
      return bot.sendMessage(chatId, '⚠️ Format salah. Contoh: `PROMO10K 10000`', { parse_mode: 'Markdown' });
    }
    const db = readDB();
    if (!db.vouchers) db.vouchers = [];
    db.vouchers.push({ code, nominal, usedBy: [], createdAt: Date.now() });
    writeDB(db);
    return bot.sendMessage(chatId, `✅ *Voucher Berhasil Dibuat!*\n\nKode: \`${code}\`\nNominal: Rp${nominal.toLocaleString('id-ID')}`, { parse_mode: 'Markdown', ...ik([[btn('🎟️ Kelola Voucher', 'admin_vouchers_menu')]]) });
  }

  // 10. User claim voucher
  if (sess?.type === 'claim_voucher') {
    delete sessions[userId];
    const code = text.trim().toUpperCase();
    const db = readDB();
    const v = (db.vouchers || []).find(vc => vc.code === code);
    if (!v) return bot.sendMessage(chatId, '❌ Kode voucher tidak ditemukan/invalid.', ik([[btn('🏠 Home', 'go_home')]]));
    if (!v.usedBy) v.usedBy = [];
    if (v.usedBy.includes(userId)) return bot.sendMessage(chatId, '⚠️ Anda sudah pernah mengklaim voucher ini.', ik([[btn('🏠 Home', 'go_home')]]));

    v.usedBy.push(userId);
    writeDB(db);
    const newBal = updateUserSaldo(userId, v.nominal, msg.from);

    return bot.sendMessage(chatId,
      `🎉 *VOUCHER BERHASIL DIKLAIM!*\n${'─'.repeat(25)}\n\n` +
      `🎟️ Kode: \`${code}\`\n` +
      `💰 Bonus Saldo: +Rp${v.nominal.toLocaleString('id-ID')}\n` +
      `💳 Saldo Anda Sekarang: Rp${newBal.toLocaleString('id-ID')}`,
      { parse_mode: 'Markdown', ...ik([[btn('📦 Katalog Produk', 'page_1')], [btn('🏠 Home', 'go_home')]]) }
    );
  }
  // Default: diam
});

// ================================================================
// HANDLER FOTO (dipakai khusus untuk upload logo home page)
// ================================================================
bot.on('photo', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (userId !== OWNER_ID) return;

  const sess = sessions[userId];
  if (sess?.type !== 'edithome' || sess.field !== 'logo') return;

  try {
    const photos = msg.photo || [];
    if (!photos.length) return bot.sendMessage(chatId, '⚠️ Foto tidak terbaca, coba kirim ulang.');
    const fileId = photos[photos.length - 1].file_id; // resolusi tertinggi
    saveSetting('logoFileId', fileId);
    delete sessions[userId];
    await bot.sendMessage(chatId, '✅ *Logo berhasil diperbarui!*', {
      parse_mode: 'Markdown',
      ...ik([[btn('⚙️ Edit Lagi', 'edithome_menu')], [btn('🏠 Lihat Home', 'go_home')]]),
    });
  } catch (e) {
    console.error('Edit logo error:', e);
    bot.sendMessage(chatId, `❌ Gagal simpan logo: ${e.message}`);
  }
});

// ================================================================
// HANDLER DOKUMEN (dipakai khusus untuk restore database db.json)
// ================================================================
bot.on('document', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (userId !== OWNER_ID) return;

  const sess = sessions[userId];
  if (sess?.type !== 'restore_db') return;

  try {
    const doc = msg.document;
    if (!doc.file_name || !doc.file_name.toLowerCase().endsWith('.json')) {
      return bot.sendMessage(chatId, '❌ File harus berformat `.json`');
    }

    const fileLink = await bot.getFileLink(doc.file_id);
    const res = await axios.get(fileLink);
    const newData = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;

    if (typeof newData !== 'object' || newData === null) {
      throw new Error('Isi file JSON tidak valid.');
    }

    fs.copyFileSync(DB_PATH, DB_PATH + '.bak');
    writeDB(newData);
    delete sessions[userId];

    await bot.sendMessage(chatId, `✅ *RESTORE BERHASIL!*\n\nDatabase \`db.json\` telah diperbarui. Backup lama telah disimpan di \`db.json.bak\`.`, {
      parse_mode: 'Markdown',
      ...ik([[btn('⚙️ Panel Admin', 'admin_panel')], [btn('🏠 Home', 'go_home')]])
    });
  } catch (e) {
    console.error('Restore error:', e);
    bot.sendMessage(chatId, `❌ Gagal restore: ${e.message}`);
  }
});

// ================================================================
// LAUNCH
// ================================================================
bot.on('polling_error', (err) => console.error('❌ Polling error:', err.message));
console.log(`✅ ${BOT_NAME} aktif! QRIS via Pakasir enabled (node-telegram-bot-api).`);

process.once('SIGINT', () => { bot.stopPolling(); process.exit(0); });
process.once('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
'use strict';

require('dotenv').config();

const path = require('path');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { v2: cloudinary } = require('cloudinary');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/kardeshler_doner';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const APP_SECRET = process.env.APP_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const REQUIRE_TELEGRAM_AUTH = String(process.env.REQUIRE_TELEGRAM_AUTH || 'false').toLowerCase() === 'true';
function cleanPublicUrl(value) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  if (!raw || raw.includes('your-domain.com') || raw.includes('localhost') || raw.includes('127.0.0.1')) return '';
  if (!/^https:\/\//i.test(raw)) return '';
  return raw;
}

function detectPublicUrl() {
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  return '';
}

const PUBLIC_URL = cleanPublicUrl(process.env.PUBLIC_URL) || cleanPublicUrl(detectPublicUrl());
const WEBAPP_URL = cleanPublicUrl(process.env.WEBAPP_URL) || PUBLIC_URL;
const AUTO_SET_WEBHOOK = String(process.env.AUTO_SET_WEBHOOK || 'false').toLowerCase() === 'true';
const TELEGRAM_POLLING = String(process.env.TELEGRAM_POLLING || 'false').toLowerCase() === 'true';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 6);
const ADMIN_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 2;
const INIT_DATA_MAX_AGE_SECONDS = Number(process.env.INIT_DATA_MAX_AGE_SECONDS || 60 * 60 * 24);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype)) {
      return cb(new Error('Faqat PNG, JPG, WEBP yoki GIF rasm qabul qilinadi.'));
    }
    cb(null, true);
  },
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function isConfiguredCloudinary() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

function normalizeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'on', 'ha'].includes(String(value).toLowerCase());
}

function safeJsonParse(value, fallback) {
  try {
    if (typeof value === 'string') return JSON.parse(value);
    return value ?? fallback;
  } catch (_error) {
    return fallback;
  }
}

function formatMoney(amount, currency = 'UZS') {
  return `${Number(amount || 0).toLocaleString('uz-UZ')} ${currency}`;
}

function ensureObjectId(id, fieldName = 'ID') {
  if (!mongoose.Types.ObjectId.isValid(String(id || ''))) {
    const err = new Error(`${fieldName} noto‘g‘ri.`);
    err.status = 400;
    throw err;
  }
  return id;
}

function makeLogoDataUri() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <rect width="512" height="512" rx="128" fill="#fff5f5"/>
      <circle cx="256" cy="256" r="184" fill="#d71313"/>
      <circle cx="256" cy="256" r="142" fill="#ffffff"/>
      <path d="M158 292c40 54 151 54 191 0-17 76-174 76-191 0Z" fill="#d71313"/>
      <path d="M178 176h156c28 0 50 22 50 50v12H128v-12c0-28 22-50 50-50Z" fill="#d71313"/>
      <text x="256" y="270" text-anchor="middle" font-family="Arial, sans-serif" font-size="76" font-weight="900" fill="#d71313">KD</text>
      <text x="256" y="355" text-anchor="middle" font-family="Arial, sans-serif" font-size="35" font-weight="800" fill="#d71313">DÖNER</text>
    </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function uploadToCloudinary(file, folder) {
  if (!file) return null;
  if (!isConfiguredCloudinary()) {
    const err = new Error('Cloudinary sozlanmagan. .env ichida CLOUDINARY_* qiymatlarini kiriting.');
    err.status = 500;
    throw err;
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image', quality: 'auto:good', fetch_format: 'auto' },
      (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(file.buffer);
  });
}

function validateTelegramInitData(initData) {
  if (!BOT_TOKEN) return { ok: false, reason: 'BOT_TOKEN sozlanmagan.' };
  if (!initData) return { ok: false, reason: 'Telegram initData yo‘q.' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'Telegram hash yo‘q.' };

  params.delete('hash');
  const authDate = Number(params.get('auth_date') || 0);
  const now = Math.floor(Date.now() / 1000);
  if (authDate && INIT_DATA_MAX_AGE_SECONDS > 0 && now - authDate > INIT_DATA_MAX_AGE_SECONDS) {
    return { ok: false, reason: 'Telegram initData muddati tugagan.' };
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  try {
    const valid = crypto.timingSafeEqual(Buffer.from(calculatedHash, 'hex'), Buffer.from(hash, 'hex'));
    if (!valid) return { ok: false, reason: 'Telegram imzo mos kelmadi.' };
  } catch (_error) {
    return { ok: false, reason: 'Telegram imzo formati noto‘g‘ri.' };
  }

  const user = safeJsonParse(params.get('user'), null);
  return { ok: true, user, raw: Object.fromEntries(params.entries()) };
}

function telegramAuth(req, res, next) {
  const initData = req.get('X-Telegram-Init-Data') || req.body?.initData || req.query?.initData || '';
  const validated = validateTelegramInitData(initData);

  if (validated.ok && validated.user?.id) {
    req.tgUser = validated.user;
    return next();
  }

  if (REQUIRE_TELEGRAM_AUTH) {
    return res.status(401).json({ success: false, message: validated.reason || 'Telegram auth xatosi.' });
  }

  const demoId = req.get('X-Demo-User-Id') || req.body?.demoUserId || req.query?.demoUserId || 'demo-user';
  req.tgUser = {
    id: String(demoId),
    first_name: req.body?.fullName || 'Demo',
    last_name: '',
    username: 'demo',
  };
  next();
}

function signAdminToken(payload = {}) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ADMIN_TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyAdminToken(req, res, next) {
  const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !token.includes('.')) return res.status(401).json({ success: false, message: 'Admin token kerak.' });
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  if (sig !== expected) return res.status(401).json({ success: false, message: 'Admin token noto‘g‘ri.' });

  const payload = safeJsonParse(Buffer.from(body, 'base64url').toString('utf8'), null);
  if (!payload || payload.exp < Date.now()) return res.status(401).json({ success: false, message: 'Admin token muddati tugagan.' });
  req.admin = payload;
  next();
}

const settingsSchema = new mongoose.Schema(
  {
    brandName: { type: String, default: 'Kardeşler Döner' },
    brandSubtitle: { type: String, default: 'Turkcha doner, tez yetkazib berish va stol band qilish' },
    logoUrl: { type: String, default: makeLogoDataUri },
    currency: { type: String, default: 'UZS' },
    restaurantPhone: { type: String, default: '+998 90 000 00 00' },
    restaurantAddress: { type: String, default: 'Toshkent, O‘zbekiston' },
    instagram: { type: String, default: '@kardeshlerdoner' },
    openingHours: { type: String, default: 'Har kuni 10:00–23:00' },
    paymentCardTitle: { type: String, default: 'Kardeşler Döner karta to‘lovi' },
    paymentCardBank: { type: String, default: 'Click / Payme / Uzcard' },
    paymentCardNumber: { type: String, default: '8600 0000 0000 0000' },
    paymentCardHolder: { type: String, default: 'KARDESHLER DONER' },
    paymentInstructions: {
      type: String,
      default: 'To‘lovni admin kartasiga o‘tkazing, chek screenshotini joylang. Admin tasdiqlagach status yangilanadi.',
    },
    adminTelegramChatId: { type: String, default: '' },
    reservationDeposit: { type: Number, default: 0 },
    reservationMinGuests: { type: Number, default: 1 },
    reservationMaxGuests: { type: Number, default: 20 },
    tableAreas: {
      type: [
        {
          name: String,
          description: String,
          capacity: Number,
          active: { type: Boolean, default: true },
        },
      ],
      default: [
        { name: 'Zal', description: 'Asosiy zal, oilaviy muhit', capacity: 40, active: true },
        { name: 'VIP xona', description: 'Tinch va maxsus xona', capacity: 12, active: true },
        { name: 'Terrasa', description: 'Ochiq havoda joylar', capacity: 20, active: true },
      ],
    },
  },
  { timestamps: true }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true, default: 'Doner' },
    description: { type: String, default: '' },
    price: { type: Number, required: true, min: 0 },
    oldPrice: { type: Number, default: 0 },
    imageUrl: { type: String, default: '' },
    imagePublicId: { type: String, default: '' },
    emoji: { type: String, default: '🥙' },
    available: { type: Boolean, default: true },
    featured: { type: Boolean, default: false },
    spicy: { type: Boolean, default: false },
    sort: { type: Number, default: 100 },
  },
  { timestamps: true }
);

productSchema.index({ name: 'text', category: 'text', description: 'text' });

const deliveryServiceSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    price: { type: Number, default: 0, min: 0 },
    eta: { type: String, default: '30–45 daqiqa' },
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 100 },
  },
  { timestamps: true }
);

const orderSchema = new mongoose.Schema(
  {
    orderNo: { type: String, unique: true, index: true },
    userTelegramId: { type: String, index: true },
    userUsername: String,
    userFullName: String,
    phone: { type: String, required: true },
    type: { type: String, enum: ['DELIVERY', 'PICKUP'], default: 'DELIVERY' },
    address: { type: String, default: '' },
    deliveryServiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryService' },
    deliveryServiceTitle: String,
    items: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        name: String,
        price: Number,
        qty: Number,
        subtotal: Number,
      },
    ],
    subtotal: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    paymentScreenshotUrl: { type: String, default: '' },
    paymentScreenshotPublicId: { type: String, default: '' },
    paymentStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    orderStatus: {
      type: String,
      enum: ['NEW', 'CONFIRMED', 'COOKING', 'ON_ROAD', 'READY', 'DONE', 'CANCELLED'],
      default: 'NEW',
    },
    note: { type: String, default: '' },
    adminNote: { type: String, default: '' },
  },
  { timestamps: true }
);

const reservationSchema = new mongoose.Schema(
  {
    reservationNo: { type: String, unique: true, index: true },
    userTelegramId: { type: String, index: true },
    userUsername: String,
    userFullName: String,
    phone: { type: String, required: true },
    date: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    guests: { type: Number, default: 1 },
    tableArea: { type: String, default: 'Zal' },
    deposit: { type: Number, default: 0 },
    paymentScreenshotUrl: { type: String, default: '' },
    paymentScreenshotPublicId: { type: String, default: '' },
    paymentStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED'], default: 'PENDING' },
    note: { type: String, default: '' },
    adminNote: { type: String, default: '' },
  },
  { timestamps: true }
);

const Settings = mongoose.model('Settings', settingsSchema);
const Product = mongoose.model('Product', productSchema);
const DeliveryService = mongoose.model('DeliveryService', deliveryServiceSchema);
const Order = mongoose.model('Order', orderSchema);
const Reservation = mongoose.model('Reservation', reservationSchema);

function publicProduct(product) {
  return {
    _id: product._id,
    name: product.name,
    category: product.category,
    description: product.description,
    price: product.price,
    oldPrice: product.oldPrice,
    imageUrl: product.imageUrl,
    emoji: product.emoji,
    available: product.available,
    featured: product.featured,
    spicy: product.spicy,
    sort: product.sort,
  };
}

async function getSettingsDoc() {
  let settings = await Settings.findOne();
  if (!settings) settings = await Settings.create({});
  return settings;
}

async function seedDefaults() {
  await getSettingsDoc();

  const deliveryCount = await DeliveryService.countDocuments();
  if (!deliveryCount) {
    await DeliveryService.insertMany([
      { title: 'Restoran yetkazib berish', description: 'Yaqin hududlarga tez yetkazib berish', price: 12000, eta: '25–40 daqiqa', sort: 1 },
      { title: 'Uzoq hudud yetkazish', description: 'Shahar chetiga alohida narx', price: 25000, eta: '45–70 daqiqa', sort: 2 },
      { title: 'Olib ketish', description: 'Restorandan o‘zingiz olib ketasiz', price: 0, eta: '15–25 daqiqa', sort: 3 },
    ]);
  }

  const productCount = await Product.countDocuments();
  if (!productCount) {
    await Product.insertMany([
      { name: 'Tovuq Doner', category: 'Doner', description: 'Lavash non, tovuq go‘shti, sabzavot va maxsus sous', price: 32000, emoji: '🥙', featured: true, sort: 1 },
      { name: 'Mol Go‘shti Doner', category: 'Doner', description: 'Mol go‘shti, qarsildoq sabzavot va turkcha sous', price: 39000, emoji: '🌯', featured: true, sort: 2 },
      { name: 'Mix Doner', category: 'Doner', description: 'Tovuq va mol go‘shti aralashmasi', price: 42000, emoji: '🥙', spicy: true, sort: 3 },
      { name: 'Doner Box', category: 'Set', description: 'Go‘sht, fri, salat va sous bilan box', price: 45000, emoji: '🍱', featured: true, sort: 4 },
      { name: 'Iskender', category: 'Turk taomlari', description: 'Turkcha non, go‘sht, yogurt va pomidor sous', price: 58000, emoji: '🍛', sort: 5 },
      { name: 'Kartoshka Fri', category: 'Snacks', description: 'Qarsildoq fri va sous', price: 16000, emoji: '🍟', sort: 6 },
      { name: 'Ayran', category: 'Ichimliklar', description: 'Turkcha sovuq ayran', price: 9000, emoji: '🥛', sort: 7 },
      { name: 'Coca-Cola 0.5L', category: 'Ichimliklar', description: 'Sovuq ichimlik', price: 8000, emoji: '🥤', sort: 8 },
    ]);
  }
}

function postJson(url, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const parsed = safeJsonParse(data, null);
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const err = new Error(parsed?.description || `HTTP ${res.statusCode}`);
        err.response = parsed;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Telegram API timeout.')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function telegramApi(method, payload = {}) {
  if (!BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN sozlanmagan.' };
  try {
    const data = await postJson(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, payload);
    if (!data?.ok) console.error('Telegram API error:', method, data);
    return data;
  } catch (error) {
    console.error('Telegram API request failed:', method, error.message, error.response || '');
    return { ok: false, description: error.message, error: error.response || null };
  }
}

async function answerStart(chatId) {
  const settings = await getSettingsDoc();
  const buttons = [];
  if (WEBAPP_URL) buttons.push([{ text: '🍽 Mini Appni ochish', web_app: { url: WEBAPP_URL } }]);
  buttons.push([{ text: '📞 Telefon', callback_data: 'phone' }]);

  const text = WEBAPP_URL
    ? `Assalomu alaykum! ${settings.brandName} mini ilovasiga xush kelibsiz. Menyudan buyurtma bering yoki joy band qiling.`
    : `Assalomu alaykum! ${settings.brandName} bot ishga tushdi, lekin Mini App URL hali sozlanmagan. Admin paneldan yoki .env ichida PUBLIC_URL / WEBAPP_URL ni HTTPS domen qilib kiriting.`;

  return telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: buttons },
  });
}

async function handleTelegramUpdate(update) {
  const message = update?.message || update?.edited_message;
  const callback = update?.callback_query;

  if (callback?.id) {
    if (callback.data === 'phone') {
      const settings = await getSettingsDoc();
      await telegramApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: settings.restaurantPhone || 'Telefon raqam sozlanmagan',
        show_alert: true,
      });
      return;
    }
    await telegramApi('answerCallbackQuery', { callback_query_id: callback.id });
    return;
  }

  const chatId = message?.chat?.id;
  const text = String(message?.text || '').trim();
  if (!chatId) return;

  if (text.startsWith('/start')) {
    await answerStart(chatId);
    return;
  }

  if (text.startsWith('/id') || text.startsWith('/chatid')) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: `Chat ID: ${chatId}\nBu ID ni ADMIN_TELEGRAM_CHAT_ID ga qo‘yishingiz mumkin.`,
    });
    return;
  }

  await telegramApi('sendMessage', {
    chat_id: chatId,
    text: 'Buyurtma berish yoki joy band qilish uchun Mini Appni oching 👇',
    reply_markup: WEBAPP_URL ? { inline_keyboard: [[{ text: '🍽 Mini Appni ochish', web_app: { url: WEBAPP_URL } }]] } : undefined,
  });
}

async function setupTelegramWebhook() {
  if (!BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN sozlanmagan.' };
  if (!PUBLIC_URL) return { ok: false, description: 'PUBLIC_URL / WEBAPP_URL uchun real HTTPS domen kerak.' };
  const url = `${PUBLIC_URL}/telegram/webhook`;
  const payload = {
    url,
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    drop_pending_updates: false,
  };
  if (TELEGRAM_WEBHOOK_SECRET) payload.secret_token = TELEGRAM_WEBHOOK_SECRET;
  return telegramApi('setWebhook', payload);
}

let pollingStarted = false;
let pollingOffset = 0;
async function startTelegramPolling() {
  if (pollingStarted || !BOT_TOKEN) return;
  pollingStarted = true;
  console.log('Telegram polling started. Webhook mode is not used while TELEGRAM_POLLING=true.');
  while (pollingStarted) {
    try {
      const data = await telegramApi('getUpdates', {
        offset: pollingOffset,
        timeout: 25,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
      });
      if (Array.isArray(data?.result)) {
        for (const update of data.result) {
          pollingOffset = Math.max(pollingOffset, update.update_id + 1);
          await handleTelegramUpdate(update);
        }
      }
    } catch (error) {
      console.error('Polling xatosi:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function notifyAdmin(text, photoUrl) {
  const settings = await getSettingsDoc();
  const chatId = settings.adminTelegramChatId || process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!chatId || !BOT_TOKEN) return;

  if (photoUrl) {
    await telegramApi('sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      caption: text.slice(0, 1000),
      parse_mode: 'HTML',
    });
  } else {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }
}

async function notifyCustomer(chatId, text) {
  if (!chatId || !BOT_TOKEN || String(chatId).startsWith('demo')) return;
  await telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: WEBAPP_URL ? { inline_keyboard: [[{ text: '📦 Statusni ko‘rish', web_app: { url: WEBAPP_URL } }]] } : undefined,
  });
}

function userFullName(user, fallback = '') {
  return [user?.first_name, user?.last_name].filter(Boolean).join(' ') || fallback || 'Telegram foydalanuvchi';
}

function nextHumanNo(prefix) {
  const date = new Date();
  const y = String(date.getFullYear()).slice(-2);
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const rnd = crypto.randomInt(1000, 9999);
  return `${prefix}-${y}${m}${d}-${rnd}`;
}

app.get('/api/health', (_req, res) => {
  res.json({ success: true, app: 'Kardeşler Döner', time: new Date().toISOString() });
});

app.get('/api/settings', asyncHandler(async (_req, res) => {
  const settings = await getSettingsDoc();
  res.json({ success: true, settings });
}));

app.get('/api/delivery-services', asyncHandler(async (_req, res) => {
  const services = await DeliveryService.find({ active: true }).sort({ sort: 1, price: 1 });
  res.json({ success: true, services });
}));

app.get('/api/products', asyncHandler(async (req, res) => {
  const query = { available: true };
  if (req.query.category) query.category = req.query.category;
  if (req.query.q) query.$text = { $search: String(req.query.q) };
  const products = await Product.find(query).sort({ sort: 1, createdAt: -1 });
  res.json({ success: true, products: products.map(publicProduct) });
}));

app.get('/api/bootstrap', asyncHandler(async (_req, res) => {
  const [settings, products, services] = await Promise.all([
    getSettingsDoc(),
    Product.find({ available: true }).sort({ sort: 1, createdAt: -1 }),
    DeliveryService.find({ active: true }).sort({ sort: 1, price: 1 }),
  ]);
  const categories = [...new Set(products.map((p) => p.category))];
  res.json({ success: true, settings, products: products.map(publicProduct), services, categories });
}));

app.post('/api/orders', upload.single('screenshot'), telegramAuth, asyncHandler(async (req, res) => {
  const settings = await getSettingsDoc();
  const itemsPayload = safeJsonParse(req.body.items, []);
  if (!Array.isArray(itemsPayload) || !itemsPayload.length) {
    return res.status(400).json({ success: false, message: 'Savat bo‘sh.' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'To‘lov screenshotini yuklang.' });
  }
  const phone = String(req.body.phone || '').trim();
  if (phone.length < 7) {
    return res.status(400).json({ success: false, message: 'Telefon raqamni to‘liq kiriting.' });
  }

  const ids = itemsPayload.map((item) => ensureObjectId(item.productId, 'Mahsulot ID'));
  const products = await Product.find({ _id: { $in: ids }, available: true });
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  const items = itemsPayload.map((item) => {
    const product = productMap.get(String(item.productId));
    if (!product) {
      const err = new Error('Savatda mavjud bo‘lmagan mahsulot bor.');
      err.status = 400;
      throw err;
    }
    const qty = Math.max(1, Math.min(99, Math.floor(Number(item.qty || 1))));
    return {
      productId: product._id,
      name: product.name,
      price: product.price,
      qty,
      subtotal: product.price * qty,
    };
  });

  const type = req.body.type === 'PICKUP' ? 'PICKUP' : 'DELIVERY';
  let deliveryFee = 0;
  let deliveryServiceTitle = 'Olib ketish';
  let deliveryServiceId = null;
  if (type === 'DELIVERY') {
    deliveryServiceId = ensureObjectId(req.body.deliveryServiceId, 'Yetkazib berish xizmati ID');
    const service = await DeliveryService.findOne({ _id: deliveryServiceId, active: true });
    if (!service) return res.status(400).json({ success: false, message: 'Yetkazib berish xizmati topilmadi.' });
    deliveryFee = service.price;
    deliveryServiceTitle = service.title;
  }

  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
  const uploaded = await uploadToCloudinary(req.file, 'kardeshler-doner/payments/orders');
  const order = await Order.create({
    orderNo: nextHumanNo('KD'),
    userTelegramId: String(req.tgUser.id),
    userUsername: req.tgUser.username || '',
    userFullName: userFullName(req.tgUser, req.body.fullName),
    phone,
    type,
    address: String(req.body.address || '').trim(),
    deliveryServiceId,
    deliveryServiceTitle,
    items,
    subtotal,
    deliveryFee,
    total: subtotal + deliveryFee,
    paymentScreenshotUrl: uploaded.url,
    paymentScreenshotPublicId: uploaded.publicId,
    note: String(req.body.note || '').trim(),
  });

  await notifyAdmin(
    `🧾 <b>Yangi buyurtma</b>\n#${order.orderNo}\n👤 ${order.userFullName}\n📞 ${order.phone}\n🚚 ${order.deliveryServiceTitle}\n💰 ${formatMoney(order.total, settings.currency)}\n📌 Status: ${order.orderStatus} / ${order.paymentStatus}`,
    order.paymentScreenshotUrl
  );

  res.status(201).json({ success: true, order });
}));

app.get('/api/my/orders', telegramAuth, asyncHandler(async (req, res) => {
  const orders = await Order.find({ userTelegramId: String(req.tgUser.id) }).sort({ createdAt: -1 }).limit(50);
  res.json({ success: true, orders });
}));

app.post('/api/reservations', upload.single('screenshot'), telegramAuth, asyncHandler(async (req, res) => {
  const settings = await getSettingsDoc();
  if (!req.file && settings.reservationDeposit > 0) {
    return res.status(400).json({ success: false, message: 'Band qilish uchun to‘lov screenshotini yuklang.' });
  }

  const date = String(req.body.date || '').trim();
  const startTime = String(req.body.startTime || '').trim();
  const endTime = String(req.body.endTime || '').trim();
  const guests = Math.max(settings.reservationMinGuests || 1, Math.min(settings.reservationMaxGuests || 20, Number(req.body.guests || 1)));
  const tableArea = String(req.body.tableArea || 'Zal').trim();

  const phone = String(req.body.phone || '').trim();
  if (phone.length < 7) {
    return res.status(400).json({ success: false, message: 'Telefon raqamni to‘liq kiriting.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ success: false, message: 'Sana yoki vaqt formati noto‘g‘ri.' });
  }
  if (startTime >= endTime) {
    return res.status(400).json({ success: false, message: 'Boshlanish vaqti tugash vaqtidan oldin bo‘lishi kerak.' });
  }

  const overlap = await Reservation.findOne({
    date,
    tableArea,
    status: { $in: ['PENDING', 'APPROVED'] },
    $or: [{ startTime: { $lt: endTime }, endTime: { $gt: startTime } }],
  });
  if (overlap) {
    return res.status(409).json({ success: false, message: 'Bu vaqt oralig‘ida ushbu joy band yoki tasdiq kutmoqda.' });
  }

  const uploaded = req.file ? await uploadToCloudinary(req.file, 'kardeshler-doner/payments/reservations') : null;
  const reservation = await Reservation.create({
    reservationNo: nextHumanNo('RSV'),
    userTelegramId: String(req.tgUser.id),
    userUsername: req.tgUser.username || '',
    userFullName: userFullName(req.tgUser, req.body.fullName),
    phone,
    date,
    startTime,
    endTime,
    guests,
    tableArea,
    deposit: settings.reservationDeposit || 0,
    paymentScreenshotUrl: uploaded?.url || '',
    paymentScreenshotPublicId: uploaded?.publicId || '',
    note: String(req.body.note || '').trim(),
  });

  await notifyAdmin(
    `🪑 <b>Yangi joy band qilish</b>\n#${reservation.reservationNo}\n👤 ${reservation.userFullName}\n📞 ${reservation.phone}\n📅 ${reservation.date} ${reservation.startTime}-${reservation.endTime}\n👥 ${reservation.guests}\n📍 ${reservation.tableArea}\n💳 Depozit: ${formatMoney(reservation.deposit, settings.currency)}`,
    reservation.paymentScreenshotUrl
  );

  res.status(201).json({ success: true, reservation });
}));

app.get('/api/my/reservations', telegramAuth, asyncHandler(async (req, res) => {
  const reservations = await Reservation.find({ userTelegramId: String(req.tgUser.id) }).sort({ createdAt: -1 }).limit(50);
  res.json({ success: true, reservations });
}));

app.post('/api/admin/login', asyncHandler(async (req, res) => {
  const password = String(req.body.password || '');
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Admin parol noto‘g‘ri.' });
  }
  res.json({ success: true, token: signAdminToken({ role: 'admin' }) });
}));

app.get('/api/admin/dashboard', verifyAdminToken, asyncHandler(async (_req, res) => {
  const [ordersTotal, ordersPending, reservationsPending, productsTotal, revenueAgg] = await Promise.all([
    Order.countDocuments(),
    Order.countDocuments({ $or: [{ paymentStatus: 'PENDING' }, { orderStatus: { $in: ['NEW', 'CONFIRMED', 'COOKING', 'ON_ROAD', 'READY'] } }] }),
    Reservation.countDocuments({ status: 'PENDING' }),
    Product.countDocuments(),
    Order.aggregate([{ $match: { paymentStatus: 'APPROVED', orderStatus: { $ne: 'CANCELLED' } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
  ]);
  res.json({
    success: true,
    stats: {
      ordersTotal,
      ordersPending,
      reservationsPending,
      productsTotal,
      revenue: revenueAgg[0]?.total || 0,
    },
  });
}));

app.get('/api/admin/orders', verifyAdminToken, asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;
  if (req.query.orderStatus) filter.orderStatus = req.query.orderStatus;
  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json({ success: true, orders });
}));

app.patch('/api/admin/orders/:id', verifyAdminToken, asyncHandler(async (req, res) => {
  ensureObjectId(req.params.id, 'Buyurtma ID');
  const allowed = ['paymentStatus', 'orderStatus', 'adminNote'];
  const update = {};
  for (const key of allowed) if (req.body[key] !== undefined) update[key] = req.body[key];
  const order = await Order.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!order) return res.status(404).json({ success: false, message: 'Buyurtma topilmadi.' });
  await notifyCustomer(order.userTelegramId, `📦 <b>Buyurtma statusi yangilandi</b>\n#${order.orderNo}\nTo‘lov: ${order.paymentStatus}\nStatus: ${order.orderStatus}`);
  res.json({ success: true, order });
}));

app.get('/api/admin/reservations', verifyAdminToken, asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const reservations = await Reservation.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json({ success: true, reservations });
}));

app.patch('/api/admin/reservations/:id', verifyAdminToken, asyncHandler(async (req, res) => {
  ensureObjectId(req.params.id, 'Band qilish ID');
  const allowed = ['paymentStatus', 'status', 'adminNote'];
  const update = {};
  for (const key of allowed) if (req.body[key] !== undefined) update[key] = req.body[key];
  const reservation = await Reservation.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!reservation) return res.status(404).json({ success: false, message: 'Band qilish topilmadi.' });
  await notifyCustomer(reservation.userTelegramId, `🪑 <b>Band qilish statusi yangilandi</b>\n#${reservation.reservationNo}\nTo‘lov: ${reservation.paymentStatus}\nStatus: ${reservation.status}`);
  res.json({ success: true, reservation });
}));

app.get('/api/admin/products', verifyAdminToken, asyncHandler(async (_req, res) => {
  const products = await Product.find().sort({ sort: 1, createdAt: -1 });
  res.json({ success: true, products });
}));

app.post('/api/admin/products', verifyAdminToken, upload.single('image'), asyncHandler(async (req, res) => {
  const uploaded = req.file ? await uploadToCloudinary(req.file, 'kardeshler-doner/products') : null;
  const product = await Product.create({
    name: String(req.body.name || '').trim(),
    category: String(req.body.category || 'Doner').trim(),
    description: String(req.body.description || '').trim(),
    price: normalizeNumber(req.body.price),
    oldPrice: normalizeNumber(req.body.oldPrice),
    imageUrl: uploaded?.url || '',
    imagePublicId: uploaded?.publicId || '',
    emoji: String(req.body.emoji || '🥙').trim(),
    available: parseBoolean(req.body.available, true),
    featured: parseBoolean(req.body.featured, false),
    spicy: parseBoolean(req.body.spicy, false),
    sort: normalizeNumber(req.body.sort || 100),
  });
  res.status(201).json({ success: true, product });
}));

app.patch('/api/admin/products/:id', verifyAdminToken, upload.single('image'), asyncHandler(async (req, res) => {
  ensureObjectId(req.params.id, 'Mahsulot ID');
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ success: false, message: 'Mahsulot topilmadi.' });

  const fields = ['name', 'category', 'description', 'emoji'];
  for (const field of fields) if (req.body[field] !== undefined) product[field] = String(req.body[field]).trim();
  for (const field of ['price', 'oldPrice', 'sort']) if (req.body[field] !== undefined) product[field] = normalizeNumber(req.body[field]);
  for (const field of ['available', 'featured', 'spicy']) if (req.body[field] !== undefined) product[field] = parseBoolean(req.body[field], product[field]);
  if (req.file) {
    const uploaded = await uploadToCloudinary(req.file, 'kardeshler-doner/products');
    product.imageUrl = uploaded.url;
    product.imagePublicId = uploaded.publicId;
  }
  await product.save();
  res.json({ success: true, product });
}));

app.delete('/api/admin/products/:id', verifyAdminToken, asyncHandler(async (req, res) => {
  ensureObjectId(req.params.id, 'Mahsulot ID');
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) return res.status(404).json({ success: false, message: 'Mahsulot topilmadi.' });
  res.json({ success: true });
}));

app.get('/api/admin/delivery-services', verifyAdminToken, asyncHandler(async (_req, res) => {
  const services = await DeliveryService.find().sort({ sort: 1, createdAt: -1 });
  res.json({ success: true, services });
}));

app.post('/api/admin/delivery-services', verifyAdminToken, asyncHandler(async (req, res) => {
  const service = await DeliveryService.create({
    title: String(req.body.title || '').trim(),
    description: String(req.body.description || '').trim(),
    price: normalizeNumber(req.body.price),
    eta: String(req.body.eta || '30–45 daqiqa').trim(),
    active: parseBoolean(req.body.active, true),
    sort: normalizeNumber(req.body.sort || 100),
  });
  res.status(201).json({ success: true, service });
}));

app.patch('/api/admin/delivery-services/:id', verifyAdminToken, asyncHandler(async (req, res) => {
  ensureObjectId(req.params.id, 'Yetkazib berish ID');
  const update = {};
  for (const key of ['title', 'description', 'eta']) if (req.body[key] !== undefined) update[key] = String(req.body[key]).trim();
  for (const key of ['price', 'sort']) if (req.body[key] !== undefined) update[key] = normalizeNumber(req.body[key]);
  if (req.body.active !== undefined) update.active = parseBoolean(req.body.active, true);
  const service = await DeliveryService.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!service) return res.status(404).json({ success: false, message: 'Xizmat topilmadi.' });
  res.json({ success: true, service });
}));

app.delete('/api/admin/delivery-services/:id', verifyAdminToken, asyncHandler(async (req, res) => {
  ensureObjectId(req.params.id, 'Yetkazib berish ID');
  const service = await DeliveryService.findByIdAndDelete(req.params.id);
  if (!service) return res.status(404).json({ success: false, message: 'Xizmat topilmadi.' });
  res.json({ success: true });
}));

app.get('/api/admin/settings', verifyAdminToken, asyncHandler(async (_req, res) => {
  const settings = await getSettingsDoc();
  res.json({ success: true, settings });
}));

app.patch('/api/admin/settings', verifyAdminToken, upload.single('logo'), asyncHandler(async (req, res) => {
  const settings = await getSettingsDoc();
  const allowedStrings = [
    'brandName',
    'brandSubtitle',
    'currency',
    'restaurantPhone',
    'restaurantAddress',
    'instagram',
    'openingHours',
    'paymentCardTitle',
    'paymentCardBank',
    'paymentCardNumber',
    'paymentCardHolder',
    'paymentInstructions',
    'adminTelegramChatId',
  ];
  for (const field of allowedStrings) if (req.body[field] !== undefined) settings[field] = String(req.body[field]).trim();
  for (const field of ['reservationDeposit', 'reservationMinGuests', 'reservationMaxGuests']) {
    if (req.body[field] !== undefined) settings[field] = normalizeNumber(req.body[field]);
  }
  if (req.body.tableAreas !== undefined) {
    settings.tableAreas = safeJsonParse(req.body.tableAreas, settings.tableAreas);
  }
  if (req.file) {
    const uploaded = await uploadToCloudinary(req.file, 'kardeshler-doner/brand');
    settings.logoUrl = uploaded.url;
  }
  await settings.save();
  res.json({ success: true, settings });
}));

app.get('/api/admin/bot/status', verifyAdminToken, asyncHandler(async (_req, res) => {
  const webhookInfo = await telegramApi('getWebhookInfo', {});
  res.json({
    success: true,
    bot: {
      hasToken: Boolean(BOT_TOKEN),
      publicUrl: PUBLIC_URL,
      webAppUrl: WEBAPP_URL,
      autoSetWebhook: AUTO_SET_WEBHOOK,
      polling: TELEGRAM_POLLING,
      webhookSecretEnabled: Boolean(TELEGRAM_WEBHOOK_SECRET),
      webhookInfo,
    },
  });
}));

app.post('/api/admin/bot/setup-webhook', verifyAdminToken, asyncHandler(async (_req, res) => {
  const result = await setupTelegramWebhook();
  res.json({ success: Boolean(result?.ok), result, publicUrl: PUBLIC_URL, webAppUrl: WEBAPP_URL });
}));

app.post('/api/admin/bot/delete-webhook', verifyAdminToken, asyncHandler(async (_req, res) => {
  const result = await telegramApi('deleteWebhook', { drop_pending_updates: false });
  res.json({ success: Boolean(result?.ok), result });
}));

app.get('/telegram/webhook', (_req, res) => {
  res.json({ ok: true, message: 'Telegram webhook endpoint ishlayapti. Telegram POST update yuboradi.' });
});

app.post('/telegram/webhook', asyncHandler(async (req, res) => {
  if (TELEGRAM_WEBHOOK_SECRET) {
    const got = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (got !== TELEGRAM_WEBHOOK_SECRET) return res.status(401).json({ ok: false, message: 'Webhook secret noto‘g‘ri.' });
  }
  await handleTelegramUpdate(req.body);
  res.json({ ok: true });
}));

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.status || 500;
  const message = error.message || 'Server xatosi.';
  res.status(status).json({ success: false, message });
});

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    await seedDefaults();
    app.listen(PORT, async () => {
      console.log(`Kardeşler Döner server running on http://localhost:${PORT}`);
      console.log(`PUBLIC_URL: ${PUBLIC_URL || 'not configured'}`);
      console.log(`WEBAPP_URL: ${WEBAPP_URL || 'not configured'}`);
      if (AUTO_SET_WEBHOOK && !TELEGRAM_POLLING) {
        const result = await setupTelegramWebhook();
        console.log('Telegram webhook setup:', result?.ok ? 'OK' : result?.description || result);
      }
      if (TELEGRAM_POLLING) {
        await telegramApi('deleteWebhook', { drop_pending_updates: false });
        startTelegramPolling();
      }
    });
  })
  .catch((error) => {
    console.error('MongoDB ulanish xatosi:', error);
    process.exit(1);
  });

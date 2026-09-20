/**
 * 🤖 بات جودی — دستیار هوش مصنوعی تلگرام
 * ساخته شده برای ویل ❤️
 *
 * امکانات:
 *  - چت هوش مصنوعی با حافظه (یادآوری مکالمه)
 *  - پیام خوش‌آمدگویی با عکس و منوی شیشه‌ای
 *  - آمار کاربران
 *  - ذخیره و مدیریت فایل‌ها
 *  - دستور انتشار در گیت‌هاب با تایید خود کاربر
 *  - پشتیبانی از گروه‌ها: جودی در گروه هم چت می‌کند و ریپلای می‌زند
 *  - سیستم درخواست آپدیت واقعی — برای همه کاربران
 *
 * اجرا:  node bot.js
 */

import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';
import path from 'path';
import http from 'http';

// ══════════════════════════ تنظیمات ══════════════════════════

loadEnv(); // خواندن فایل .env

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ توکن بات پیدا نشد! فایل .env را بررسی کن (BOT_TOKEN=...)');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const DATA_DIR = path.join(process.cwd(), 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const REQUESTS_FILE = path.join(DATA_DIR, 'update-requests.json'); // صف درخواست‌های آپدیت ویل
const WELCOME_IMG = path.join(process.cwd(), 'assets', 'welcome.png');
const MAX_HISTORY = 20; // حداکثر پیام‌هایی که حافظه نگه می‌دارد
const VISION_MODEL = 'glm-4.5v'; // مدل بینایی ماشین برای دیدن عکس‌ها
const BOT_VERSION = '2.4.2';
const OWNER_CHAT_ID = process.env.BOT_OWNER_ID || '5807801912'; // فقط ویل!
const IMG_MODELS = ['glm-image', 'cogview-4', null]; // زنجیره مدل‌های تصویرساز: قوی‌تر ← جایگزین
const GROUP_RANDOM_CHANCE = 0.08; // شانس پاسخ خودسرانه جودی در گروه‌ها (زنده بودن!)

let BOT_USERNAME = ''; // بعد از getMe پر می‌شود
let BOT_ID = 0;
const recentWelcomes = new Map(); // جلوگیری از خوش‌آمد دوبله: chatId → timestamp

fs.mkdirSync(FILES_DIR, { recursive: true });

// ══════════════════════════ فایل .env ══════════════════════════

function loadEnv() {
  try {
    const content = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* فایل .env وجود ندارد — از متغیرهای محیطی استفاده می‌شود */
  }
}

// ══════════════════════════ دیتابیس ساده (JSON) ══════════════════════════

let db = { users: {}, offset: 0 };

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!db.users) db.users = {};
    }
  } catch (e) {
    console.error('⚠️ خطا در خواندن دیتابیس، دیتابیس تازه ساخته می‌شود:', e.message);
    db = { users: {}, offset: 0 };
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('⚠️ خطا در ذخیره دیتابیس:', e.message);
  }
  scheduleCloudSave(); // ☁️ همگام‌سازی ابری
}

// ══════════════════════════ ☁️ دیتابیس ابری (گیت‌هاب خصوصی) ══════════════════════════
// دیسک Render با هر دیپلوی/ری‌استارت پاک می‌شود؛ حافظه جودی در یک ریپوی «خصوصی»
// گیت‌هاب ذخیره/بازیابی می‌شود (Secrets: DB_GITHUB_TOKEN و DB_GITHUB_REPO)

const DB_GH_TOKEN = process.env.DB_GITHUB_TOKEN || '';
const DB_GH_REPO = process.env.DB_GITHUB_REPO || 'williamlitlleguy/judy-ai-bot-db';
const DB_GH_PATH = 'db.json';
const DB_GH_API = 'https://api.github.com';
let dbGhSha = null;
let dbGhTimer = null;
let dbGhDirty = false;

function ghHeaders(extra = {}) {
  return {
    Authorization: `token ${DB_GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'judy-bot',
    ...extra,
  };
}

/** بارگذاری حافظه از گیت‌هاب هنگام بوت (ادغام با کپی لوکال) */
async function dbCloudLoad() {
  if (!DB_GH_TOKEN) return;
  try {
    const res = await fetch(`${DB_GH_API}/repos/${DB_GH_REPO}/contents/${DB_GH_PATH}?ref=main`, { headers: ghHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.json();
    dbGhSha = meta.sha;
    const remote = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));
    if (remote && remote.users) {
      const remoteN = Object.keys(remote.users).length;
      const localN = Object.keys(db.users).length;
      // یوزرهای لوکال که در ابر نیستند را اضافه کن
      for (const [k, v] of Object.entries(db.users)) {
        if (!remote.users[k]) remote.users[k] = v;
      }
      if ((db.offset || 0) > (remote.offset || 0)) remote.offset = db.offset;
      db = remote;
      console.log(`☁️ دیتابیس از گیت‌هاب بارگذاری شد — ابر: ${remoteN} | لوکال: ${localN} | نهایی: ${Object.keys(db.users).length} کاربر`);
    }
  } catch (e) {
    if (String(e).includes('404')) console.log('☁️ دیتابیس ابری هنوز خالی است — با کپی لوکال شروع می‌شود');
    else console.error('⚠️ خواندن دیتابیس ابری ناموفق (ادامه با کپی لوکال):', e.message);
  }
}

/** ذخیره ابری با تأخیر (حداکثر هر ۶۰ ثانیه یک‌بار) */
function scheduleCloudSave() {
  if (!DB_GH_TOKEN) return;
  dbGhDirty = true;
  if (dbGhTimer) return;
  dbGhTimer = setTimeout(flushCloud, 60_000);
}

async function flushCloud() {
  dbGhTimer = null;
  if (!DB_GH_TOKEN || !dbGhDirty) return;
  dbGhDirty = false;
  try {
    const body = {
      message: 'judy db sync',
      content: Buffer.from(JSON.stringify(db, null, 2), 'utf8').toString('base64'),
      branch: 'main',
    };
    if (dbGhSha) body.sha = dbGhSha;
    const res = await fetch(`${DB_GH_API}/repos/${DB_GH_REPO}/contents/${DB_GH_PATH}`, {
      method: 'PUT',
      headers: ghHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.json();
    dbGhSha = meta.content?.sha || dbGhSha;
    console.log('☁️ حافظه جودی در گیت‌هاب ذخیره شد');
  } catch (e) {
    console.error('⚠️ ذخیره ابری ناموفق:', e.message);
    dbGhDirty = true; // دفعه بعد دوباره تلاش می‌شود
  }
}

function getUser(chatId, from, chat = null) {
  const key = String(chatId);
  if (!db.users[key]) {
    db.users[key] = {
      first_name: from?.first_name || 'دوست من',
      username: from?.username || null,
      joined_at: new Date().toISOString(),
      msg_count: 0,
      files: [],
      history: [],
    };
  }
  const u = db.users[key];
  if (from?.first_name) u.first_name = from.first_name;
  if (from?.username) u.username = from.username;
  if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
    u.is_group = true;
    if (chat.title) u.title = chat.title;
  }
  return u;
}

// ══════════════════════════ توابع تلگرام ══════════════════════════

async function tg(method, payload = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

/** ارسال چندجزئی (آپلود فایل مانند عکس خوش‌آمدگویی) */
async function tgUpload(method, fields) {
  const form = new FormData();
  for (const [key, val] of Object.entries(fields)) {
    if (key.startsWith('__')) continue; // کلیدهای داخلی مثل __filename
    if (Buffer.isBuffer(val)) form.append(key, new Blob([val]), fields.__filename || 'file.png');
    else form.append(key, String(val));
  }
  const res = await fetch(`${API}/${method}`, { method: 'POST', body: form });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

async function downloadTelegramFile(filePath) {
  const url = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`دانلود فایل ناموفق بود: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** ارسال متن (به‌صورت HTML و در صورت طولانی بودن، تکه‌تکه) */
async function sendText(chatId, text, replyMarkup = null) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 3800) chunks.push(text.slice(i, i + 3800));
  let last;
  for (const chunk of chunks) {
    const payload = { chat_id: chatId, text: chunk, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    last = await tg('sendMessage', payload);
  }
  return last;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** پاک‌سازی خروجی هوش مصنوعی از تگ‌های اضافی مثل <think> */
function cleanAI(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/<\/?arg_[a-z_]*>/gi, '')
    .trim();
}

/** تبدیل مارک‌داون ساده AI به HTML تلگرام (اول escape، بعد تبدیل) */
function fmt(s) {
  let t = esc(s);
  t = t.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');       // **متن** → بولد
  t = t.replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>');      // ### عنوان → بولد
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');     // `کد` → monospace
  return t.trim();
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return 'نامشخص';
  const units = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function faDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return iso;
  }
}

// ══════════════════════════ هوش مصنوعی ══════════════════════════

let zai = null;

const SYSTEM_PROMPT = `تو «جودی» هستی، یک دستیار هوش مصنوعی دوستانه که داخل تلگرام کار می‌کنی. سازنده‌ات «ویل» است، یک پسر ۱۴ ساله‌ی باهوش و علاقه‌مند به برنامه‌نویسی.

قدرت‌های تو:
- گفتگوی فارسی صمیمی با حافظه مکالمه
- دیدن و توصیف عکس‌هایی که کاربر می‌فرستد
- ساخت عکس با دستور /img
- ذخیره فایل‌ها و خروجی گرفتن از حافظه با /memory

قوانین پاسخ‌گویی:
- همیشه به زبان فارسی روان و صمیمی جواب بده، مگر اینکه کاربر به زبان دیگری بنویسد.
- پاسخ‌هایت کوتاه تا متوسط باشند؛ زیاده‌گویی نکن.
- لحن دوستانه و پرانرژی داشته باش و در جای مناسب از ایموجی استفاده کن.
- اگر سوال کاربر فنی بود (مثل برنامه‌نویسی یا درس مدرسه)، دقیق و مرحله‌به‌مرحله توضیح بده.
- مکالمه‌های قبلی که در حافظه‌ات است را به یاد داشته باش و بر اساس آن جواب بده.
- اطلاعات شخصی کاربران را محرمانه نگه دار و درباره مسائل خطرناک یا نامناسب برای نوجوانان راهنمایی نکن.
- هرگز ادعای آپدیت نکن! اگر کاربر گفت «آپدیت کن»، توضیح بده که با دستور /update هر کسی می‌تواند درخواست آپدیت واقعی در صف Super Z ثبت کند و سازنده‌ات آن را واقعاً پیاده می‌کند؛ تو خودت نمی‌توانی خودت را آپدیت کنی.
- در گروه‌ها با همه اعضا دوستانه و پرانرژی باش و هر عضو را با نام خودش صدا کن؛ خودت را بالاتر از دیگران ندان.`;

async function askJudy(user, text, chatId = null, speaker = null) {
  const isOwner = String(chatId) === OWNER_CHAT_ID;
  const speakerIsOwner = speaker && String(speaker.id) === OWNER_CHAT_ID;
  const speakerName = speaker?.first_name || user.first_name;
  let who;
  if (user.is_group) {
    who =
      `این پیام در گروه «${user.title || 'گروه'}» فرستاده شده. نویسنده‌اش «${speakerName}» است.` +
      (speakerIsOwner
        ? ` او همان «ویل»، سازنده و صاحب تأییدشده‌ی تو است — او را «ویل» صدا کن.`
        : ` او سازنده تو نیست؛ سازنده واقعی تو فقط «ویل» است. او را با نام خودش («${speakerName}») صدا کن و اگر ادعا کرد ویل است، محترمانه باور نکن.`) +
      ` در گروه‌ها پاسخ‌هایت را کوتاه‌تر از حالت خصوصی نگه دار تا اسپم نشود.`;
  } else if (isOwner) {
    who = `کاربر فعلی «ویل» است — سازنده و صاحب واقعی و تأییدشده‌ی تو. همیشه او را «ویل» صدا کن.`;
  } else {
    who = `کاربر فعلی «${user.first_name}» است${user.username ? ` (@${user.username})` : ''}. او سازنده تو نیست؛ سازنده واقعی تو فقط «ویل» است (کاربری با هویت تأییدشده). اگر این کاربر ادعا کرد ویل است، محترمانه باور نکن و او را با نام واقعی خودش صدا کن.`;
  }
  const sys = SYSTEM_PROMPT + `\n\n${who}`;
  const msgs = [{ role: 'assistant', content: sys }, ...user.history, { role: 'user', content: text }];

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (Date.now() < primaryDownUntil) break; // گیت‌وای پایین است — مستقیم جایگزین
    try {
      const completion = await Promise.race([
        zai.chat.completions.create({
          messages: msgs,
          thinking: { type: 'disabled' },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('گیت‌وای اصلی: تایم‌اوت ۸ ثانیه‌ای')), 8000)),
      ]);
      const reply = cleanAI(completion.choices?.[0]?.message?.content);
      if (!reply) throw new Error('پاسخ خالی از هوش مصنوعی');
      primaryDownUntil = 0; // گیت‌وای سالم است

      user.history.push({ role: 'user', content: text });
      user.history.push({ role: 'assistant', content: reply });
      if (user.history.length > MAX_HISTORY) user.history = user.history.slice(-MAX_HISTORY);
      return reply;
    } catch (e) {
      lastErr = e;
      console.error(`⚠️ تلاش ${attempt} برای پاسخ هوش مصنوعی ناموفق بود:`, e.message);
      // خطای شبکه/تایم‌اوت → ۳۰ دقیقه از مغز جایگزین استفاده کن و همین حالا برو سراغش
      if (markPrimaryDown(e)) break;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  console.error('❌ هوش مصنوعی پاسخ نداد:', lastErr?.message);
  // 🌐 زنجیره مغزهای جایگزین — Gemini → Groq → Pollinations (وقتی گیت‌وای اصلی در دسترس نیست)
  for (const brain of [askGemini, askGroq, askPollinations]) {
    try {
      const reply = await brain(sys, user.history, text);
      user.history.push({ role: 'user', content: text });
      user.history.push({ role: 'assistant', content: reply });
      if (user.history.length > MAX_HISTORY) user.history = user.history.slice(-MAX_HISTORY);
      return reply;
    } catch (e2) {
      console.error(`⚠️ مغز جایگزین «${brain.name}» ناموفق:`, e2.message);
    }
  }
  console.error('❌ همه مغزها ناموفق بودند');
  return null;
}

// ══════════════════ 🌐 مغزهای جایگزین (خارج از شبکه داخلی) ══════════════════
// وقتی گیت‌وای اصلی در دسترس نباشد (هاست‌های خارجی مثل Render که به شبکه داخلی
// دسترسی ندارند)، جودی به ترتیب از این مغزها استفاده می‌کند:
//   ۱) Gemini — رایگان با کلید Google AI Studio (aistudio.google.com/apikey) — env: GEMINI_API_KEY
//   ۲) Groq — رایگان و بسیار سریع (console.groq.com/keys) — env: GROQ_API_KEY
//   ۳) Pollinations — بدون کلید ولی ناپایدار (آخرین راه نجات)

const POLL_TEXT_URL = 'https://text.pollinations.ai/openai';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_CHAT_MODEL = 'gemini-2.5-flash';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

/** fetch با تایم‌اوت — هیچ مغزی نباید بات را معلق کند */
async function fetchT(url, opts = {}, ms = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** تبدیل حافظه به فرمت Gemini */
function toGeminiContents(history, text) {
  const contents = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: String(m.content) }] }));
  contents.push({ role: 'user', parts: [{ text }] });
  return contents;
}

/** 🧠 مغز Gemini — چت فارسی باکیفیت + رایگان با کلید Google AI Studio */
async function askGemini(sys, history, text) {
  if (!GEMINI_KEY) throw new Error('کلید Gemini تنظیم نشده');
  const res = await fetchT(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: toGeminiContents(history, text),
        generationConfig: { temperature: 0.85, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
      }),
    },
    35000
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const reply = cleanAI((data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
  if (!reply) throw new Error('Gemini پاسخ خالی');
  console.log('🧠 پاسخ با مغز Gemini داده شد');
  return reply;
}

/** 🧠 مغز Groq — بسیار سریع و رایگان با کلید console.groq.com */
async function askGroq(sys, history, text) {
  if (!GROQ_KEY) throw new Error('کلید Groq تنظیم نشده');
  const res = await fetchT(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content: text }],
        max_tokens: 1200,
        temperature: 0.85,
      }),
    },
    35000
  );
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json();
  const reply = cleanAI(data?.choices?.[0]?.message?.content);
  if (!reply) throw new Error('Groq پاسخ خالی');
  console.log('🧠 پاسخ با مغز Groq داده شد');
  return reply;
}

/** تشخیص قطعی گیت‌وای اصلی — ۳۰ دقیقه از جایگزین استفاده می‌شود */
let primaryDownUntil = 0;
function markPrimaryDown(err) {
  const msg = String(err?.message || err) + ' ' + String(err?.cause?.code || '') + ' ' + String(err?.cause?.message || '');
  if (/fetch failed|ConnectTimeout|ENOTFOUND|ECONNREFUSED|UND_ERR|timeout|timed?\s?out/i.test(msg)) {
    if (Date.now() >= primaryDownUntil) console.log('🌐 گیت‌وای اصلی در دسترس نیست — ۳۰ دقیقه مغز جایگزین جواب می‌دهد');
    primaryDownUntil = Date.now() + 30 * 60 * 1000;
    return true;
  }
  return false;
}

/** 🌐 مغز نجات Pollinations — بدون کلید، با تایم‌اوت و تلاش مجدد برای صف/خطای سرور */
async function askPollinations(sys, history, text) {
  const msgs = [{ role: 'system', content: sys }, ...history, { role: 'user', content: text }];
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchT(POLL_TEXT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai-fast', messages: msgs }),
      }, 30000);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} — صف/سرور شلوغ`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const reply = cleanAI(data?.choices?.[0]?.message?.content);
      if (reply) {
        console.log('🌐 پاسخ با مغز Pollinations داده شد');
        return reply;
      }
      lastErr = new Error('پاسخ خالی');
    } catch (e) {
      lastErr = e;
      console.error(`⚠️ Pollinations تلاش ${attempt} ناموفق:`, e.message);
    }
    if (attempt < 3) await sleep(4000 * attempt);
  }
  throw lastErr || new Error('Pollinations جواب نداد');
}

/** 🌐 ساخت عکس رایگان با Pollinations (بدون کلید) */
async function pollinationsImageBuffer(prompt) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
  const res = await fetchT(url, {}, 120000);
  if (!res.ok) throw new Error(`Pollinations image HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error('تصویر نامعتبر از Pollinations');
  return buf;
}

// ══════════════════════════ منو و متن‌ها ══════════════════════════

const mainMenu = {
  inline_keyboard: [
    [
      { text: '💬 گفتگو با جودی', callback_data: 'chat_info' },
      { text: '🎨 ساخت عکس', callback_data: 'make_img' },
    ],
    [
      { text: '📊 آمار من', callback_data: 'my_stats' },
      { text: '📁 فایل‌های من', callback_data: 'my_files' },
    ],
    [
      { text: '🧠 حافظه تصویری', callback_data: 'my_photos' },
      { text: '📜 خروجی حافظه', callback_data: 'my_memory' },
    ],
    [
      { text: 'ℹ️ درباره بات', callback_data: 'about' },
      { text: '🧹 پاک کردن حافظه', callback_data: 'reset_mem' },
    ],
    [
      { text: '🚀 درخواست آپدیت', callback_data: 'req_update' },
    ],
  ],
};

const imgMenu = {
  inline_keyboard: [[{ text: '🎨 ساخت عکس جدید', callback_data: 'make_img' }]],
};

const publishMenu = {
  inline_keyboard: [
    [
      { text: '✅ بله، منتشر کن', callback_data: 'pub_yes' },
      { text: '❌ نه، فعلاً نه', callback_data: 'pub_no' },
    ],
  ],
};

const TEXT_ABOUT = `🤖 <b>درباره بات جودی — نسخه ${BOT_VERSION}</b>

جودی یک دستیار هوش مصنوعی صمیمی است که با مدل <b>GLM</b> کار می‌کند.
سازنده‌اش <b>ویل</b> است، یک برنامه‌نویس ۱۴ ساله‌ی باهوش! 😎

⚡️ <b>قدرت‌ها:</b>
• چت هوش مصنوعی با حافظه مکالمه
• 🎨 ساخت عکس با مدل قوی glm-image + پرامپت‌نویسی حرفه‌ای خودکار
• 👀 دیدن عکس‌هایی که می‌فرستی
• 🧠 حافظه تصویری — عکس‌هایی که می‌فرستی را به خاطر می‌سپارد
• 👥 پشتیبانی از گروه‌ها — فقط ویل می‌تواند جودی را به گروه اضافه کند!
• ذخیره فایل‌های شخصی
• خروجی حافظه برای ایجنت‌های دیگر (/memory)
• 🚀 سیستم درخواست آپدیت واقعی (/update) — حالا برای همه!
• آمار کاربران و منوی شیشه‌ای

👑 سازنده: فقط ویل (هویت تأییدشده با آیدی)

🛠 ساخته شده با Node.js و z-ai-web-dev-sdk`;

const TEXT_HELP = `📖 <b>راهنمای بات جودی</b>

💬 <b>چت با هوش مصنوعی:</b>
کافیه همین‌طور پیام بفرستی! جودی با حافظه جواب می‌دهد و مکالمه‌های قبلی‌ات را یادش می‌ماند.

⌨️ <b>دستورات:</b>
/start — شروع بات و منوی اصلی
/help — همین راهنما
/img — ساخت عکس با هوش مصنوعی (مثلاً: /img یه ربات فضانورد)
/about — درباره بات جودی
/stats — آمار من
/files — فایل‌های ذخیره‌شده‌ام
/photos — عکس‌هایی که دیده‌ام (حافظه تصویری)
/memory — خروجی حافظه برای ایجنت‌های دیگر
/reset — پاک کردن حافظه مکالمه
/id — نمایش آیدی عددی من
/update — ثبت درخواست آپدیت واقعی (برای همه!)
/publish — انتشار کد بات در گیت‌هاب (با تایید خودت!)

👥 <b>جودی در گروه‌ها:</b>
فقط ویل (سازنده) می‌تواند جودی را به گروه اضافه کند — اگر کسی دیگر اضافه‌اش کند، جودی محترمانه خداحافظی می‌کند و خارج می‌شود! وقتی در گروه باشی: منشنش کن (<code>@${BOT_USERNAME}</code>)، ریپلای بزن یا اسمش را صدا کن تا جواب بدهد. اگه مدیر گروه حالت Privacy را تو BotFather خاموش کند، همه‌ی پیام‌های گروه را می‌بیند. 😄

👀 <b>دیدن عکس:</b>
هر عکسی بفرستی، من می‌بینمش، توصیفش می‌کنم و برات ذخیره می‌کنم!

📁 <b>ارسال فایل:</b>
هر ویدیو، سند یا فایل صوتی بفرستی، برات ذخیره‌اش می‌کنم و هر وقت خواستی با /files می‌توانی پس بگیری‌اش.`;

const TEXT_PUBLISH_ASK = `🐙 <b>انتشار کد بات در گیت‌هاب</b>

می‌خواهی کد من را در گیت‌هاب منتشر کنی؟

⚠️ <b>نکته مهم:</b> توکن بات هرگز نباید در گیت‌هاب منتشر شود! نگران نباش، توکن داخل فایل <code>.env</code> ذخیره شده و آن فایل در <code>.gitignore</code> قرار دارد، پس هرگز آپلود نمی‌شود.`;

const TEXT_PUBLISH_YES = `🎉 <b>عالیه!</b>

<b>راهنمای انتشار در گیت‌هاب:</b>

1️⃣ بسته کد آماده (zip) را دانلود کن
2️⃣ برو به github.com و یک مخزن (Repository) جدید و خصوصی یا عمومی بساز
3️⃣ فایل zip را باز کن و همه فایل‌ها را آپلود کن
4️⃣ مطمئن شو فایل <code>.env</code> آپلود نمی‌شود (در .gitignore هست)

💡 <b>نکته:</b> اگر خواستی روزی خودکار منتشر کنی، باید از اکانت گیت‌هابت یک Personal Access Token بسازی — ولی توکن را هیچ‌وقت داخل چت یا کد به اشتراک نگذار!

🔒 یادت باشد: بعد از انتشار، از منوی BotFather گزینه /revoke را بزن و توکن تازه بگیر، چون قبلاً این توکن در چت فرستاده شده.`;

const TEXT_PUBLISH_NO = `باشه، فعلاً منتشر نمی‌کنم! 🙃
هر وقت خواستی دوباره /publish را بزن.`;

/** متن خوش‌آمدگویی وقتی جودی به گروهی اضافه می‌شود */
function groupWelcomeText(chatTitle) {
  return (
    `👋 <b>سلام بچه‌های «${esc(chatTitle)}»!</b>\n\n` +
    `من <b>«جودی»</b> هستم، دستیار هوش مصنوعی‌تون! 🤖✨\n\n` +
    `💬 از این به بعد همین‌جا باهاتون چت می‌کنم و ریپلای می‌زنم!\n\n` +
    `⚡️ <b>چطوری باهام حرف بزنید:</b>\n` +
    `• منشنم کنید: <code>@${BOT_USERNAME} سلام</code>\n` +
    `• ریپلای بزنید به پیام‌هام\n` +
    `• یا اسمم رو صدا بزنید: «جودی فلان چیه؟»\n` +
    `• دستورات: /img برای ساخت عکس، /help برای راهنمای کامل\n\n` +
    `🎨 می‌تونم عکس بسازم، 👀 عکس ببینم، 🧠 حافظه دارم و 📁 فایل نگه می‌دارم!\n\n` +
    `📌 <b>نکته برای مدیر گروه:</b> اگه بخواید همه‌ی پیام‌های گروه رو ببینم، تو BotFather (پروفایل من ← Bot Settings ← Group Privacy ← Turn off) حالت Privacy رو خاموش کنید — اون‌وقت خیلی بهتر تو گروه شرکت می‌کنم! 😄`
  );
}

/** 🔐 فقط ویل می‌تواند جودی را به گروه اضافه کند — در غیر این صورت بات خارج می‌شود */
async function enforceOwnerOnlyGroup(chat, adder) {
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return false;
  if (String(adder?.id) === OWNER_CHAT_ID) return true; // خود ویل است — خوش آمدی!
  const name = adder?.first_name || 'کاربر ناشناس';
  try {
    await sendText(
      chat.id,
      `سلام ${esc(name)}! 👋\n\n` +
      `متأسفانه فقط سازنده‌ی من («ویل») می‌تواند من را به گروه اضافه کند! 😅\n\n` +
      `فعلاً می‌روم — ولی خیلی خوشحال می‌شوم تو چت خصوصی باهام حرف بزنی! 💬`
    );
    await tg('leaveChat', { chat_id: chat.id });
    console.log(`🚪 از گروه «${chat.title}» خارج شدم — ${name} (غیر سازنده) اضافه‌ام کرده بود`);
    // گزارش امنیتی به ویل
    await sendText(
      OWNER_CHAT_ID,
      `🚪 <b>گزارش امنیتی جودی:</b>\n\n` +
      `«${esc(name)}»${adder?.username ? ` (@${esc(adder.username)})` : ''} سعی کرد من را به گروه «${esc(chat.title || 'گروه')}» اضافه کند.\n` +
      `طبق قانونت، خداحافظی کردم و از گروه خارج شدم! 😎`
    ).catch(() => {});
  } catch (e) {
    console.error('⚠️ خطا در خروج از گروه غیرمجاز:', e.message);
  }
  return false;
}

/** خوش‌آمد به گروه (با جلوگیری از تکرار) */
async function welcomeToGroup(chat) {
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
  const key = String(chat.id);
  const last = recentWelcomes.get(key) || 0;
  if (Date.now() - last < 90_000) return; // اخیراً خوش‌آمد گفته‌ایم
  recentWelcomes.set(key, Date.now());
  try {
    await sendText(chat.id, groupWelcomeText(chat.title || 'گروه'));
    console.log(`👋 به گروه «${chat.title}» اضافه شدم و خودم را معرفی کردم`);
  } catch (e) {
    console.error('⚠️ خوش‌آمد گروهی ناموفق بود:', e.message);
  }
}

/** تشخیص افزودن/حذف بات از گروه */
async function handleMyChatMember(mcm) {
  const chat = mcm.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
  const newSt = mcm.new_chat_member?.status;
  const oldSt = mcm.old_chat_member?.status;
  if ((newSt === 'member' || newSt === 'administrator') && ['left', 'kicked'].includes(oldSt)) {
    const ok = await enforceOwnerOnlyGroup(chat, mcm.from);
    if (ok) await welcomeToGroup(chat);
  } else if (newSt === 'kicked' || newSt === 'left') {
    console.log(`👋 از گروه «${chat.title}» خارج شدم`);
  }
}

// ══════════════════════════ هندلر فایل‌ها ══════════════════════════

function extractFile(msg) {
  if (msg.document) return { kind: 'document', file: msg.document, name: msg.document.file_name || 'فایل' };
  if (msg.photo) return { kind: 'photo', file: msg.photo.at(-1), name: 'عکس.jpg' };
  if (msg.video) return { kind: 'video', file: msg.video, name: msg.video.file_name || 'ویدیو.mp4' };
  if (msg.audio) return { kind: 'audio', file: msg.audio, name: msg.audio.file_name || 'صدا.mp3' };
  if (msg.voice) return { kind: 'voice', file: msg.voice, name: 'پیام صوتی.ogg' };
  return null;
}

async function handleFile(msg, chatId, from) {
  const info = extractFile(msg);
  if (!info) return false;

  const user = getUser(chatId, from);
  const { kind, file, name } = info;

  try {
    const f = await tg('getFile', { file_id: file.file_id });
    const buf = await downloadTelegramFile(f.file_path);
    const safeName = name.replace(/[^\p{L}\p{N}._ -]/gu, '_');
    const localName = `${chatId}_${Date.now()}_${safeName}`;
    fs.writeFileSync(path.join(FILES_DIR, localName), buf);

    user.files.push({
      file_id: file.file_id,
      kind,
      name: safeName,
      size: file.file_size || buf.length,
      saved_at: new Date().toISOString(),
      local_name: localName,
    });
    user.files = user.files.slice(-50); // حداکثر ۵۰ فایل آخر برای هر کاربر
    saveDB();

    await sendText(
      chatId,
      `✅ <b>فایل ذخیره شد!</b>\n\n` +
        `📄 نام: ${esc(safeName)}\n` +
        `📦 حجم: ${humanSize(file.file_size || buf.length)}\n` +
        `📊 مجموع فایل‌های تو: ${user.files.length} عدد\n\n` +
        `با /files می‌توانی لیست فایل‌هایت را ببینی و پس بگیری‌شان.`
    );

    // 🧠 حافظه تصویری: می‌بینم، توصیف می‌کنم و در خاطرات ذخیره می‌کنم
    if (kind === 'photo') {
      const desc = await seePhoto(chatId, user, buf);
      if (desc) {
        user.photo_memories = user.photo_memories || [];
        user.photo_memories.push({
          n: user.photo_memories.length + 1,
          desc,
          file_id: file.file_id,
          saved_at: new Date().toISOString(),
        });
        user.photo_memories = user.photo_memories.slice(-20);
        saveDB();
      }
    }
  } catch (e) {
    console.error('❌ خطا در ذخیره فایل:', e.message);
    await sendText(chatId, '😔 متأسفانه ذخیره این فایل با خطا مواجه شد. دوباره امتحان کن!');
  }
  return true;
}

function filesKeyboard(user) {
  const rows = user.files
    .map((f, i) => [{ text: `${fileIcon(f.kind)} ${f.name.slice(0, 28)} (${humanSize(f.size)})`, callback_data: `dl_${i}` }])
    .reverse();
  rows.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_main' }]);
  return { inline_keyboard: rows };
}

function fileIcon(kind) {
  return { document: '📄', photo: '🖼', video: '🎬', audio: '🎵', voice: '🎤' }[kind] || '📁';
}

async function resendFile(chatId, f) {
  const payload = { chat_id: chatId };
  switch (f.kind) {
    case 'photo': await tg('sendPhoto', { ...payload, photo: f.file_id, caption: `🖼 ${f.name}` }); break;
    case 'video': await tg('sendVideo', { ...payload, video: f.file_id, caption: `🎬 ${f.name}` }); break;
    case 'audio': await tg('sendAudio', { ...payload, audio: f.file_id, caption: `🎵 ${f.name}` }); break;
    case 'voice': await tg('sendVoice', { ...payload, voice: f.file_id, caption: `🎤 ${f.name}` }); break;
    default: await tg('sendDocument', { ...payload, document: f.file_id, caption: `📄 ${f.name}` });
  }
}

function statsText(user, chatId) {
  return (
    `📊 <b>آمار ${user.is_group ? `گروه «${esc(user.title || 'گروه')}»` : 'تو'}</b>\n\n` +
    (user.is_group
      ? `👤 آخرین نفری که با من حرف زد: ${esc(user.first_name)}\n`
      : `👤 نام: ${esc(user.first_name)}\n`) +
    (user.username ? `📧 یوزرنیم: @${esc(user.username)}\n` : '') +
    `🆔 آیدی عددی: <code>${chatId}</code>\n` +
    `📅 تاریخ عضویت: ${faDate(user.joined_at)}\n` +
    `💬 پیام‌های ارسالی: ${user.msg_count}\n` +
    `🎨 عکس‌های ساخته‌شده: ${user.img_count || 0}\n` +
    `📁 فایل‌های ذخیره‌شده: ${user.files.length}\n` +
    `🧠 حافظه مکالمه: ${user.history.length} پیام در حافظه است`
  );
}

// ══════════════════════════ ساخت عکس و حافظه (نسخه ۲) ══════════════════════════

/** پرامپت‌نویسی حرفه‌ای: توضیح فارسی کاربر ← پرامپت انگلیسی غنی (برای مدل قوی‌تر) */
async function enrichPrompt(prompt) {
  if (Date.now() < primaryDownUntil) return prompt; // گیت‌وای پایین — پرامپت خام
  try {
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: "You are an expert image-generation prompt engineer. Rewrite the user's image description (any language, usually Persian) as ONE vivid English image prompt: subject, style, lighting, composition, quality keywords. Max 60 words. Keep it safe-for-work and family friendly. Return ONLY the prompt text, no quotes, no explanation." },
        { role: 'user', content: prompt },
      ],
      thinking: { type: 'disabled' },
    });
    const out = cleanAI(completion.choices?.[0]?.message?.content);
    return out || prompt;
  } catch {
    return prompt;
  }
}

function isContentFilterError(e) {
  const m = String(e?.message || e);
  return m.includes('1301') || m.toLowerCase().includes('contentfilter');
}

/** ساخت عکس با زنجیره مدل‌ها: glm-image ← cogview-4 ← پیش‌فرض */
async function generateImageBuffer(prompt, models = IMG_MODELS) {
  let lastErr = null;
  for (const model of models) {
    try {
      const body = model ? { model, prompt, size: '1024x1024' } : { prompt, size: '1024x1024' };
      const res = await zai.images.generations.create(body);
      const b64 = res?.data?.[0]?.base64;
      if (b64) return { buf: Buffer.from(b64, 'base64'), model: model || 'پیش‌فرض' };
      lastErr = new Error('پاسخ بدون تصویر');
    } catch (e) {
      lastErr = e;
      console.error(`⚠️ مدل تصویرساز «${model || 'پیش‌فرض'}» ناموفق:`, e.message.slice(0, 140));
    }
  }
  throw lastErr || new Error('هیچ مدلی جواب نداد');
}

/** 🌐 ترجمه پرامپت فارسی به انگلیسی با مغز جایگزین (برای کیفیت بهتر تصویر Flux) */
async function translatePromptEn(prompt) {
  if (/^[\x00-\x7F\s\d]*$/.test(prompt)) return prompt; // قبلاً انگلیسی است
  try {
    // ترجمه: Gemini → Groq → Pollinations — اولی که جواب داد
    let out = '';
    if (GEMINI_KEY) {
      try {
        const res = await fetchT(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: `Translate this Persian image description into ONE vivid English image prompt. Output ONLY the prompt text, max 60 words, safe-for-work, no quotes:\n${prompt}` }] }],
              generationConfig: { temperature: 0.4, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
            }),
          },
          20000
        );
        if (res.ok) {
          const data = await res.json();
          out = cleanAI((data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
        }
      } catch { /* مغز بعدی */ }
    }
    if (!out && GROQ_KEY) {
      try {
        const res = await fetchT('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
              { role: 'system', content: 'Translate the user image description into ONE vivid English image prompt. Output ONLY the prompt text, max 60 words, safe-for-work, no quotes.' },
              { role: 'user', content: prompt },
            ],
            max_tokens: 200,
          }),
        }, 20000);
        if (res.ok) {
          const data = await res.json();
          out = cleanAI(data?.choices?.[0]?.message?.content);
        }
      } catch { /* مغز بعدی */ }
    }
    if (!out) {
      try {
        const res = await fetchT(POLL_TEXT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openai-fast',
            messages: [
              { role: 'system', content: 'Translate the user image description into ONE vivid English image prompt. Output ONLY the prompt text, max 60 words, safe-for-work, no quotes.' },
              { role: 'user', content: prompt },
            ],
          }),
        }, 25000);
        if (res.ok) {
          const data = await res.json();
          out = cleanAI(data?.choices?.[0]?.message?.content);
        }
      } catch { /* پرامپت خام بماند */ }
    }
    if (out) return out;
  } catch { /* پرامپت خام بماند */ }
  return prompt;
}

async function generateAndSendImage(chatId, user, prompt) {
  await sendText(chatId, `🎨 <b>دارم عکست را می‌سازم...</b>\n\n📝 ${esc(prompt)}\n\nکمی صبر کن ⏳`);
  let enhanced = prompt;
  let filterErr = false;
  // ۱) مسیر اصلی (گیت‌وای + مدل‌های GLM) — فقط اگر زنده باشد
  if (Date.now() >= primaryDownUntil) {
    try {
      await tg('sendChatAction', { chat_id: chatId, action: 'upload_photo' }).catch(() => {});
      // پرامپت حرفه‌ای: توضیح فارسی ← پرامپت انگلیسی غنی
      enhanced = await enrichPrompt(prompt);
      // زنجیره مدل‌های قوی
      let result;
      try {
        result = await generateImageBuffer(enhanced);
      } catch (e1) {
        // اگر فیلتر رد کرد، آخرین تلاش با متن خام کاربر
        if (isContentFilterError(e1) && enhanced !== prompt) {
          result = await generateImageBuffer(prompt, [IMG_MODELS[0]]);
        } else {
          throw e1;
        }
      }
      await tgUpload('sendPhoto', {
        chat_id: chatId,
        photo: result.buf,
        __filename: 'judy-art.png',
        caption: `🎨 <b>ساخته شد!</b> (مدل ${result.model})\n\n📝 ${esc(prompt)}`,
        reply_markup: JSON.stringify(imgMenu),
      });
      user.img_count = (user.img_count || 0) + 1;
      saveDB();
      console.log(`🖼 عکس با مدل ${result.model} برای ${user.first_name} ساخته شد`);
      return;
    } catch (e) {
      console.error('❌ خطا در ساخت عکس (اصلی):', String(e?.message || e));
      markPrimaryDown(e);
      filterErr = isContentFilterError(e);
    }
  }
  // ۲) 🌐 تصویرساز جایگزین رایگان (Pollinations / Flux)
  try {
    console.log('🌐 ساخت عکس با تصویرساز جایگزین (Pollinations)...');
    await tg('sendChatAction', { chat_id: chatId, action: 'upload_photo' }).catch(() => {});
    const finalPrompt = await translatePromptEn(enhanced || prompt);
    const buf = await pollinationsImageBuffer(finalPrompt);
    await tgUpload('sendPhoto', {
      chat_id: chatId,
      photo: buf,
      __filename: 'judy-art.jpg',
      caption: `🎨 <b>ساخته شد!</b> (مدل جایگزین Flux)\n\n📝 ${esc(prompt)}`,
      reply_markup: JSON.stringify(imgMenu),
    });
    user.img_count = (user.img_count || 0) + 1;
    saveDB();
  } catch (e2) {
    console.error('⚠️ تصویرساز جایگزین هم ناموفق:', e2.message);
    if (filterErr) {
      await sendText(
        chatId,
        `🚫 <b>فیلتر ایمنی تصویرساز این توضیح را رد کرد!</b>\n\n` +
        `خودم اشکالی در حرفت نمی‌بینم، ولی سیستم ایمنی حساسه! 😅\n\n` +
        `💡 <b>راه حل:</b> توضیح را کمی تغییر بده:\n` +
        `• کلمه‌های مشکوک یا حساس را حذف کن\n` +
        `• جای شخص‌های واقعی، کاراکتر خیالی بگذار\n` +
        `• کوتاه‌تر و ساده‌ترش کن\n\n` +
        `نمونه‌ای که حتماً جواب می‌دهد:\n` +
        `«یه ربات فضانورد که روی ماه اسکیت‌بازی می‌کند» 🚀`
      );
    } else {
      await sendText(chatId, `😔 متأسفانه ساخت عکس با خطا مواجه شد!\nاحتمالاً سرور شلوغ است. یک بار دیگر امتحان کن! 🙏`);
    }
  }
}

/** 👀 دیدن عکس با مغز Gemini (وقتی گیت‌وای اصلی پایین است) */
async function seePhotoFallback(chatId, user, dataUri) {
  try {
    if (!GEMINI_KEY) throw new Error('کلید Gemini تنظیم نشده');
    const b64 = dataUri.split(',')[1] || '';
    const res = await fetchT(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: 'این عکس را کاربر در تلگرام برای تو (جودی، یک دستیار دوستانه) فرستاده. اول در یک جمله کوتاه توصیفش کن، بعد یک واکنش دوستانه و جالب درباره‌اش بگو. فارسی صمیمی، حداکثر ۳ جمله.' },
              { inline_data: { mime_type: 'image/jpeg', data: b64 } },
            ],
          }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
      40000
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    const desc = cleanAI((data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
    if (!desc) throw new Error('پاسخ خالی');
    console.log('🧠 عکس با مغز Gemini دیده شد');
    user.history.push({ role: 'user', content: '[کاربر یک عکس فرستاد]' });
    user.history.push({ role: 'assistant', content: desc });
    if (user.history.length > MAX_HISTORY) user.history = user.history.slice(-MAX_HISTORY);
    await sendText(chatId, `👀 <b>دیدمش!</b>\n\n${fmt(desc)}`);
    return desc;
  } catch (e2) {
    console.error('⚠️ دیدن عکس (Gemini) ناموفق:', e2.message);
  }
  await sendText(chatId, `👀 <b>الان نمی‌توانم عکس را ببینم!</b>\nسرویس بینایی در دسترس نیست — ولی می‌توانی درباره‌اش برایم توضیح بدهی یا باهام حرف بزنی! 😊`);
  return null;
}

/** دیدن عکس با مدل بینایی + ثبت در حافظه */
async function seePhoto(chatId, user, photoBuffer) {
  const dataUri = `data:image/jpeg;base64,${photoBuffer.toString('base64')}`;
  if (Date.now() >= primaryDownUntil) {
    return seePhotoFallback(chatId, user, dataUri); // گیت‌وای پایین — مستقیم جایگزین
  }
  try {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const res = await zai.chat.completions.createVision({
      model: VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'این عکس را کاربر در تلگرام برای تو (جودی، یک دستیار دوستانه) فرستاده. اول در یک جمله کوتاه توصیفش کن، بعد یک واکنش دوستانه و جالب درباره‌اش بگو. فارسی صمیمی، حداکثر ۳ جمله.' },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
    });
    const desc = cleanAI(res?.choices?.[0]?.message?.content);
    if (!desc) return null;
    user.history.push({ role: 'user', content: '[کاربر یک عکس فرستاد]' });
    user.history.push({ role: 'assistant', content: desc });
    if (user.history.length > MAX_HISTORY) user.history = user.history.slice(-MAX_HISTORY);
    await sendText(chatId, `👀 <b>دیدمش!</b>\n\n${fmt(desc)}`);
    return desc;
  } catch (e) {
    console.error('⚠️ خطا در دیدن عکس (اصلی):', e.message);
    markPrimaryDown(e);
    return seePhotoFallback(chatId, user, dataUri);
  }
}

/** خروجی حافظه مکالمه به‌صورت فایل JSON — قابل دادن به هر ایجنت دیگر */
async function sendMemoryExport(chatId, user) {
  if (!user.history.length) {
    await sendText(chatId, `🧠 هنوز حافظه‌ای ندارم!\n\nاول باهام گفتگو کن، بعد /memory را بزن تا حافظه‌ام را به‌صورت فایل بهت بدهم.`);
    return;
  }
  const payload = {
    exported_at: new Date().toISOString(),
    bot: `جودی (Judy Telegram Bot) v${BOT_VERSION}`,
    owner: user.first_name,
    note: 'این فایل حافظه مکالمه بات جودی است. آن را به هر ایجنتی بدهید تا دقیقاً از همین نقطه ادامه دهد.',
    message_count: user.history.length,
    conversation: user.history,
    photo_memories: user.photo_memories || [],
  };
  const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  await tgUpload('sendDocument', {
    chat_id: chatId,
    document: buf,
    __filename: 'judy-memory.json',
    caption:
      `🧠 <b>حافظه من آماده‌ست!</b>\n\n` +
      `این فایل JSON شامل کل مکالمه‌های من است.\n` +
      `می‌توانی به هر ایجنت دیگری بدهی تا دقیقاً از همین‌جا ادامه بدهد! 🚀\n\n` +
      `💬 تعداد پیام‌های ذخیره‌شده: ${user.history.length}`,
  });
  console.log(`📜 حافظه برای ${user.first_name} صادر شد`);
}

/** حافظه تصویری: لیست عکس‌هایی که دیده‌ام + دکمه دیدن دوباره */
async function sendPhotoMemories(chatId, user) {
  const mem = user.photo_memories || [];
  if (!mem.length) {
    await sendText(chatId, `🧠 هنوز حافظه تصویری ندارم!\n\nیک عکس بفرست تا ببینمش، توصیفش کنم و برای همیشه به خاطر بسپارم! 📸`);
    return;
  }
  const list = mem.slice().reverse().map((m) => `🖼 <b>#${m.n}</b> — ${esc(m.desc.slice(0, 90))}`).join('\n');
  const rows = mem.map((m, i) => [{ text: `🖼 عکس #${m.n}`, callback_data: `pm_${i}` }]).reverse();
  rows.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_main' }]);
  await sendText(
    chatId,
    `🧠 <b>حافظه تصویری من (${mem.length} عکس):</b>\n\n${list}\n\nروی هر کدام بزن تا دوباره نشانش بدهم 👇`,
    { inline_keyboard: rows }
  );
}

/** ثبت درخواست آپدیت واقعی در صف Super Z — حالا برای همه کاربران */
function saveUpdateRequest(note, user, chatId, groupName = null) {
  const req = {
    at: new Date().toISOString(),
    from_chat_id: String(chatId),
    from_name: user.first_name,
    note,
  };
  if (groupName) req.from_group = groupName;
  try {
    const arr = JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
    arr.push(req);
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch {
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify([req], null, 2), 'utf8');
  }
  console.log(`📣📣📣 درخواست آپدیت جدید از ${req.from_name}: ${note}`);
}

// ══════════════════ 🔐 پنل ادمین — دیتابیس (فقط خود ویل) ══════════════════

const DB_PAGE_SIZE = 6;  // تعداد کاربر در هر صفحه‌ی منوی کشویی
const DB_MSG_CHUNK = 16; // تعداد پیام در پیش‌نمایش مکالمه‌ی هر کاربر

/** لیست کاربران — تازه‌ترین عضو اول */
function adminUserList() {
  return Object.entries(db.users)
    .sort((a, b) => new Date(b[1].joined_at || 0) - new Date(a[1].joined_at || 0));
}

/** 📋 دستور db — لیست متنی تمام کاربران با جزئیات */
async function adminListUsers(chatId) {
  const users = adminUserList();
  if (!users.length) {
    await sendText(chatId, `🗄 <b>دیتابیس جودی</b>\n\n📭 هنوز هیچ کاربری ثبت نشده است.`);
    return;
  }
  let totalMsgs = 0, totalFiles = 0;
  const lines = users.map(([cid, u], i) => {
    totalMsgs += u.msg_count || 0;
    totalFiles += u.files?.length || 0;
    const tag = u.is_group ? '👥 گروه' : '👤 کاربر';
    return (
      `${i + 1}. ${tag} — <b>${esc(u.title || u.first_name || 'بی‌نام')}</b>\n` +
      `   ├ یوزرنیم: ${u.username ? '@' + esc(u.username) : '—'}\n` +
      `   ├ آیدی: <code>${cid}</code>\n` +
      `   ├ پیام: ${u.msg_count || 0} | فایل: ${u.files?.length || 0} | حافظه: ${(u.history || []).length}\n` +
      `   └ عضویت: ${faDate(u.joined_at)}`
    );
  }).join('\n\n');
  await sendText(
    chatId,
    `🗄 <b>دیتابیس جودی</b> — نسخه ${BOT_VERSION}\n\n` +
    `👥 کل: <b>${users.length}</b> | 💬 پیام‌ها: <b>${totalMsgs}</b> | 📁 فایل‌ها: <b>${totalFiles}</b>\n\n` +
    lines
  );
}

/** 🎛 کیبورد کشویی کاربران (dball) */
function adminUsersKeyboard(page) {
  const users = adminUserList();
  const totalPages = Math.max(1, Math.ceil(users.length / DB_PAGE_SIZE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const rows = users.slice(page * DB_PAGE_SIZE, page * DB_PAGE_SIZE + DB_PAGE_SIZE)
    .map(([cid, u], i) => {
      const n = page * DB_PAGE_SIZE + i + 1;
      const name = (u.title || u.first_name || 'بی‌نام').slice(0, 18);
      const label = `${u.is_group ? '👥' : '👤'} ${n}. ${name} — ${u.msg_count || 0} پیام`;
      return [{ text: label, callback_data: `dbu_${cid}_${page}` }];
    });
  const nav = [];
  if (page > 0) nav.push({ text: '◀️ قبلی', callback_data: `dbp_${page - 1}` });
  nav.push({ text: `📄 ${page + 1} از ${totalPages}`, callback_data: 'dbno' });
  if (page < totalPages - 1) nav.push({ text: 'بعدی ▶️', callback_data: `dbp_${page + 1}` });
  if (nav.length) rows.push(nav);
  return { rows, total: users.length, page, totalPages };
}

/** 🎛 دستور dball — منوی کشویی کاربران (در همان پیام می‌لغزد!) */
async function adminUsersMenu(chatId, page = 0, msgId = null) {
  const { rows, total, page: p } = adminUsersKeyboard(page);
  if (!total) {
    await sendText(chatId, `🎛 <b>پنل کاربران</b>\n\n📭 هنوز هیچ کاربری ثبت نشده است.`);
    return;
  }
  const text =
    `🎛 <b>پنل کشویی کاربران — دیتابیس جودی</b>\n` +
    `👥 کل: <b>${total}</b> نفر\n\n` +
    `روی هر کاربر بزن تا مکالمه‌اش را ببینی 👇`;
  const markup = { inline_keyboard: rows };
  if (msgId) {
    try {
      await tg('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: markup });
      return;
    } catch { /* ادیت نشد → پیام جدید می‌فرستیم */ }
  }
  await sendText(chatId, text, markup);
}

/** 💬 نمایش مکالمه یک کاربر — داخل همان پیام کشویی */
async function adminShowUser(chatId, targetId, page, msgId = null) {
  const u = db.users[String(targetId)];
  if (!u) {
    await sendText(chatId, `🤔 این کاربر در دیتابیس پیدا نشد! دوباره dball را بزن.`);
    return;
  }
  const h = u.history || [];
  const header =
    `💬 <b>${u.is_group ? '👥 ' : ''}${esc(u.title || u.first_name || 'بی‌نام')}</b>` +
    `${u.username ? ` (@${esc(u.username)})` : ''}\n` +
    `🆔 <code>${targetId}</code> | عضویت: ${faDate(u.joined_at)}\n` +
    `📊 پیام‌ها: ${u.msg_count || 0} | 📁 فایل‌ها: ${u.files?.length || 0} | 🧠 حافظه: ${h.length} پیام\n` +
    `━━━━━━━━━━━━━━━━━━\n`;
  let body = '';
  let hidden = 0;
  if (h.length) {
    const entries = h.slice(-DB_MSG_CHUNK).map((m) =>
      m.role === 'user'
        ? `👤 <b>${esc((u.first_name || 'کاربر').slice(0, 20))}:</b> ${esc(String(m.content || '')).slice(0, 350)}`
        : `🤖 <b>جودی:</b> ${esc(String(m.content || '')).slice(0, 350)}`
    );
    for (let i = entries.length - 1; i >= 0; i--) {
      if (body.length + entries[i].length > 3400) { hidden = i + 1; break; }
      body = entries[i] + (body ? '\n\n' + body : '');
    }
    if (hidden > 0) body = `… ${hidden} پیام قدیمی‌تر حذف شد (برای دیدن کامل، دکمه پایین را بزن)\n\n` + body;
    else if (h.length > entries.length) body = `… ${h.length - entries.length} پیام قدیمی‌تر حذف شد\n\n` + body;
  } else {
    body = '📭 هنوز مکالمه‌ای در حافظه نیست.';
  }
  const rows = [];
  if (h.length) rows.push([{ text: `📜 مکالمه کامل (${h.length} پیام)`, callback_data: `dbf_${targetId}_${page}` }]);
  rows.push([{ text: '🔙 بازگشت به لیست', callback_data: `dbp_${page}` }]);
  const text = header + body;
  if (msgId) {
    try {
      await tg('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
      return;
    } catch { /* ادیت نشد → پیام جدید */ }
  }
  await sendText(chatId, text, { inline_keyboard: rows });
}

/** 📜 مکالمه کامل یک کاربر — پیام جداگانه (تکه‌تکه) */
async function adminShowUserFull(chatId, targetId, page) {
  const u = db.users[String(targetId)];
  if (!u) {
    await sendText(chatId, `🤔 این کاربر در دیتابیس پیدا نشد! دوباره dball را بزن.`);
    return;
  }
  const h = u.history || [];
  if (!h.length) {
    await sendText(chatId, `📭 مکالمه‌ای برای نمایش نیست.`);
    return;
  }
  const conv = h.map((m) =>
    m.role === 'user'
      ? `👤 <b>${esc((u.first_name || 'کاربر').slice(0, 20))}:</b> ${esc(String(m.content || ''))}`
      : `🤖 <b>جودی:</b> ${esc(String(m.content || ''))}`
  ).join('\n\n');
  await sendText(
    chatId,
    `📜 <b>مکالمه کامل ${esc(u.title || u.first_name || 'بی‌نام')}</b> — ${h.length} پیام ذخیره‌شده\n\n${conv}`,
    { inline_keyboard: [[{ text: '🔙 بازگشت به لیست', callback_data: `dbp_${page}` }]] }
  );
}

// ══════════════════════════ هندلر پیام‌ها ══════════════════════════

async function handleStart(chatId, from, user) {
  const isOwner = String(chatId) === OWNER_CHAT_ID;
  const displayName = isOwner ? 'ویل جان' : (from.first_name || 'دوست من');
  const caption =
    `👋 سلام ${esc(displayName)}${isOwner ? '' : ' عزیز'}!\n\n` +
    `من <b>«جودی»</b> هستم، دستیار هوش مصنوعی تلگرامت! 🤖✨\n\n` +
    (isOwner ? `👑 این بات ساخته‌ی خودت است! نسخه ${BOT_VERSION} با مدل تصویرساز قوی‌تر!\n\n` : '') +
    `🧠 باهات صحبت می‌کنم و <b>حافظه دارم</b> — مکالمه‌های قبلی یادم می‌ماند\n` +
    `🎨 می‌توانم عکس بسازم و 👀 عکس‌هات را ببینم و به خاطر بسپارم\n` +
    `📁 فایل‌هایت را برایت نگه می‌دارم\n` +
    `📊 آمارت را نشان می‌دهم\n\n` +
    `برای شروع، همین‌طوری هر چی تو ذهنت است برام بنویس! ✍️\n` +
    `یا از منوی زیر انتخاب کن 👇`;

  try {
    if (fs.existsSync(WELCOME_IMG)) {
      await tgUpload('sendPhoto', {
        chat_id: chatId,
        photo: fs.readFileSync(WELCOME_IMG),
        caption,
        parse_mode: 'HTML',
        reply_markup: JSON.stringify(mainMenu),
      });
    } else {
      await sendText(chatId, caption, mainMenu);
    }
  } catch (e) {
    console.error('⚠️ ارسال عکس خوش‌آمد ناموفق بود، متن ساده ارسال می‌شود:', e.message);
    await sendText(chatId, caption, mainMenu);
  }

  // پیام تست فقط برای اولین شروع هر کاربر
  if (!user.tested) {
    user.tested = true;
    saveDB();
    await sendText(
      chatId,
      `🔔 <b>پیام تست!</b>\n\nاتصال بات جودی با موفقیت برقرار شد ✅\nهمه چیز آماده است! 🚀`
    );
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const chatType = msg.chat?.type;
  if (!chatId) return;
  if (!['private', 'group', 'supergroup'].includes(chatType)) return;
  const isGroup = chatType !== 'private';

  // 👋 اگر جودی تازه به گروه اضافه شده — فقط اگر ویل اضافه کرده باشد می‌ماند
  if (msg.new_chat_members) {
    if (msg.new_chat_members.some((m) => m.id === BOT_ID)) {
      const ok = await enforceOwnerOnlyGroup(msg.chat, msg.from);
      if (ok) await welcomeToGroup(msg.chat);
    }
    return;
  }
  if (msg.group_chat_created || msg.supergroup_chat_created) {
    if (isGroup) {
      const ok = await enforceOwnerOnlyGroup(msg.chat, msg.from);
      if (ok) await welcomeToGroup(msg.chat);
    }
    return;
  }

  const from = msg.from || {};
  if (from.is_bot) return; // پیام بات‌های دیگر را نادیده بگیر
  const user = getUser(chatId, from, msg.chat);

  // 👥 در گروه فقط وقتی جواب می‌دهیم که منشن/ریپلای/نام جودی/دستور باشد (یا شانس کوچک خودسرانه)
  const rawText = msg.text || msg.caption || '';
  let text = rawText;
  if (isGroup) {
    const mentioned = !!BOT_USERNAME && rawText.includes(`@${BOT_USERNAME}`);
    const namedJudy = rawText.includes('جودی');
    const repliedToBot = msg.reply_to_message?.from?.id === BOT_ID;
    const isCmd = rawText.startsWith('/');
    if (!mentioned && !namedJudy && !repliedToBot && !isCmd) {
      if (Math.random() >= GROUP_RANDOM_CHANCE) return; // بیشتر وقت‌ها ساکت
    }
    if (mentioned) text = rawText.split(`@${BOT_USERNAME}`).join('').trim();
  }

  // دستورات
  if (msg.text && msg.text.startsWith('/')) {
    const cmd = msg.text.split(/\s+/)[0].split('@')[0].toLowerCase();
    switch (cmd) {
      case '/start':
        user.msg_count++;
        if (isGroup) {
          await sendText(chatId, `👋 سلام! من «جودی» هستم و همین‌جا به‌تون کمک می‌کنم! 🤖\n\nمنشنم کنید (<code>@${BOT_USERNAME}</code>)، ریپلای بزنید یا اسمم رو صدا بزنید تا جواب بدم! ✨\n\nراهنمای کامل: /help`);
        } else {
          await handleStart(chatId, from, user);
        }
        saveDB();
        return;
      case '/help':
        user.msg_count++;
        await sendText(chatId, TEXT_HELP);
        return;
      case '/about':
        user.msg_count++;
        await sendText(chatId, TEXT_ABOUT, mainMenu);
        return;
      case '/stats':
        user.msg_count++;
        await sendText(chatId, statsText(user, chatId));
        return;
      case '/files': {
        user.msg_count++;
        if (!user.files.length) {
          await sendText(chatId, `هنوز هیچ فایلی ذخیره نکرده‌ای! 📭\n\nهر فایلی (عکس، ویدیو، سند، صدا) بفرستی، برات نگهش می‌دارم.`);
        } else {
          await sendText(
            chatId,
            `📁 <b>فایل‌های ذخیره‌شده‌ات (${user.files.length} عدد):</b>\n\nروی هر فایل بزن تا دوباره برات بفرستمش 👇`,
            filesKeyboard(user)
          );
        }
        return;
      }
      case '/reset':
        user.msg_count++;
        user.history = [];
        saveDB();
        await sendText(chatId, `🧠 حافظه‌ام پاک شد! از این به بعد مکالمه‌های قبلی را یادم نمی‌آید.\nبریم یک شروع تازه! ✨`);
        return;
      case '/id':
        await sendText(chatId, `🆔 آیدی عددی تو: <code>${chatId}</code>`);
        return;
      case '/img': {
        user.msg_count++;
        const prompt = msg.text.replace(/^\/img(@\S+)?\s*/i, '').trim(); // با /img@BotName هم کار می‌کند
        if (!prompt) {
          user.awaiting = 'img';
          saveDB();
          await sendText(chatId, `🎨 <b>چه عکسی برات بسازم؟</b>\n\nتوضیحش را بنویس و بفرست — مثلاً:\n«یه ربات فضانورد که روی ماه اسکیت‌بازی می‌کند» 🚀`);
        } else {
          await generateAndSendImage(chatId, user, prompt);
        }
        return;
      }
      case '/memory':
        user.msg_count++;
        await sendMemoryExport(chatId, user);
        return;
      case '/photos':
        user.msg_count++;
        await sendPhotoMemories(chatId, user);
        return;
      case '/update': {
        user.msg_count++;
        user.awaiting = 'update';
        saveDB();
        await sendText(
          chatId,
          `🚀 <b>درخواست آپدیت</b>\n\n` +
          `${esc(from.first_name)} عزیز، چه آپدیتی می‌خواهی؟ توضیحش را بنویس — همین متن در صف آپدیت Super Z قرار می‌گیرد و سازنده‌ی من واقعاً پیاده‌سازی‌اش می‌کند.\n\n` +
          `مثلاً:\n«جستجوی اینترنت اضافه کن» 🔍\n«بازی بساز» 🎮` +
          (isGroup ? `\n\n📌 توجه: پیام بعدی که در گروه بفرستی، همان درخواستت می‌شود!` : '')
        );
        return;
      }
      case '/publish':
        user.msg_count++;
        await sendText(chatId, TEXT_PUBLISH_ASK, publishMenu);
        return;
      default:
        await sendText(chatId, `دستور ناشناخته است! 🤔 برای دیدن راهنما /help را بزن.`);
        return;
    }
  }

  // 🔐 دستورهای مخفی سازنده — فقط خود ویل در چت خصوصی (db و dball)
  if (!isGroup && String(chatId) === OWNER_CHAT_ID && msg.text && !user.awaiting) {
    const t = msg.text.trim();
    if (/^\/?db$/i.test(t)) {
      user.msg_count++;
      saveDB();
      await adminListUsers(chatId);
      return;
    }
    if (/^\/?dball$/i.test(t)) {
      user.msg_count++;
      saveDB();
      await adminUsersMenu(chatId, 0);
      return;
    }
  }

  // دریافت فایل
  if (await handleFile(msg, chatId, from)) return;

  // 🚀 درخواست آپدیت — حالا برای همه کاربران!
  if (text && text.trim() && user.awaiting === 'update') {
    user.awaiting = null;
    user.msg_count++;
    const note = text.trim();
    saveUpdateRequest(note, user, chatId, isGroup ? msg.chat.title : null);
    await sendText(
      chatId,
      `✅ <b>درخواست آپدیت ثبت شد، ${esc(from.first_name)}!</b>\n\n` +
      `📝 «${esc(note.slice(0, 200))}»\n\n` +
      `این درخواست الان در صف Super Z است و سازنده‌ی من واقعاً پیاده‌سازی‌اش می‌کند. 🚀`
    );
    return;
  }

  // 🎨 اگر منتظر توضیح عکس هستیم، این پیام همان توضیح است
  if (text && text.trim() && user.awaiting === 'img') {
    user.awaiting = null;
    user.msg_count++;
    await generateAndSendImage(chatId, user, text.trim());
    return;
  }

  // چت با هوش مصنوعی
  if (text && text.trim()) {
    user.msg_count++;
    saveDB();
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    let chatText = text.trim();
    if (isGroup) {
      // اگر به پیام یکی ریپلای زده، متن آن پیام را هم به‌عنوان زمینه بده
      const r = msg.reply_to_message;
      if (r && !r.from?.is_bot) {
        const rt = r.text || r.caption || '';
        if (rt) chatText = `[در پاسخ به پیام «${rt.slice(0, 300)}» از «${r.from?.first_name || 'کسی'}»]\n${chatText}`;
      }
    }

    const reply = await askJudy(user, chatText, chatId, from);
    saveDB();
    if (reply) await sendText(chatId, isGroup ? `👤 ${esc(from.first_name)}\n${fmt(reply)}` : fmt(reply));
    else await sendText(chatId, `😔 متأسفانه الان هیچ‌کدام از مغزهای من در دسترس نیست!\nسرویس‌های رایگان شلوغند — چند لحظه بعد دوباره امتحان کن 🙏`);
  }
}

// ══════════════════════════ هندلر دکمه‌های شیشه‌ای ══════════════════════════

async function handleCallback(q) {
  const chatId = q.message?.chat?.id;
  if (!chatId) return;
  const user = getUser(chatId, q.from || {}, q.message?.chat);
  const data = q.data;

  await tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});

  switch (data) {
    case 'chat_info':
      await sendText(chatId, `کافیه همین‌طوری هر چی دوست داری برام بنویسی! ✍️\n\nمثلاً:\n• «یه جک بگو» 😄\n• «ریاضیم رو کمک کن» 📐\n• «برنامه‌نویسی رو از کجا شروع کنم؟» 💻\n\n🎨 می‌خوای عکس بسازم؟ /img\n👀 می‌خوای عکستهات رو ببینم؟ همین‌طوری عکس بفرست!`);
      break;
    case 'make_img':
      user.awaiting = 'img';
      saveDB();
      await sendText(chatId, `🎨 <b>چه عکسی برات بسازم؟</b>\n\nتوضیحش را بنویس و بفرست — مثلاً:\n«یه ربات فضانورد که روی ماه اسکیت‌بازی می‌کند» 🚀`);
      break;
    case 'my_memory':
      await sendMemoryExport(chatId, user);
      break;
    case 'my_photos':
      await sendPhotoMemories(chatId, user);
      break;
    case 'req_update':
      user.awaiting = 'update';
      saveDB();
      await sendText(chatId, `🚀 <b>درخواست آپدیت</b>\n\nچه آپدیتی می‌خواهی؟ توضیحش را بنویس — همین متن در صف آپدیت Super Z قرار می‌گیرد و سازنده‌ی من واقعاً پیاده‌سازی‌اش می‌کند.`);
      break;
    case 'my_stats':
      await sendText(chatId, statsText(user, chatId));
      break;
    case 'my_files':
      if (!user.files.length) {
        await sendText(chatId, `هنوز هیچ فایلی ذخیره نکرده‌ای! 📭\n\nهر فایلی (عکس، ویدیو، سند، صدا) بفرستی، برات نگهش می‌دارم.`);
      } else {
        await sendText(chatId, `📁 <b>فایل‌های ذخیره‌شده‌ات (${user.files.length} عدد):</b>\n\nروی هر فایل بزن تا دوباره برات بفرستمش 👇`, filesKeyboard(user));
      }
      break;
    case 'about':
      await sendText(chatId, TEXT_ABOUT, mainMenu);
      break;
    case 'reset_mem':
      user.history = [];
      saveDB();
      await sendText(chatId, `🧠 حافظه‌ام پاک شد! از این به بعد مکالمه‌های قبلی را یادم نمی‌آید.\nبریم یک شروع تازه! ✨`);
      break;
    case 'publish':
      await sendText(chatId, TEXT_PUBLISH_ASK, publishMenu);
      break;
    case 'pub_yes':
      await sendText(chatId, TEXT_PUBLISH_YES);
      break;
    case 'pub_no':
      await sendText(chatId, TEXT_PUBLISH_NO);
      break;
    case 'back_main':
      await sendText(chatId, `🔙 منوی اصلی 👇`, mainMenu);
      break;
    default:
      // 🔐 دکمه‌های پنل ادمین — فقط خود ویل
      if (data === 'dbno') {
        /* فقط شمارنده صفحه — کاری لازم نیست */
      } else if (data.startsWith('dbp_')) {
        if (String(q.from?.id) !== OWNER_CHAT_ID) return;
        await adminUsersMenu(chatId, parseInt(data.slice(4), 10) || 0, q.message?.message_id);
      } else if (data.startsWith('dbu_')) {
        if (String(q.from?.id) !== OWNER_CHAT_ID) return;
        const parts = data.split('_'); // dbu_<chatId>_<page>
        await adminShowUser(chatId, parts[1], parseInt(parts[2], 10) || 0, q.message?.message_id);
      } else if (data.startsWith('dbf_')) {
        if (String(q.from?.id) !== OWNER_CHAT_ID) return;
        const parts = data.split('_'); // dbf_<chatId>_<page>
        await adminShowUserFull(chatId, parts[1], parseInt(parts[2], 10) || 0);
      } else if (data.startsWith('pm_')) {
        const idx = parseInt(data.slice(3), 10);
        const m = user.photo_memories?.[idx];
        if (m) {
          await tg('sendPhoto', {
            chat_id: chatId,
            photo: m.file_id,
            caption: `🧠 حافظه تصویری #${m.n}\n\n${esc(m.desc.slice(0, 800))}`,
          });
        } else {
          await sendText(chatId, `این خاطره پیدا نشد! 🤔 دوباره /photos را بزن.`);
        }
      } else if (data.startsWith('dl_')) {
        const idx = parseInt(data.slice(3), 10);
        const f = user.files[idx];
        if (f) await resendFile(chatId, f);
        else await sendText(chatId, `این فایل پیدا نشد! 🤔 شاید لیست قدیمی است، دوباره /files را بزن.`);
      }
  }
}

// ══════════════════════════ حلقه اصلی (Long Polling) ══════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleUpdate(update) {
  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.my_chat_member) await handleMyChatMember(update.my_chat_member);
  } catch (e) {
    console.error('❌ خطا در پردازش آپدیت:', e.message);
  }
}

async function poll() {
  console.log('🔄 در حال گوش دادن به پیام‌ها...');
  while (true) {
    try {
      const updates = await tg('getUpdates', {
        offset: db.offset || 0,
        timeout: 30,
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      });
      for (const u of updates) {
        db.offset = u.update_id + 1;
        await handleUpdate(u); // ترتیب پیام‌ها حفظ می‌شود
        saveDB();
      }
    } catch (e) {
      console.error('⚠️ خطا در polling:', e.message);
      await sleep(3000);
    }
  }
}

async function main() {
  // 🔑 اگر کلید هوش مصنوعی به‌صورت Secret محیطی باشد (HF/Render)، خودم فایل کانفیگ را می‌سازم
  if (process.env.ZAI_CONFIG && !fs.existsSync('.z-ai-config')) {
    try {
      fs.writeFileSync(path.join(process.cwd(), '.z-ai-config'), process.env.ZAI_CONFIG);
      console.log('🔑 کانفیگ هوش مصنوعی از Secret ساخته شد');
    } catch (e) { console.error('⚠️ ساخت کانفیگ AI ناموفق:', e.message); }
  }
  loadDB();
  await dbCloudLoad(); // ☁️ بازیابی حافظه از گیت‌هاب (برای هاست‌هایی که دیسکشان پاک می‌شود)
  zai = await ZAI.create();
  const me = await tg('getMe');
  BOT_USERNAME = me.username;
  BOT_ID = me.id;
  console.log('══════════════════════════════════');
  console.log(`🤖 بات جودی آنلاین شد!  @${me.username}`);
  console.log('══════════════════════════════════');
  startKeepaliveServer();
  await poll();
}

/** 🌐 وب‌سرور Keepalive — برای هاست‌های رایگان مثل Render که ترافیک HTTP می‌خواهند */
function startKeepaliveServer() {
  const PORT = process.env.PORT || process.env.KEEPALIVE_PORT; // خود Render پورت می‌دهد
  if (!PORT) return; // لوکال لازم نیست
  try {
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`🤖 Judy bot v${BOT_VERSION} is alive!`);
    }).listen(Number(PORT), () => console.log(`🌐 وب‌سرور Keepalive روی پورت ${PORT} روشن شد`));
    startSelfPing();
  } catch (e) {
    console.error('⚠️ وب‌سرور Keepalive روشن نشد:', e.message);
  }
}

/** 🔄 Self-ping — هر ۵ دقیقه خودش را صدا می‌زند تا Render رایگان نخوابد */
function startSelfPing() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return; // فقط روی Render
  setInterval(() => {
    fetch(url).then((r) => console.log(`🔄 self-ping: ${r.status}`)).catch(() => {});
  }, 5 * 60 * 1000).unref?.();
  console.log('🔄 Self-ping هر ۵ دقیقه روشن شد تا سرویس بیدار بماند');
}

process.on('unhandledRejection', (e) => console.error('⚠️ unhandledRejection:', e?.message));
process.on('uncaughtException', (e) => console.error('⚠️ uncaughtException:', e?.message));

/** 🚪 خاموشی تمیز — آخرین حافظه را قبل از رفتن در ابر ذخیره کن */
async function gracefulShutdown() {
  console.log('🚪 خاموشی — ذخیره نهایی حافظه در ابر...');
  try { await flushCloud(); } catch { /* تلاش نهایی انجام شد */ }
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown); // Render موقع خواب/دیپلوی SIGTERM می‌فرستد
process.on('SIGINT', gracefulShutdown);

main().catch((e) => {
  console.error('❌ بات متوقف شد:', e);
  process.exit(1);
});

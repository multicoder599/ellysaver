require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

/* ==================== CONFIG ==================== */
const CONFIG = {
  apiId: parseInt(process.env.API_ID),
  apiHash: process.env.API_HASH,
  sessionString: process.env.SESSION_STRING || '',
  targetChannel: process.env.TARGET_CHANNEL,
  watermarkText: process.env.WATERMARK_TEXT || 'Watermark',
  watermarkFontPath: process.env.WATERMARK_FONT_PATH || '',
  port: parseInt(process.env.PORT) || 3015,
  // Increased fallback defaults to protect your Telegram account from bans
  pollInterval: parseInt(process.env.POLL_INTERVAL) || 300000, // Default to 5 minutes if not set
  sourceChannels: process.env.SOURCE_CHANNELS
    ? process.env.SOURCE_CHANNELS.split(',').map((s) => s.trim().replace('@', '').toLowerCase())
    : [],
  dirs: {
    downloads: path.join(__dirname, 'downloads'),
    temp: path.join(__dirname, 'temp'),
  },
};

/* ==================== UTILS ==================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDirs() {
  for (const dir of Object.values(CONFIG.dirs)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function checkFfmpeg() {
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      proc.on('close', (code) => (code === 0 ? resolve() : reject()));
      proc.on('error', reject);
    });
    console.log('✅ FFmpeg detected');
  } catch {
    console.error('❌ FFmpeg not found.');
    process.exit(1);
  }
}

async function getFontPath() {
  if (CONFIG.watermarkFontPath) {
    try {
      await fs.access(CONFIG.watermarkFontPath);
      return CONFIG.watermarkFontPath;
    } catch {
      console.warn(`⚠️ Font not found at ${CONFIG.watermarkFontPath}, trying defaults...`);
    }
  }
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
  ];
  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch {}
  }
  throw new Error('No font found. Run: sudo apt install fonts-dejavu-core');
}

/* ==================== WATERMARK ==================== */
async function addWatermark(inputPath, outputPath) {
  const originalFont = await getFontPath();
  const tempFont = path.join(CONFIG.dirs.temp, 'watermark_font.ttf');
  await fs.copyFile(originalFont, tempFont);

  const text = CONFIG.watermarkText;
  const safeText = text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');

  const safeFontPath = path.relative(process.cwd(), tempFont).replace(/\\/g, '/');

  const filter =
    `drawtext=text='${safeText}':` +
    `fontfile='${safeFontPath}':` +
    `fontsize=24:` +
    `fontcolor=white:` +
    `borderw=2:` +
    `bordercolor=black:` +
    `x=(w-tw)/2:` +
    `y=(h-th)/2`;

  const args = [
    '-i', inputPath,
    '-vf', filter,
    '-c:a', 'copy',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', outputPath,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}\n${stderr}`));
    });
    proc.on('error', (err) => reject(err));
  });
}

/* ==================== QUEUE ==================== */
const queue = [];
let busy = false;

async function runQueue(client) {
  if (busy || queue.length === 0) return;
  busy = true;
  const queueSize = queue.length;
  if (queueSize > 0) console.log(`\n⏳ [Queue: ${queueSize} waiting]`);

  const { message } = queue.shift();
  try {
    await processVideo(client, message);
  } catch (err) {
    console.error('❌ Job failed:', err.message);
  }
  busy = false;
  runQueue(client);
}

/* ==================== VIDEO HANDLER ==================== */
function truncateCaption(text, max = 1024) {
  if (!text) return '';
  return text.length > max ? text.substring(0, max - 3) + '...' : text;
}

async function processVideo(client, message) {
  const chat = await client.getEntity(message.peerId);
  const chatTitle = chat.title || 'Channel';
  const chatUser = chat.username ? `@${chat.username}` : '';

  console.log(`\n🎬 Video from: ${chatTitle} ${chatUser}`);

  const ts = Date.now();
  const msgId = message.id;
  const ext = message.video ? '.mp4' : path.extname(message.document?.fileName || '.mp4');
  const safeExt = ext.match(/^\.\w+$/) ? ext : '.mp4';
  const base = `vid_${msgId}_${ts}`;

  const origPath = path.join(CONFIG.dirs.downloads, `${base}_orig${safeExt}`);
  const wmPath = path.join(CONFIG.dirs.temp, `${base}_wm${safeExt}`);

  try {
    console.log('⬇️ Downloading...');
    const buffer = await client.downloadMedia(message.media, {
      progressCallback: (got, total) => {
        if (total) process.stdout.write(`\r   ${((got / total) * 100).toFixed(0)}%`);
      },
    });
    await fs.writeFile(origPath, buffer);
    console.log('\n   Downloaded');

    console.log(`🎨 Watermarking with "${CONFIG.watermarkText}"...`);
    await addWatermark(origPath, wmPath);
    console.log('   Done');

    console.log('📤 Sending to target...');
    const rawCaption = message.text || message.caption || `📹 ${chatTitle}`;
    const caption = truncateCaption(rawCaption);
    await client.sendFile(CONFIG.targetChannel, {
      file: wmPath,
      caption,
      forceDocument: false,
    });
    console.log('   Sent!');

  } finally {
    await fs.unlink(origPath).catch(() => {});
    await fs.unlink(wmPath).catch(() => {});
  }
}

/* ==================== POLLING ==================== */
const processedIds = new Set();
const PROCESSED_FILE = path.join(__dirname, 'processed.json');
let cachedChannels = [];

async function loadProcessed() {
  try {
    const data = await fs.readFile(PROCESSED_FILE, 'utf8');
    JSON.parse(data).forEach(id => processedIds.add(id));
    console.log(`🗂️ Loaded ${processedIds.size} previously processed IDs`);
  } catch {
    console.log('🗂️ No processed history, starting fresh');
  }
}

async function saveProcessed() {
  await fs.writeFile(PROCESSED_FILE, JSON.stringify([...processedIds]));
}

function getTargetId() {
  return CONFIG.targetChannel.toLowerCase().replace('@', '');
}

async function isTargetChannel(chat) {
  const target = getTargetId();
  const uname = (chat.username || '').toLowerCase().replace('@', '');
  const cid = chat.id?.toString() || '';
  const shortId = cid.replace(/^-100/, '');
  return uname === target || cid === target || shortId === target;
}

async function buildChannelCache(client) {
  console.log('📚 Building channel cache (one-time)...');
  try {
    // Gracefully handle potential flood waits on startup
    const dialogs = await client.getDialogs({ limit: 100 });
    cachedChannels = [];

    for (const dialog of dialogs) {
      if (!dialog.isChannel && !dialog.isGroup) continue;

      const chat = dialog.entity;
      if (await isTargetChannel(chat)) continue;

      const uname = (chat.username || '').toLowerCase();
      const cid = chat.id?.toString() || '';
      const shortId = cid.replace(/^-100/, '');

      if (CONFIG.sourceChannels.length > 0) {
        const match = CONFIG.sourceChannels.some(
          (s) => uname === s || cid === s || shortId === s
        );
        if (!match) continue;
      }

      cachedChannels.push(chat);
    }

    console.log(`✅ Cached ${cachedChannels.length} source channel(s)`);
  } catch (err) {
    console.error('⚠️ Channel cache failed:', err.message);
    cachedChannels = [];
  }
}

async function pollChannels(client) {
  if (cachedChannels.length === 0) return;

  const now = Date.now() / 1000;

  for (const chat of cachedChannels) {
    try {
      // Limit to 2 messages for fallback check instead of 5 to minimize overhead
      const messages = await client.getMessages(chat, { limit: 2 });
      
      // Increased safety buffer to 2500ms between distinct channel history requests
      await sleep(2500); 

      for (const msg of messages) {
        if (processedIds.has(msg.id)) continue;
        if (now - msg.date > 300) {
          processedIds.add(msg.id);
          continue;
        }

        const isVideo = !!msg.video || (msg.document && msg.document?.mimeType?.startsWith('video/'));
        if (!isVideo) {
          processedIds.add(msg.id);
          continue;
        }

        const chatName = chat.title || chat.username || 'Unknown';
        console.log(`[POLL] Found missed video #${msg.id} in ${chatName}`);
        processedIds.add(msg.id);
        await saveProcessed();
        queue.push({ message: msg });
        runQueue(client);
      }
    } catch (err) {
      // If we encounter a flood wait during polling, back off gracefully
      if (err.message?.includes('FLOOD_WAIT')) {
        const waitTime = parseInt(err.message.match(/\d+/)?.[0] || '30');
        console.warn(`[POLL] Rate limited. Pausing fallback loop for ${waitTime}s...`);
        await sleep(waitTime * 1000);
      }
    }
  }
}

/* ==================== MAIN ==================== */
(async () => {
  await ensureDirs();
  await checkFfmpeg();
  await loadProcessed();

  if (!CONFIG.apiId || !CONFIG.apiHash || !CONFIG.sessionString || !CONFIG.targetChannel) {
    console.error('❌ Critical environment variables missing');
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(CONFIG.sessionString),
    CONFIG.apiId,
    CONFIG.apiHash,
    { connectionRetries: 5 }
  );

  await client.start({ phoneNumber: async () => {} });
  console.log('🔐 Userbot connected');

  await buildChannelCache(client);

  console.log(`🎯 Target: ${CONFIG.targetChannel}`);
  console.log(`📝 Watermark: "${CONFIG.watermarkText}"`);
  console.log(`📋 Sources: ${CONFIG.sourceChannels.length ? CONFIG.sourceChannels.join(', ') : 'ALL channels/groups'}`);
  console.log('📡 Listening for real-time events...\n');

  /* ---- EVENT HANDLER (primary detection) ---- */
  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg || msg.out) return;

    const isVideo = !!msg.video || (msg.document && msg.document?.mimeType?.startsWith('video/'));
    if (!isVideo) return;

    const peerType = msg.peerId?.className;
    if (peerType !== 'PeerChannel' && peerType !== 'PeerChat') return;
    if (processedIds.has(msg.id)) return;

    try {
      const chat = await client.getEntity(msg.peerId);
      if (await isTargetChannel(chat)) return;
    } catch { return; }

    console.log(`[EVENT] Real-time video #${msg.id}`);
    processedIds.add(msg.id);
    await saveProcessed();
    queue.push({ message: msg });
    runQueue(client);
  }, new NewMessage({}));

  /* ---- POLLING (Slow safety net fallback) ---- */
  console.log(`⏰ Polling fallback active every ${CONFIG.pollInterval / 1000}s...`);
  
  // Removed the immediate run on startup to let the initial event handlers set up smoothly
  setInterval(() => pollChannels(client), CONFIG.pollInterval);
})();

/* ---- ADMIN SERVER ---- */
const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'Online',
      queueSize: queue.length,
      isProcessing: busy,
      processedCount: processedIds.size,
      sources: CONFIG.sourceChannels.length > 0 ? CONFIG.sourceChannels : 'ALL'
    }, null, 2));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(CONFIG.port, () => {
  console.log(`🌐 Admin: curl http://localhost:${CONFIG.port}/status`);
}).on('error', (err) => {
  console.error(`⚠️ Admin server failed on port ${CONFIG.port}: ${err.message}`);
});
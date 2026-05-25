const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');

const serverHost = process.env.SERVER_HOST || 'COZYGGSMP.aternos.me';
const serverPort = parseInt(process.env.SERVER_PORT || '56155', 10);
const botUsername = process.env.BOT_USERNAME || 'COZY_Farmer';
const botPassword = process.env.BOT_PASSWORD || '';          // for AuthMe: /register & /login
const serverVersion = process.env.SERVER_VERSION || false;   // e.g. '1.21.4' — leave blank to auto-detect
const reconnectInterval = parseInt(process.env.RECONNECT_INTERVAL_MS || '15000', 10);
const antiAfkInterval = parseInt(process.env.ANTI_AFK_INTERVAL_MS || '8000', 10);
const httpPort = parseInt(process.env.PORT || '3000', 10);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'main.html')));
app.get('/health', (req, res) => res.status(200).json({
  status: 'ok',
  botRunning: bot !== null,
  botUsername: bot && bot.player ? bot.username : null,
  target: `${serverHost}:${serverPort}`,
}));

let bot = null;
let antiAfkTimer = null;
let reconnectTimer = null;
let manualStop = false;

io.on('connection', (socket) => {
  console.log('Web client connected.');
  if (bot && bot.player)   socket.emit('bot_status', `Bot ${bot.username} is online.`);
  else if (bot)            socket.emit('bot_status', 'Bot is connecting...');
  else                     socket.emit('bot_status', 'Bot is offline.');

  socket.on('control_bot', (command) => {
    switch (command) {
      case 'start':
        manualStop = false;
        if (!bot) createBot(); else io.emit('bot_status', 'Bot is already running.');
        break;
      case 'stop':
        manualStop = true;
        stopBot('Stopped by user.');
        break;
      case 'reconnect':
        manualStop = false;
        reconnectBot();
        break;
      default:
        console.log(`Unknown command: ${command}`);
    }
  });
});

server.listen(httpPort, () => {
  console.log(`HTTP server listening on port ${httpPort}.`);
  createBot();
});

function createBot() {
  clearReconnectTimer();
  if (bot) { console.log('Bot instance already exists; skipping create.'); return; }

  console.log(`Connecting bot "${botUsername}" to ${serverHost}:${serverPort} ...`);
  io.emit('bot_status', `Connecting to ${serverHost}:${serverPort}...`);

  let newBot;
  try {
    newBot = mineflayer.createBot({
      host: serverHost,
      port: serverPort,
      username: botUsername,
      // Set SERVER_VERSION env var on Render if auto-detect fails.
      // e.g. '1.21.4' to match whatever ViaVersion advertises.
      version: serverVersion,
      auth: 'offline',
      hideErrors: true,  // FIX 2: true prevents crashes from stray packets
                         // while still logging them via the 'error' event
      // FIX 3: Give the connection more time before timing out on Aternos
      // (Aternos servers spin up slowly and may stall the handshake)
      connectTimeout: 30000,
    });
  } catch (err) {
    console.error('Failed to create bot:', err.message);
    io.emit('bot_status', `Failed to create bot: ${err.message}`);
    scheduleReconnect();
    return;
  }

  bot = newBot;

  // ── FIX 4: Resource pack — always accept immediately ──────────────────────
  // Support both old and new mineflayer event names across versions.
  const acceptPack = (url) => {
    console.log(`[ResourcePack] Accepting pack: ${url}`);
    try { bot.acceptResourcePack(true); } catch (e) {
      console.warn('[ResourcePack] acceptResourcePack error (non-fatal):', e.message);
    }
  };
  bot.on('resource_pack_send', acceptPack);
  bot.on('resourcePack', acceptPack); // newer mineflayer versions use this name

  // ── AuthMe / login plugin handler ─────────────────────────────────────────
  // If the server uses AuthMe or similar, the bot must respond to login prompts.
  // Set BOT_PASSWORD env var on Render to enable this.
  bot.on('message', (jsonMsg) => {
    if (!botPassword) return;
    const text = jsonMsg.toString().toLowerCase();
    if (text.includes('register') || text.includes('/register')) {
      console.log('[Auth] Server asked to register. Sending /register...');
      bot.chat(`/register ${botPassword} ${botPassword}`);
    } else if (text.includes('login') || text.includes('/login')) {
      console.log('[Auth] Server asked to login. Sending /login...');
      bot.chat(`/login ${botPassword}`);
    }
  });

  bot.once('login', () => {
    console.log(`Bot "${bot.username}" logged in.`);
    io.emit('bot_status', `Bot ${bot.username} logged in.`);
  });

  bot.once('spawn', () => {
    console.log(`Bot "${bot.username}" spawned.`);
    io.emit('bot_status', `Bot ${bot.username} spawned. Anti-AFK active.`);
    startAntiAfk();
  });

  // ── Auto-respawn on death ─────────────────────────────────────────────────
  bot.on('death', () => {
    console.log('Bot died. Respawning in 1s...');
    io.emit('bot_status', 'Bot died, respawning...');
    setTimeout(() => {
      if (bot) {
        try { bot.respawn(); } catch (e) { console.log('Respawn error:', e.message); }
      }
    }, 1000);
  });

  bot.on('kicked', (reason) => {
    // Decode the kick reason fully — it's often nested JSON from Paper/Spigot
    let message = reason;
    try {
      const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
      // Recursively extract text
      const extract = (obj) => {
        if (!obj) return '';
        if (typeof obj === 'string') return obj;
        let out = obj.text || obj.translate || '';
        if (obj.extra) out += obj.extra.map(extract).join('');
        if (obj.with)  out += ' ' + obj.with.map(extract).join(' ');
        return out;
      };
      message = extract(parsed) || JSON.stringify(parsed);
    } catch (_) {}
    console.log(`Bot kicked — reason: "${message}"`);
    io.emit('bot_status', `Kicked: ${message}`);
  });

  bot.on('error', (err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error('Bot error:', msg);
    io.emit('bot_status', `Error: ${msg}`);
  });

  bot.on('end', (reason) => {
    console.log(`Bot disconnected. Reason: ${reason || 'unknown'}.`);
    cleanupBot();
    if (manualStop) { io.emit('bot_status', 'Bot stopped.'); return; }
    io.emit('bot_status', `Disconnected (${reason || 'unknown'}). Reconnecting in ${reconnectInterval / 1000}s.`);
    scheduleReconnect();
  });
}

// ── Anti-AFK: varied moves, occasional sprint+jump, smooth look ──────────────
function startAntiAfk() {
  stopAntiAfk();

  let step = 0;
  const sequence = [
    { move: 'forward', duration: 800,  jump: false, sprint: true  },
    { move: 'forward', duration: 600,  jump: true,  sprint: true  },
    { move: 'left',    duration: 400,  jump: false, sprint: false },
    { move: 'forward', duration: 1000, jump: false, sprint: false },
    { move: 'right',   duration: 400,  jump: false, sprint: false },
    { move: 'back',    duration: 500,  jump: false, sprint: false },
    { move: 'forward', duration: 700,  jump: true,  sprint: true  },
    { move: 'left',    duration: 300,  jump: false, sprint: false },
  ];

  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity) return;
    try {
      const s = sequence[step % sequence.length];
      step++;

      const yaw   = bot.entity.yaw   + (Math.random() - 0.5) * (Math.PI / 2);
      const pitch = Math.max(-0.4, Math.min(0.4, bot.entity.pitch + (Math.random() - 0.5) * 0.3));
      bot.look(yaw, pitch, true).catch(() => {});

      if (s.sprint) bot.setControlState('sprint', true);
      bot.setControlState(s.move, true);

      if (s.jump) {
        bot.setControlState('jump', true);
        setTimeout(() => { if (bot) bot.setControlState('jump', false); }, 250);
      }

      setTimeout(() => {
        if (!bot) return;
        bot.setControlState(s.move, false);
        bot.setControlState('sprint', false);
      }, s.duration);

      if (step % 3 === 0) bot.swingArm('right');

    } catch (err) {
      console.error('Anti-AFK error:', err.message);
    }
  }, antiAfkInterval);
}

function stopAntiAfk() {
  if (antiAfkTimer) { clearInterval(antiAfkTimer); antiAfkTimer = null; }
}

function cleanupBot() {
  stopAntiAfk();
  if (bot) { bot.removeAllListeners(); }
  bot = null;
}

function stopBot(message) {
  clearReconnectTimer();
  if (bot) {
    try { bot.quit(message || 'Bye'); } catch (err) { console.error('Error quitting bot:', err.message); }
    cleanupBot();
    console.log(message || 'Bot stopped.');
    io.emit('bot_status', message || 'Bot stopped.');
  } else {
    io.emit('bot_status', 'Bot is not running.');
  }
}

function reconnectBot() {
  console.log('Manual reconnect requested.');
  io.emit('bot_status', 'Reconnecting bot...');
  if (bot) { try { bot.quit('Reconnecting'); } catch (err) {} cleanupBot(); }
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => { reconnectTimer = null; createBot(); }, 1000);
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!bot && !manualStop) createBot();
  }, reconnectInterval);
}

function clearReconnectTimer() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down.');
  manualStop = true;
  stopBot('Server shutting down.');
  process.exit(0);
});

process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });

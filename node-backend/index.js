// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

// ---- ffmpeg / ffprobe (robust, aber kein Verbindungs-Blocker) ----
const ffmpeg = require("fluent-ffmpeg");
let ffmpegReady = false;
try {
  const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
  const ffprobeInstaller = require("@ffprobe-installer/ffprobe");
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  ffmpeg.setFfprobePath(ffprobeInstaller.path);
  ffmpegReady = true;
} catch (e) {
  console.warn("[warn] ffmpeg/ffprobe not fully configured. Transcoding may fail:", e.message);
}

const PORT = process.env.PORT || 5000;
const AUDIO_DIR = path.resolve(__dirname, "audio-chunks");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(null, true), // dev-freundlich
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 1e8,  // ~100 MB
  pingInterval: 25000,
  pingTimeout: 20000,
});

// ---------- Helpers ----------
const pad = (n) => String(n).padStart(2, "0");
// Format: Sekunde-Minute-Stunde_Tag-Monat-Jahr
function dateBaseName(d = new Date()) {
  const sec = pad(d.getSeconds());
  const min = pad(d.getMinutes());
  const hour = pad(d.getHours());
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  return `${sec}-${min}-${hour}_${day}-${month}-${year}`;
}

function extFromMime(m) {
  if (!m) return "webm";
  const x = m.toLowerCase();
  if (x.includes("webm")) return "webm";
  if (x.includes("mp4")) return "mp4";
  if (x.includes("mpeg")) return "mp3";
  if (x.includes("ogg")) return "ogg";
  if (x.includes("wav")) return "wav";
  return "bin";
}

// <<< WICHTIG: egal was der Client schickt (Buffer/ArrayBuffer/Array),
// wir konvertieren sauber in einen Node-Buffer >>>
function toBuffer(raw) {
  // Socket.IO v4 liefert Binary i.d.R. als Buffer oder ArrayBuffer
  if (Buffer.isBuffer(raw)) return raw;
  if (raw && raw.type === "Buffer" && Array.isArray(raw.data)) return Buffer.from(raw.data);
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
  if (Array.isArray(raw)) return Buffer.from(Uint8Array.from(raw));
  throw new Error("unsupported audioData type");
}

function transcodeToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegReady) return reject(new Error("ffmpeg/ffprobe not configured"));
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate(192)     // CBR 192kbps
      .audioChannels(1)      // Mono
      .audioFrequency(44100) // 44.1kHz
      .format("mp3")
      .on("start", (cmd) => console.log("[ffmpeg]", cmd))
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

function probe(filePath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegReady) return resolve({ duration: 0, sample_rate: 0, channels: 0, size: 0 });
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const stream = (data.streams || []).find((s) => s.codec_type === "audio");
      const duration =
        (stream && parseFloat(stream.duration)) ||
        (data.format && parseFloat(data.format.duration)) ||
        0;
      const sample_rate = stream ? parseInt(stream.sample_rate || "0", 10) : 0;
      const channels = stream ? parseInt(stream.channels || "0", 10) : 0;
      resolve({
        duration: isNaN(duration) ? 0 : duration,
        sample_rate,
        channels,
        size: data.format ? parseInt(data.format.size || "0", 10) : 0,
      });
    });
  });
}

// ---------- Socket.IO ----------
let connected = 0;

io.on("connection", (socket) => {
  connected += 1;
  const ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  console.log(`[conn] ${socket.id} from ${ip} — total: ${connected}`);

  socket.on("client:audio", async (payload = {}) => {
    try {
      const { audioData, mimeType, fileName } = payload;

      // 1) Bytes robust in Buffer wandeln
      const buf = toBuffer(audioData);
      if (!buf || buf.length === 0) throw new Error("no audio data");

      // 2) Eingangsdatei speichern (mit ursprünglicher Extension, zur Diagnose behalten)
      const srcExt = fileName && path.extname(fileName).slice(1)
        ? path.extname(fileName).slice(1)
        : extFromMime(mimeType);
      const base = dateBaseName(new Date());
      const srcName = `${base}_src.${srcExt}`;
      const srcPath = path.join(AUDIO_DIR, srcName);
      await fs.promises.writeFile(srcPath, buf);

      // 3) Transcodieren nach MP3
      const finalName = `${base}.mp3`;
      const finalPath = path.join(AUDIO_DIR, finalName);
      await transcodeToMp3(srcPath, finalPath);

      // 4) Validieren
      const meta = await probe(finalPath);
      const stat = await fs.promises.stat(finalPath).catch(() => null);

      if (!stat || stat.size === 0) {
        await fs.promises.unlink(finalPath).catch(() => {});
        throw new Error("mp3 size is 0 bytes");
      }
      if (ffmpegReady) {
        if (meta.duration < 0.2) {
          await fs.promises.unlink(finalPath).catch(() => {});
          throw new Error(`invalid duration ${meta.duration}s`);
        }
        if (meta.channels < 1) {
          await fs.promises.unlink(finalPath).catch(() => {});
          throw new Error("no audio channels detected");
        }
      }

      // (Optional) Original behalten — hilft enorm beim Debuggen
      // Wenn du unbedingt löschen willst: await fs.promises.unlink(srcPath).catch(() => {});

      console.log(
        `[OK] ${finalName} (${stat.size} bytes${ffmpegReady ? `, ${meta.duration.toFixed(2)}s, ${meta.sample_rate}Hz, ch=${meta.channels}` : ""})`
      );
      socket.emit("server:save_ack", {
        ok: true,
        fileName: finalName,
        bytes: stat.size,
        ...(ffmpegReady ? { duration: meta.duration, sampleRate: meta.sample_rate, channels: meta.channels } : {}),
      });
    } catch (err) {
      console.error(`[FAIL] ${err?.message || err}`);
      socket.emit("server:save_ack", { ok: false, error: String(err?.message || err) });
    }
  });

  socket.on("disconnect", (reason) => {
    connected -= 1;
    console.log(`[disc] ${socket.id} (${reason}) — total: ${connected}`);
  });
});

// Auf 0.0.0.0 binden
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Socket server listening on http://localhost:${PORT}`);
});

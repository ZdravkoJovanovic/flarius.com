// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---- ffmpeg / ffprobe ----
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
// Speichere NUR MP3s hier
const OUTPUT_DIR = path.resolve(__dirname, "audio-chunks");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);

// (Kein Abspiel-Endpoint nötig; falls gewünscht, könnte man OUTPUT_DIR statisch ausliefern)
// app.use("/audio", express.static(OUTPUT_DIR));

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(null, true),
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 1e8,
  pingInterval: 25000,
  pingTimeout: 20000,
});

// ---------- Helpers ----------
const pad = (n) => String(n).padStart(2, "0");
function dateBaseName(d = new Date()) {
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(
    d.getMinutes()
  )}-${pad(d.getSeconds())}-${ms}`;
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

function toBuffer(raw) {
  if (!raw) throw new Error("empty audio payload");
  if (Buffer.isBuffer(raw)) return raw;
  if (raw && raw.type === "Buffer" && Array.isArray(raw.data)) return Buffer.from(raw.data);
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
  if (Array.isArray(raw)) return Buffer.from(Uint8Array.from(raw));
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  throw new Error("unsupported audioData type");
}

function transcodeToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegReady) return reject(new Error("ffmpeg/ffprobe not configured"));
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate(192)
      .audioChannels(1)
      .audioFrequency(44100)
      .format("mp3")
      .on("start", (cmd) => console.log("[ffmpeg]", cmd))
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
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
    let tmpSrcPath = null;
    try {
      const raw = payload.audioBuffer ?? payload.audioData ?? null;
      const buf = toBuffer(raw);
      if (!buf || buf.length === 0) throw new Error("no audio data");

      if (!ffmpegReady) {
        throw new Error("Transcoding not available (ffmpeg/ffprobe not configured)");
      }

      const mimeType = (payload.mimeType || "").toString();
      const clientFileName = payload.fileName ? path.basename(payload.fileName) : "";
      const srcExt =
        clientFileName && path.extname(clientFileName).slice(1)
          ? path.extname(clientFileName).slice(1)
          : extFromMime(mimeType);

      const base = dateBaseName(new Date());

      // 1) Source TEMPORÄR im OS-Temp speichern (nicht im Zielordner!)
      tmpSrcPath = path.join(os.tmpdir(), `${base}_src.${srcExt}`);
      await fs.promises.writeFile(tmpSrcPath, buf);

      // 2) Transkodieren → NUR MP3 ins video-chunks
      const finalName = `${base}.mp3`;
      const finalPath = path.join(OUTPUT_DIR, finalName);
      await transcodeToMp3(tmpSrcPath, finalPath);

      // 3) Validieren
      const meta = await probe(finalPath);
      const stat = await fs.promises.stat(finalPath).catch(() => null);
      if (!stat || stat.size === 0) {
        await fs.promises.unlink(finalPath).catch(() => {});
        throw new Error("mp3 size is 0 bytes");
      }
      if (meta.duration < 0.2 || meta.channels < 1) {
        await fs.promises.unlink(finalPath).catch(() => {});
        throw new Error(`invalid audio (duration=${meta.duration}s, channels=${meta.channels})`);
      }

      console.log(
        `[OK] ${finalName} (${stat.size} bytes, ${meta.duration.toFixed(2)}s, ${meta.sample_rate}Hz, ch=${meta.channels})`
      );
      socket.emit("server:save_ack", {
        ok: true,
        fileName: finalName,
        bytes: stat.size,
        duration: meta.duration,
        sampleRate: meta.sample_rate,
        channels: meta.channels,
      });
    } catch (err) {
      console.error(`[FAIL] ${err?.message || err}`);
      socket.emit("server:save_ack", { ok: false, error: String(err?.message || err) });
    } finally {
      // 4) TEMP-Quelle IMMER löschen → im Zielordner liegt nur MP3
      if (tmpSrcPath) {
        await fs.promises.unlink(tmpSrcPath).catch(() => {});
      }
    }
  });

  socket.on("disconnect", (reason) => {
    connected -= 1;
    console.log(`[disc] ${socket.id} (${reason}) — total: ${connected}`);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Socket server listening on http://localhost:${PORT}`);
  console.log(`MP3-Output: ${OUTPUT_DIR}`);
});

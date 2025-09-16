"use client";

import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

// HMR/Dev: eine einzige Socket-Verbindung pro Tab behalten
declare global {
  interface Window {
    __SOCKET__?: Socket;
  }
}

export default function Home() {
  // --- Socket Status ---
  const [sockStatus, setSockStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [saveAck, setSaveAck] = useState<null | { ok: boolean; fileName?: string; bytes?: number; error?: string }>(null);

  // --- Audio UI/State ---
  const [hasPermission, setHasPermission] = useState(false);
  const [recording, setRecording] = useState(false);
  const [durationSec, setDurationSec] = useState(0);

  // --- Refs ---
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  // =========================
  // Socket direkt zu :5000
  // =========================
  useEffect(() => {
    if (typeof window !== "undefined" && window.__SOCKET__) {
      const s = window.__SOCKET__;
      setSockStatus(s.connected ? "connected" : "disconnected");
      s.off("connect").on("connect", () => setSockStatus("connected"));
      s.off("disconnect").on("disconnect", () => setSockStatus("disconnected"));
      s.off("connect_error").on("connect_error", () => setSockStatus("disconnected"));
      s.off("server:save_ack").on("server:save_ack", (ack) => setSaveAck(ack));
      return;
    }

    const socket = io("http://localhost:5000", {
      transports: ["websocket"],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 800,
      withCredentials: true,
    });

    if (typeof window !== "undefined") {
      window.__SOCKET__ = socket;
    }

    socket.on("connect", () => setSockStatus("connected"));
    socket.on("disconnect", () => setSockStatus("disconnected"));
    socket.on("connect_error", () => setSockStatus("disconnected"));
    socket.on("server:save_ack", (ack) => setSaveAck(ack));

    const onUnload = () => {
      try {
        socket.close();
      } catch {}
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      window.removeEventListener("beforeunload", onUnload);
      // KEIN socket.close() hier, damit HMR nicht doppelte Connect-Logs erzeugt.
    };
  }, []);

  // =========================
  // Audio: Helpers
  // =========================
  const getSupportedMimeType = () => {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",   // Safari
      "audio/mpeg",  // MP3 (selten via MediaRecorder)
    ];
    for (const type of candidates) {
      if ((window as any).MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
    }
    return ""; // Browser wählt Standard
  };

  const startTimer = () => {
    setDurationSec(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setDurationSec((s) => s + 1);
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const fmt = (n: number) => n.toString().padStart(2, "0");
  const mmss = `${fmt(Math.floor(durationSec / 60))}:${fmt(durationSec % 60)}`;

  // =========================
  // Audio: Flow
  // =========================
  const requestMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 44100,
          sampleSize: 16,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      setHasPermission(true);
    } catch (err) {
      console.error("Mikrofon-Zugriff fehlgeschlagen:", err);
      alert("Zugriff auf das Mikrofon wurde verweigert oder ist nicht verfügbar.");
      setHasPermission(false);
    }
  };

  const startRecording = async () => {
    try {
      if (!streamRef.current) {
        await requestMic();
        if (!streamRef.current) return;
      }

      const mimeType = getSupportedMimeType();
      const options = mimeType ? { mimeType } : undefined;
      const mr = new MediaRecorder(streamRef.current!, options);
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];
      setSaveAck(null); // altes Ack zurücksetzen

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };
      mr.onerror = (e) => console.error("MediaRecorder Fehler:", e);

      // alle 1s Chunks sammeln (Versand erfolgt NACH Stop)
      mr.start(1000);
      setRecording(true);
      startTimer();
      console.log(`Aufnahme gestartet (MIME: ${mr.mimeType || mimeType || "default"})`);
    } catch (e) {
      console.error("Konnte Aufnahme nicht starten:", e);
      setRecording(false);
      stopTimer();
    }
  };

  const stopRecording = async () => {
    if (!mediaRecorderRef.current || !recording) return;

    mediaRecorderRef.current.onstop = async () => {
      try {
        const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
        const blob = new Blob(audioChunksRef.current, { type: mimeType });

        // Dateiendung bestimmen
        let extension = ".webm";
        if (mimeType.includes("mp4")) extension = ".mp4";
        if (mimeType.includes("mpeg")) extension = ".mp3";

        // Bytes bauen
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = Array.from(new Uint8Array(arrayBuffer));

        const socket = window.__SOCKET__;
        if (socket && socket.connected) {
          // Audio-Daten an 5000 senden → Server speichert in ./audio-chunks
          socket.emit("client:audio", {
            audioData: bytes,
            fileName: `recording_${Date.now()}${extension}`,
            mimeType,
          });
          console.log("Audio-Daten an Server gesendet");
        } else {
          console.warn("Socket nicht verbunden — nichts gesendet.");
          setSaveAck({ ok: false, error: "Socket disconnected" });
        }
      } catch (e: any) {
        console.error("Fehler beim Finalisieren/Versenden:", e);
        setSaveAck({ ok: false, error: String(e?.message || e) });
      } finally {
        // Chunks leeren, Stream behalten (erneute Aufnahme ohne neue Permission)
        audioChunksRef.current = [];
        setRecording(false);
        stopTimer();
      }
    };

    try {
      mediaRecorderRef.current.stop();
    } catch (e) {
      console.error("Stop-Aufruf fehlgeschlagen:", e);
      setRecording(false);
      stopTimer();
    }
  };

  // Aufräumen bei Unmount
  useEffect(() => {
    return () => {
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {}
      try {
        streamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {}
      stopTimer();
    };
  }, []);

  // =========================
  // UI
  // =========================
  return (
    <div className="fixed inset-0 bg-black text-white flex items-center justify-center">
      <div className="w-full max-w-md mx-auto px-6 py-8 flex flex-col gap-6">
        {/* Socket Status */}
        <div className="text-center">
          <div className="text-xs opacity-60 mb-1">Socket → localhost:5000</div>
          <div className={`text-lg font-mono ${sockStatus === "connected" ? "text-green-400" : "text-red-400"}`}>
            {sockStatus === "connected" ? "Verbunden" : sockStatus === "connecting" ? "Verbinde..." : "Nicht verbunden"}
          </div>
        </div>

        {/* Audio Controls */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 flex flex-col items-center gap-4">
          {!hasPermission ? (
            <>
              <div className="text-center text-sm opacity-80">
                Erteile Zugriff auf dein Mikrofon, um aufzunehmen.
              </div>
              <button
                onClick={requestMic}
                className="px-6 py-3 font-semibold rounded-md border border-black bg-white text-black transition-colors hover:bg-gray-100"
              >
                Mikrofon erlauben
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                {recording ? (
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
                    </span>
                    <span className="font-mono">{mmss}</span>
                  </div>
                ) : (
                  <div className="font-mono text-sm opacity-70">bereit</div>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={startRecording}
                  disabled={recording}
                  className={`px-6 py-3 font-semibold rounded-md border border-black bg-white text-black transition-colors hover:bg-gray-100 ${recording ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  Aufnahme starten
                </button>

                <button
                  onClick={stopRecording}
                  disabled={!recording}
                  className={`px-6 py-3 font-semibold rounded-md border border-black bg-white text-black transition-colors hover:bg-gray-100 ${!recording ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  Beenden
                </button>
              </div>

              {/* Server-Antwort anzeigen */}
              {saveAck && (
                <div className={`text-sm mt-2 ${saveAck.ok ? "text-green-400" : "text-red-400"}`}>
                  {saveAck.ok
                    ? `Gespeichert: ${saveAck.fileName} (${saveAck.bytes} bytes)`
                    : `Fehlgeschlagen: ${saveAck.error}`}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

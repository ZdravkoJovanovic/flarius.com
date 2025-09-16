from flask import Flask, request, jsonify
import ffmpeg
from datetime import datetime
import os
import tempfile
import concurrent.futures
from openai import OpenAI
from dotenv import load_dotenv
from colorama import Fore, Style
from pathlib import Path

# === Setup ===
load_dotenv()
app = Flask(__name__)

api_key = os.getenv("OPENAI_API_KEY") or os.getenv("OPEN_AI_API_KEY")
if not api_key:
    print("WARNING: OpenAI API key not found in OPENAI_API_KEY or OPEN_AI_API_KEY")
client = OpenAI(api_key=api_key) if api_key else OpenAI()

ORIGINAL_AUDIO_FILE = "./PAF.mp3"   # stelle sicher: existiert und lesbar
OUTPUT_DIR = "./VAF"
os.makedirs(OUTPUT_DIR, exist_ok=True)

FFMPEG_LOGLEVEL = os.getenv("FFMPEG_LOGLEVEL", "error")  # z.B. info|debug

print(f"Original audio exists: {os.path.exists(ORIGINAL_AUDIO_FILE)} ({os.path.abspath(ORIGINAL_AUDIO_FILE)})")
print(f"VAF output dir: {os.path.abspath(OUTPUT_DIR)}")
print(f"FFMPEG_LOGLEVEL={FFMPEG_LOGLEVEL}")

# === Transkription ===
def transcribe_file(file_path, speaker):
    try:
        print(Fore.CYAN + f"Transcribing {file_path} for {speaker}..." + Style.RESET_ALL)
        with open(file_path, "rb") as audio_file:
            resp = client.audio.transcriptions.create(
                model="gpt-4o-transcribe",
                file=audio_file,
                response_format="text",
            )

        text = None
        if isinstance(resp, str):
            text = resp
        else:
            text = getattr(resp, "text", None)
            if text is None:
                try:
                    text = resp.get("text")
                except Exception:
                    text = None
        if text is None:
            text = str(resp)

        print(Fore.YELLOW + f"{speaker}: {text}" + Style.RESET_ALL)
    except Exception as e:
        print(Fore.RED + f"Error transcribing {file_path} for {speaker}: {e}" + Style.RESET_ALL)

def start_transcriptions_background(generated_files, max_workers=5):
    if not generated_files:
        return
    print("Starting background transcription (max_workers=%d) ..." % max_workers)
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=max_workers)
    for spk, fpath in generated_files:
        executor.submit(transcribe_file, fpath, spk)
    executor.shutdown(wait=False)
    print("Background transcription launched.")

# === ffmpeg helpers ===
def print_cmd(cmd):
    try:
        argv = cmd.compile()
        print(Fore.MAGENTA + "[ffmpeg cmd] " + " ".join(map(str, argv)) + Style.RESET_ALL)
    except Exception:
        pass

def run_ffmpeg(cmd):
    """Run ffmpeg command, print compiled argv and full stderr; return (ok, stdout_bytes, stderr_bytes)."""
    print_cmd(cmd)
    try:
        out, err = cmd.run(
            capture_stdout=True,
            capture_stderr=True,
            overwrite_output=True,
        )
        if err:
            try:
                print(Fore.BLUE + "[ffmpeg stderr]\n" + err.decode("utf-8", errors="ignore") + Style.RESET_ALL)
            except Exception:
                print(Fore.BLUE + "[ffmpeg stderr - bytes]" + Style.RESET_ALL, err)
        return True, out, err
    except ffmpeg.Error as e:
        stderr_text = ""
        try:
            stderr_text = e.stderr.decode("utf-8", errors="ignore")
        except Exception:
            stderr_text = str(e.stderr)
        print(Fore.RED + "[ffmpeg ERROR]\n" + stderr_text + Style.RESET_ALL)
        return False, getattr(e, "stdout", b""), getattr(e, "stderr", b"")
    except Exception as e:
        print(Fore.RED + f"[ffmpeg ERROR - non-ffmpeg] {e}" + Style.RESET_ALL)
        return False, b"", str(e).encode()

def cut_segment_to_mp3(src_path, start, end, out_path):
    """Schneidet [start,end) in MP3 (CBR 192k/44.1kHz/mono) – stabil und fürs spätere Concat homogen."""
    dur = max(0.0, float(end) - float(start))
    if dur <= 0:
        raise ValueError(f"non-positive duration: start={start}, end={end}")
    cmd = (
        ffmpeg
        .input(src_path, ss=float(start))
        .output(
            out_path,
            t=dur,
            format="mp3",
            acodec="mp3",
            audio_bitrate="192k",
            ac=1,
            ar="44100",
        )
        .global_args("-hide_banner", "-loglevel", FFMPEG_LOGLEVEL)
    )
    ok, _, _ = run_ffmpeg(cmd)
    return ok and os.path.exists(out_path) and os.path.getsize(out_path) > 0

def _quote_for_concat(path_str: str) -> str:
    """Einfaches Quoting für concat-Listen (escape single quotes)."""
    return path_str.replace("'", r"'\''")

def concat_via_demuxer(file_list, out_path):
    """Schnelles Concat ohne Re-Encode: -f concat -safe 0 -i list.txt -c copy
       WICHTIG: Wir schreiben **absolute** Pfade, um doppeltes VAF/./VAF zu vermeiden."""
    # Liste im Tempfile (im OUTPUT_DIR) schreiben
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, dir=OUTPUT_DIR) as lf:
      list_path = lf.name
      for f in file_list:
          abs_f = str(Path(f).resolve())         # <-- absoluter Pfad
          lf.write(f"file '{_quote_for_concat(abs_f)}'\n")

    cmd = (
        ffmpeg
        .input(list_path, format="concat", safe=0)
        .output(out_path, **{"c":"copy"})  # -codec copy
        .global_args("-hide_banner", "-loglevel", FFMPEG_LOGLEVEL)
    )
    try:
        ok, _, _ = run_ffmpeg(cmd)
    finally:
        try:
            os.remove(list_path)
        except Exception:
            pass
    return ok and os.path.exists(out_path) and os.path.getsize(out_path) > 0

def concat_via_filter(file_list, out_path):
    """Fallback: Filter-Concat mit Re-Encode (robust, aber langsamer)."""
    inputs = [ffmpeg.input(f) for f in file_list]
    # N Audio-Inputs -> concat filter (audio only)
    a_streams = [inp.audio for inp in inputs]
    concat_stream = ffmpeg.filter(a_streams, "concat", n=len(a_streams), v=0, a=1)
    cmd = (
        ffmpeg
        .output(
            concat_stream,
            out_path,
            format="mp3",
            acodec="mp3",
            audio_bitrate="192k",
            ac=1,
            ar="44100",
        )
        .global_args("-hide_banner", "-loglevel", FFMPEG_LOGLEVEL)
    )
    ok, _, _ = run_ffmpeg(cmd)
    return ok and os.path.exists(out_path) and os.path.getsize(out_path) > 0

# === Webhook ===
@app.route("/webhook", methods=["POST"])
def webhook():
    try:
        data = request.get_json(force=True)
    except Exception as e:
        print("Error parsing JSON payload:", e)
        print("Raw body:", request.data[:1000])
        return jsonify({"status": "bad_request", "error": "invalid json"}), 400

    print("========== Diarization result received ==========")
    print(data)

    diarization = data.get("output", {}).get("diarization", [])
    if not diarization:
        print("No diarization data found in webhook payload.")
        return jsonify({"status": "no_diarization"}), 200

    speakers = {}
    for seg in diarization:
        spk = seg.get("speaker")
        start = seg.get("start")
        end = seg.get("end")
        try:
            print(f"Segment detected: {spk}, {float(start):.3f}s – {float(end):.3f}s")
        except Exception:
            print(f"Segment detected: {spk}, {start}s – {end}s")
        if spk is None or start is None or end is None:
            continue
        speakers.setdefault(spk, []).append((float(start), float(end)))

    for spk in speakers:
        speakers[spk].sort(key=lambda x: x[0])

    generated_files = []

    for spk, intervals in speakers.items():
        print(f"\nProcessing speaker {spk} with {len(intervals)} intervals.")
        timestamp = datetime.now().strftime("%Y_%m_%d_%H_%M_%S")
        output_file = os.path.join(OUTPUT_DIR, f"{spk}_{timestamp}.mp3")

        temp_files = []
        try:
            # 1) Segmente schneiden
            for i, (start, end) in enumerate(intervals):
                if end <= start:
                    print(Fore.RED + f"  - Skip segment {i}: end ({end}) <= start ({start})" + Style.RESET_ALL)
                    continue
                temp_file = os.path.join(OUTPUT_DIR, f"{spk}_temp_{i}.mp3")
                ok = cut_segment_to_mp3(ORIGINAL_AUDIO_FILE, start, end, temp_file)
                if ok:
                    print(f"  - Segment {i}: {start:.3f}s – {end:.3f}s saved to {temp_file}")
                    temp_files.append(temp_file)
                else:
                    print(Fore.RED + f"  - Segment {i} failed or empty: {temp_file}" + Style.RESET_ALL)

            if not temp_files:
                print(f"No audio segments found for {spk}, skipping export.")
                continue

            # 2) Mergen: erst Demuxer (copy), dann Fallback Filter (re-encode)
            merged_ok = concat_via_demuxer(temp_files, output_file)
            if not merged_ok:
                print(Fore.YELLOW + "Demuxer concat failed, trying filter concat (re-encode)..." + Style.RESET_ALL)
                merged_ok = concat_via_filter(temp_files, output_file)

            if merged_ok:
                print(f"Saved merged speaker audio: {output_file}")
                generated_files.append((spk, output_file))
            else:
                print(Fore.RED + f"Error merging segments for {spk}: output missing/empty" + Style.RESET_ALL)
        finally:
            # 3) Temp-Segmente wegräumen
            for f in temp_files:
                try:
                    os.remove(f)
                except Exception:
                    pass

    if generated_files:
        start_transcriptions_background(generated_files, max_workers=5)

    print("========== Webhook processing finished ==========\n")
    return jsonify({"status": "received"}), 200


if __name__ == "__main__":
    print("Starting Flask server on port 4000...")
    app.run(host="0.0.0.0", port=4000)

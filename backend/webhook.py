from flask import Flask, request, jsonify
import ffmpeg
from datetime import datetime
import os
import concurrent.futures
from openai import OpenAI
from dotenv import load_dotenv
from colorama import Fore, Style

# === Setup ===
load_dotenv()
app = Flask(__name__)

# flexible Env-Namen (vermeidet häufige Tippfehler)
api_key = os.getenv("OPENAI_API_KEY") or os.getenv("OPEN_AI_API_KEY")
if not api_key:
    print("WARNING: OpenAI API key not found in OPENAI_API_KEY or OPEN_AI_API_KEY")
# init client (pass key if present)
client = OpenAI(api_key=api_key) if api_key else OpenAI()

ORIGINAL_AUDIO_FILE = "./PAF.mp3"
OUTPUT_DIR = "./VAF"
os.makedirs(OUTPUT_DIR, exist_ok=True)

print(f"Original audio exists: {os.path.exists(ORIGINAL_AUDIO_FILE)}")
print(f"VAF output dir: {os.path.abspath(OUTPUT_DIR)}")


# === Funktion: Transkription (robust gegenüber verschiedenen SDK-Antworten) ===
def transcribe_file(file_path, speaker):
    try:
        print(Fore.CYAN + f"Transcribing {file_path} for {speaker}..." + Style.RESET_ALL)
        with open(file_path, "rb") as audio_file:
            resp = client.audio.transcriptions.create(
                model="gpt-4o-transcribe",
                file=audio_file,
                response_format="text"
            )

        # resp kann je nach SDK-Version unterschiedlich aussehen:
        # - direkt ein string (wenn response_format="text")
        # - ein Objekt mit .text
        # - ein dict mit key "text"
        text = None
        if isinstance(resp, str):
            text = resp
        else:
            # try attribute .text
            text = getattr(resp, "text", None)
            if text is None:
                # try mapping-like response
                try:
                    text = resp.get("text")
                except Exception:
                    text = None
        if text is None:
            # fallback: stringify entire response (debug)
            text = str(resp)

        print(Fore.YELLOW + f"{speaker}: {text}" + Style.RESET_ALL)
    except Exception as e:
        print(Fore.RED + f"Error transcribing {file_path} for {speaker}: {e}" + Style.RESET_ALL)


# helper: start background transcription (non-blocking)
def start_transcriptions_background(generated_files, max_workers=5):
    if not generated_files:
        return
    print("Starting background transcription (max_workers=%d) ..." % max_workers)
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=max_workers)
    for spk, fpath in generated_files:
        executor.submit(transcribe_file, fpath, spk)
    # Do not wait; shutdown non-blocking to allow threads to run
    executor.shutdown(wait=False)
    print("Background transcription launched.")


@app.route("/webhook", methods=["POST"])
def webhook():
    # robust JSON read
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
        return jsonify({"status": "no_diarization"}), 200  # OK but nothing to do

    # Gruppe pro Speaker
    speakers = {}
    for segment in diarization:
        spk = segment.get("speaker")
        start = segment.get("start")
        end = segment.get("end")
        print(f"Segment detected: {spk}, {start:.3f}s – {end:.3f}s")
        if spk is None or start is None or end is None:
            continue
        speakers.setdefault(spk, []).append((start, end))

    generated_files = []

    # Schneiden / Mergen (wie gehabt)
    for spk, intervals in speakers.items():
        print(f"\nProcessing speaker {spk} with {len(intervals)} intervals.")
        timestamp = datetime.now().strftime("%Y_%m_%d_%H_%M_%S")
        output_file = os.path.join(OUTPUT_DIR, f"{spk}_{timestamp}.mp3")

        temp_files = []
        for i, (start, end) in enumerate(intervals):
            temp_file = os.path.join(OUTPUT_DIR, f"{spk}_temp_{i}.mp3")
            try:
                (
                    ffmpeg
                    .input(ORIGINAL_AUDIO_FILE, ss=start, to=end)
                    .output(temp_file, format="mp3", acodec="mp3")
                    .overwrite_output()
                    .run(quiet=True)
                )
                print(f"  - Segment {i}: {start:.3f}s – {end:.3f}s saved to {temp_file}")
                temp_files.append(temp_file)
            except Exception as e:
                print(f"Error exporting segment {i} for {spk}: {e}")

        if temp_files:
            try:
                input_streams = [ffmpeg.input(f) for f in temp_files]
                ffmpeg.concat(*input_streams, v=0, a=1).output(output_file).overwrite_output().run(quiet=True)
                print(f"Saved merged speaker audio: {output_file}")
                generated_files.append((spk, output_file))
            except Exception as e:
                print(f"Error merging segments for {spk}: {e}")

            # temp files löschen
            for f in temp_files:
                try:
                    os.remove(f)
                except Exception:
                    pass
        else:
            print(f"No audio segments found for {spk}, skipping export.")

    # Start transcription in background (non-blocking)
    if generated_files:
        start_transcriptions_background(generated_files, max_workers=5)

    print("========== Webhook processing finished ==========\n")
    # antwort sofort => Pyannote wartet nicht ewig
    return jsonify({"status": "received"}), 200


if __name__ == "__main__":
    print("Starting Flask server on port 4000...")
    app.run(host="0.0.0.0", port=4000)

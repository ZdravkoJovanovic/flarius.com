import os
from dotenv import load_dotenv
import requests

# .env laden
load_dotenv()

API_KEY = os.getenv("PYNOTE_API_KEY")
NGROK_URL = os.getenv("NGROK_URL")

url = "https://api.pyannote.ai/v1/diarize"
file_url = "https://drive.google.com/uc?export=download&id=1jzfDy3-XyXUa3qbMKJywSkFf9j1sAjXP"
webhook_url = f"{NGROK_URL}/webhook"

headers = {
   "Authorization": f"Bearer {API_KEY}"
}
data = {
    'webhook': webhook_url,
    'url': file_url
}
response = requests.post(url, headers=headers, json=data)

print(response.status_code)
# 200

print(response.json()) 

# VAF = verarbeitete Audio File
# RVAV = Raw verarbeitete Audio File
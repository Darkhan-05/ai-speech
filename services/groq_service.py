import httpx
import logging

logger = logging.getLogger(__name__)

class GroqService:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://api.groq.com/openai/v1"
        self.headers = {
            "Authorization": f"Bearer {self.api_key}"
        }

    async def transcribe_audio(self, file_content: bytes, filename: str) -> str:
        """
        Transcribes audio/video file using Groq's Whisper model.
        """
        url = f"{self.base_url}/audio/transcriptions"

        # Groq Whisper API expects 'file' and 'model'
        files = {
            "file": (filename, file_content)
        }
        data = {
            "model": "whisper-large-v3",
            "response_format": "json"
        }

        try:
            async with httpx.AsyncClient(timeout=300.0) as client: # Increased timeout for large files
                response = await client.post(url, headers=self.headers, files=files, data=data)
                response.raise_for_status()
                return response.json().get("text", "")
        except httpx.HTTPStatusError as e:
            logger.error(f"Groq Transcription Error: {e.response.text}")
            raise e
        except Exception as e:
            logger.error(f"Groq Transcription Exception: {str(e)}")
            raise e

    async def analyze_transcript(self, transcript: str) -> str:
        """
        Analyzes the transcript using Llama-3 to extract specific sections.
        """
        url = f"{self.base_url}/chat/completions"

        system_prompt = (
            "You are an expert meeting analyst. Your task is to analyze the following transcript "
            "and extract key information in Russian. "
            "Please strictly follow this structure in your response:\n\n"
            "📌 Темы\n"
            "- [List of topics discussed]\n\n"
            "✅ Чек-лист задач\n"
            "- [List of action items]\n\n"
            "❗️ Решения\n"
            "- [List of decisions made]\n\n"
            "Output must be in Markdown format."
        )

        payload = {
            "model": "llama-3-70b-8192",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": transcript}
            ],
            "temperature": 0.3, # Lower temperature for more deterministic/factual output
            "max_tokens": 4096
        }

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(url, headers=self.headers, json=payload)
                response.raise_for_status()
                return response.json()["choices"][0]["message"]["content"]
        except httpx.HTTPStatusError as e:
            logger.error(f"Groq Analysis Error: {e.response.text}")
            raise e
        except Exception as e:
            logger.error(f"Groq Analysis Exception: {str(e)}")
            raise e

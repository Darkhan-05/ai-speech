import unittest
from unittest.mock import MagicMock, patch, AsyncMock
import sys
import os

# Add parent dir to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from services.groq_service import GroqService
from services.planka_service import PlankaService

class TestGroqService(unittest.IsolatedAsyncioTestCase):
    async def test_transcribe_audio(self):
        service = GroqService("fake_key")
        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {"text": "hello world"}
            mock_client.post.return_value = mock_response

            result = await service.transcribe_audio(b"fake_content", "test.mp3")

            self.assertEqual(result, "hello world")
            mock_client.post.assert_called_once()
            call_args = mock_client.post.call_args
            self.assertIn("/audio/transcriptions", call_args[0][0])

    async def test_analyze_transcript(self):
        service = GroqService("fake_key")
        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {"choices": [{"message": {"content": "Analysis"}}]}
            mock_client.post.return_value = mock_response

            result = await service.analyze_transcript("transcript")

            self.assertEqual(result, "Analysis")
            mock_client.post.assert_called_once()

class TestPlankaService(unittest.IsolatedAsyncioTestCase):
    async def test_create_meeting_card(self):
        service = PlankaService("http://planka.com", "Board")
        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {"id": "123"}
            mock_client.post.return_value = mock_response

            result = await service.create_meeting_card("desc", "12345")

            mock_client.post.assert_called_once()
            call_args = mock_client.post.call_args
            self.assertIn("/api/external/create-meeting-card", call_args[0][0])
            self.assertEqual(call_args.kwargs['json']['description'], "desc")

if __name__ == "__main__":
    unittest.main()

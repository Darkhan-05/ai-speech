import httpx
import logging
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

class PlankaService:
    def __init__(self, backend_url: str, board_name: str = "Протокол"):
        self.backend_url = backend_url.rstrip('/')
        self.board_name = board_name

    async def create_meeting_card(self, description: str, source_user_id: str, file_url: Optional[str] = None) -> dict:
        """
        Sends a request to Planka backend to create a meeting card.
        Returns the response JSON or raises an exception.
        """
        endpoint = f"{self.backend_url}/api/external/create-meeting-card"

        current_date = datetime.now().strftime("%d.%m.%Y")
        title = f"Встреча Заседание Совещание [{current_date}]"

        payload = {
            "title": title,
            "description": description,
            "source_user_id": str(source_user_id),
            "file_url": file_url if file_url else "",
            "board_name": self.board_name
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(endpoint, json=payload)
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as e:
            logger.error(f"Planka API Error: {e.response.text}")
            raise e
        except Exception as e:
            logger.error(f"Planka API Exception: {str(e)}")
            raise e

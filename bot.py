import os
import logging
import io
import asyncio
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import ApplicationBuilder, ContextTypes, MessageHandler, filters

from services.groq_service import GroqService
from services.planka_service import PlankaService

# Load env vars
load_dotenv()

# Configuration
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
PLANKA_BACKEND_URL = os.getenv("PLANKA_BACKEND_URL")
PLANKA_BOARD_NAME = os.getenv("PLANKA_BOARD_NAME", "Протокол")

# Logging setup
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Initialize Services
# We initialize them globally for simplicity, but ideally they could be initialized in main or passed via context
groq_service = None
planka_service = None

async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    logger.info(f"Received message from user {user_id}")

    # Determine the file object and name
    file_obj = None
    file_name = "unknown_file"

    if update.message.voice:
        file_obj = update.message.voice
        file_name = f"voice_{file_obj.file_id}.ogg"
    elif update.message.audio:
        file_obj = update.message.audio
        file_name = file_obj.file_name or f"audio_{file_obj.file_id}.mp3"
    elif update.message.video:
        file_obj = update.message.video
        file_name = file_obj.file_name or f"video_{file_obj.file_id}.mp4"
    elif update.message.video_note:
        file_obj = update.message.video_note
        file_name = f"video_note_{file_obj.file_id}.mp4"
    elif update.message.document:
        file_obj = update.message.document
        file_name = file_obj.file_name or f"doc_{file_obj.file_id}"
        # Check mime type for documents
        if not (file_obj.mime_type and (file_obj.mime_type.startswith('audio/') or file_obj.mime_type.startswith('video/'))):
             await update.message.reply_text("❌ Пожалуйста, отправьте аудио или видео файл.")
             return
    else:
        await update.message.reply_text("❌ Неподдерживаемый тип сообщения.")
        return

    # Check file size (25MB limit for Groq)
    # Telegram sends file_size in bytes. 25MB = 25 * 1024 * 1024
    MAX_SIZE = 25 * 1024 * 1024
    if file_obj.file_size and file_obj.file_size > MAX_SIZE:
        await update.message.reply_text("❌ Файл слишком большой. Максимальный размер для Groq — 25МБ. Пожалуйста, сожмите файл.")
        return

    status_msg = await update.message.reply_text("🔄 Обрабатываю файл...")

    try:
        # Download file
        # get_file gives us a File object which we can download
        # Timeout for get_file can be increased
        new_file = await context.bot.get_file(file_obj.file_id, read_timeout=60)

        byte_stream = io.BytesIO()
        await new_file.download_to_memory(byte_stream)
        byte_stream.seek(0)
        file_content = byte_stream.read()

        # STT
        transcript = await groq_service.transcribe_audio(file_content, file_name)

        await status_msg.edit_text("📝 Транскрибация завершена, анализирую...")

        # Analysis
        analysis = await groq_service.analyze_transcript(transcript)

        # Send to Planka
        # Construct full URL for the file
        # Note: This includes the bot token, which is a security risk if the link is shared publicly.
        # However, it allows access to the file directly from Planka.
        full_file_url = new_file.file_path
        if full_file_url and not full_file_url.startswith("http"):
             full_file_url = f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{new_file.file_path}"

        await planka_service.create_meeting_card(
            description=analysis,
            source_user_id=str(user_id),
            file_url=full_file_url
        )

        await status_msg.edit_text(f"✅ Карточка успешно создана на доске «{PLANKA_BOARD_NAME}».")

    except Exception as e:
        logger.error(f"Error processing file: {e}", exc_info=True)
        # Try to extract a more user-friendly error message if possible
        error_text = str(e)
        if "413" in error_text:
            error_text = "File too large for service."

        await status_msg.edit_text(f"❌ Ошибка при создании карточки: {error_text}")

def main():
    global groq_service, planka_service

    if not TELEGRAM_BOT_TOKEN or not GROQ_API_KEY or not PLANKA_BACKEND_URL:
        logger.error("Missing environment variables. Please check .env file.")
        print("Missing environment variables. Please check .env file.")
        return

    groq_service = GroqService(api_key=GROQ_API_KEY)
    planka_service = PlankaService(backend_url=PLANKA_BACKEND_URL, board_name=PLANKA_BOARD_NAME)

    application = ApplicationBuilder().token(TELEGRAM_BOT_TOKEN).build()

    # Handle various file types
    file_handler = MessageHandler(
        filters.VOICE | filters.AUDIO | filters.VIDEO | filters.VIDEO_NOTE | filters.Document.ALL,
        handle_document
    )

    application.add_handler(file_handler)

    logger.info("Bot is polling...")
    application.run_polling()

if __name__ == '__main__':
    main()

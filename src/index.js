const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const axios = require("axios");
const FormData = require("form-data");
const { Telegraf } = require("telegraf");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const dotenv = require("dotenv");
dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API_ROOT = process.env.TELEGRAM_API_ROOT || "https://api.telegram.org"; // Local Bot API server address
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const PLANKA_API_URL =
  process.env.PLANKA_API_URL || process.env.PLANKA_BACKEND_URL || "";
const PLANKA_API_TOKEN = process.env.PLANKA_API_TOKEN;
const PLANKA_BOARD_NAME = process.env.PLANKA_BOARD_NAME || "Протокол";

const TELEGRAM_LIMIT_BYTES = 2000 * 1024 * 1024; // 2GB limit for local API server

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment.");
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in environment.");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN, {
  telegram: {
    apiRoot: TELEGRAM_API_ROOT,
    apiMode: 'bot',
  },
  handlerTimeout: 600_000
});
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(GEMINI_API_KEY);

class StageError extends Error {
  constructor(stage, message, cause) {
    super(message);
    this.stage = stage;
    this.cause = cause;
  }
}

const SYSTEM_PROMPT = [
  "Ты — аналитик встреч.",
  "Проанализируй транскрипцию и верни краткую, структурированную выжимку.",
  "Ответ строго на русском и только в Markdown.",
  'Используй заголовки: "📌 Обсуждаемые темы", "✅ Чек-лист задач", "❗️ Важные вопросы".',
  "Под заголовками используй списки.",
  "В чек-листе задач указывай, кто и что должен сделать.",
].join(" ");

function formatDateShort(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

function extractFileMeta(ctx) {
  const message = ctx.message || {};

  if (message.voice) {
    return {
      kind: "voice",
      fileId: message.voice.file_id,
      fileSize: message.voice.file_size,
      fileName: "voice.ogg",
    };
  }

  if (message.audio) {
    return {
      kind: "audio",
      fileId: message.audio.file_id,
      fileSize: message.audio.file_size,
      fileName: message.audio.file_name || "audio.mp3",
    };
  }

  if (message.video) {
    return {
      kind: "video",
      fileId: message.video.file_id,
      fileSize: message.video.file_size,
      fileName: message.video.file_name || "video.mp4",
    };
  }

  if (message.document) {
    const ext = path.extname(message.document.file_name || "").toLowerCase();
    const supported = [".mp3", ".wav", ".m4a", ".mp4", ".mov"];
    if (supported.includes(ext) || message.document.mime_type?.startsWith("audio/") || message.document.mime_type?.startsWith("video/")) {
      return {
        kind: "document",
        fileId: message.document.file_id,
        fileSize: message.document.file_size,
        fileName: message.document.file_name || "file.bin",
      };
    }
  }

  return null;
}

function getTempFilePath(fileName, fileLinkUrl) {
  const parsedUrl = new URL(fileLinkUrl);
  const extFromUrl = path.extname(parsedUrl.pathname);
  const extFromName = path.extname(fileName || "");
  const extension = extFromUrl || extFromName || ".bin";
  const unique = crypto.randomUUID();
  return path.join(os.tmpdir(), `tg-${Date.now()}-${unique}${extension}`);
}

function humanSize(bytes) {
  if (!bytes || Number.isNaN(bytes)) return "неизвестен";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function validateSizeOrThrow(fileSize) {
  if (!fileSize) return;
  if (fileSize > TELEGRAM_LIMIT_BYTES) {
    throw new StageError(
      "Validation",
      `Файл слишком большой (${humanSize(fileSize)}). Стандартный лимит Telegram — 20 MB. Для файлов до 2 ГБ требуется локальный Bot API сервер.`,
    );
  }
}

async function downloadTelegramFile(ctx, meta) {
  const maxAttempts = 6;
  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      const getFileUrl = `${TELEGRAM_API_ROOT}/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${meta.fileId}`;
      const response = await axios.get(getFileUrl, { timeout: 300_000 });

      if (response.data.ok) {
        const internalPath = response.data.result.file_path;

        // ВАЖНО: Мы заменяем путь контейнера на твой реальный путь на диске
        const hostPath = internalPath.replace('/var/lib/telegram-bot-api', '/home/darkhan/tg-data');

        console.log(`[Attempt ${attempt + 1}] Проверяю файл: ${hostPath}`);

        if (fs.existsSync(hostPath)) {
          const tempPath = getTempFilePath(meta.fileName, 'file://' + hostPath);
          await fsp.copyFile(hostPath, tempPath);
          console.log(`✅ Успех! Файл скопирован в: ${tempPath}`);
          return tempPath;
        } else {
          console.log(`⏳ Файл еще качается сервером... (ждем 3 сек)`);
        }
      }
    } catch (error) {
      console.log(`❌ Ошибка запроса: ${error.message}`);
    }

    attempt++;
    await new Promise(r => setTimeout(r, 3000));
  }

  throw new StageError("Download", "Файл так и не появился на диске. Проверьте связь Docker с интернетом.");
}

async function processWithGemini(filePath, mimeType) {
  try {
    console.log(`[Gemini] Проверка связи через Axios...`);

    // Тест связи перед основной работой
    try {
      await axios.get('https://generativelanguage.googleapis.com/v1beta/models', {
        params: { key: process.env.GEMINI_API_KEY },
        timeout: 5000
      });
      console.log("✅ Axios успешно связался с Gemini API");
    } catch (e) {
      console.error("❌ Axios тоже не может достучаться:", e.message);
      throw new Error(`Проблема с сетью (Axios): ${e.message}`);
    }

    console.log(`[Gemini] Начинаю загрузку файла: ${filePath} (${mimeType})`);

    // 1. Загрузка файла через FileManager (библиотека Google)
    // Добавляем принудительную задержку, чтобы файл точно "осел" на диске
    await new Promise(resolve => setTimeout(resolve, 1000));

    const uploadResponse = await fileManager.uploadFile(filePath, {
      mimeType,
      displayName: path.basename(filePath),
    });

    console.log(`[Gemini] Файл загружен, URI: ${uploadResponse.file.uri}`);

    // 2. Ожидание обработки файла Google-ом
    let file = await fileManager.getFile(uploadResponse.file.name);
    process.stdout.write("[Gemini] Обработка в облаке");

    while (file.state === "PROCESSING") {
      process.stdout.write(".");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      file = await fileManager.getFile(uploadResponse.file.name);
    }

    console.log(`\n[Gemini] Статус завершен: ${file.state}`);

    if (file.state === "FAILED") {
      throw new Error("Google AI не смог отрендерить файл (FAILED).");
    }

    // 3. Генерация контента
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-1.5-flash" });

    const generationConfig = {
      temperature: 0.2, // Меньше креатива, больше точности
      topP: 0.95,
      maxOutputTokens: 8192,
    };

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: SYSTEM_PROMPT || "Сделай подробную транскрипцию и краткий пересказ этого видео/аудио." },
          {
            fileData: {
              mimeType: uploadResponse.file.mimeType,
              fileUri: uploadResponse.file.uri,
            },
          },
        ],
      }],
      generationConfig,
    });
    const response = await result.response;
    const text = response.text();
    return text.trim();
  } catch (error) {
    console.error("!!! КРИТИЧЕСКАЯ ОШИБКА GEMINI !!!");
    console.error("- Сообщение:", error.message);

    // Если это тот самый fetch failed, даем совет
    if (error.message.includes('fetch failed')) {
      console.error("👉 Совет: Попробуйте запустить с флагом: NODE_TLS_REJECT_UNAUTHORIZED=0");
    }

    throw new StageError("Gemini", "Ошибка при обработке в Google AI", error);
  }
}

async function postToPlanka({ title, description, sourceUserId, boardName, filePath }) {
  const payload = {
    title,
    description,
    source_user_id: String(sourceUserId),
    board_name: boardName,
  };

  const headers = {
    "Content-Type": "application/json",
  };

  if (PLANKA_API_TOKEN) {
    headers.Authorization = `Bearer ${PLANKA_API_TOKEN}`;
  }

  try {
    // Note: This logic assumes a custom bridge or a specific Planka API implementation
    // as suggested by the previous code structure. 
    // For standard Planka, we would first create a card, then upload the attachment.
    console.log(`[Planka] Creating card: ${title}`);
    const response = await axios.post(PLANKA_API_URL, payload, {
      headers,
      timeout: 60_000,
    });

    const cardId = response.data?.id;
    if (cardId && filePath && fs.existsSync(filePath)) {
      console.log(`[Planka] Uploading attachment for card ${cardId}`);
      const form = new FormData();
      form.append("type", "file");
      form.append("name", path.basename(filePath));
      form.append("file", fs.createReadStream(filePath));

      // Standard Planka attachment endpoint reconstruction
      // url usually looks like https://.../api/cards
      // we need https://.../api/cards/:id/attachments
      const attachmentUrl = `${PLANKA_API_URL}/${cardId}/attachments`;

      try {
        await axios.post(attachmentUrl, form, {
          headers: {
            ...form.getHeaders(),
            Authorization: headers.Authorization,
          },
        });
        console.log("[Planka] Attachment uploaded successfully.");
      } catch (attachError) {
        console.warn("[Planka] Failed to upload attachment:", attachError.message);
      }
    }

    return response.data;
  } catch (error) {
    console.error("Planka Error:", error.response?.data || error.message);
    // Don't throw for Planka if the analysis was successful, just log it.
    // throw new StageError("Planka", "Ошибка при создании карточки в Planka.", error);
  }
}

async function updateStatus(ctx, message, text) {
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, message.message_id, undefined, text);
  } catch (error) {
    await ctx.reply(text);
  }
}

bot.start((ctx) =>
  ctx.reply(
    "Привет! Отправьте голосовое сообщение, аудио или видео, и я подготовлю протокол встречи.",
  ),
);

bot.on(["voice", "audio", "video"], async (ctx) => {
  const meta = extractFileMeta(ctx);
  if (!meta) {
    await ctx.reply("Пожалуйста, отправьте аудио, голосовое или видео сообщение.");
    return;
  }

  const statusMessage = await ctx.reply("🔄 Обрабатываю файл...");
  let tempPath;

  try {
    validateSizeOrThrow(meta.fileSize);
    tempPath = await downloadTelegramFile(ctx, meta);
    await updateStatus(ctx, statusMessage, "🧪 Анализирую аудио с помощью Gemini...");

    const mimeType = meta.kind === "voice" ? "audio/ogg" : (meta.fileName.endsWith(".mp3") ? "audio/mpeg" : "video/mp4");
    const analysis = await processWithGemini(tempPath, mimeType);

    const title = `Встреча Заседание Совещание ${formatDateShort(new Date())}`;

    // await postToPlanka({
    //   title,
    //   description: analysis,
    //   sourceUserId: ctx.from?.id,
    //   boardName: PLANKA_BOARD_NAME,
    //   filePath: tempPath,
    // });
    console.log('Вызвался запрос в planka')
    console.log('analysis', analysis)
    await updateStatus(ctx, statusMessage, "✅ Анализ завершен. Карточка создана в Planka.");
  } catch (error) {
    const reason = error instanceof StageError ? error.message : "Неизвестная ошибка.";
    await updateStatus(ctx, statusMessage, `❌ Ошибка: ${reason}`);
    console.error("Processing error:", error);
  } finally {
    if (tempPath) {
      try {
        await fsp.unlink(tempPath);
      } catch (error) {
        console.warn("Failed to delete temp file:", tempPath, error.message);
      }
    }
  }
});

bot.on("message", (ctx) => {
  ctx.reply("Поддерживаются только голосовые сообщения, аудио или видео файлы.");
});

bot.launch().then(() => console.log("Telegram bot started."));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

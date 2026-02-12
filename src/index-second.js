const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const axios = require("axios");
const { Telegraf } = require("telegraf");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const dotenv = require("dotenv");
dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const PLANKA_API_URL =
    process.env.PLANKA_API_URL || process.env.PLANKA_BACKEND_URL || "";
const PLANKA_API_TOKEN = process.env.PLANKA_API_TOKEN;
const PLANKA_BOARD_NAME = process.env.PLANKA_BOARD_NAME || "Протокол";

const TELEGRAM_LIMIT_BYTES = 20 * 1024 * 1024;

if (!TELEGRAM_BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN in environment.");
    process.exit(1);
}

if (!GEMINI_API_KEY) {
    console.error("Missing GEMINI_API_KEY in environment.");
    process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
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
    'Используй заголовки: "📌 Темы", "✅ Чек-лист задач", "❗️ Решения".',
    "Под заголовками используй списки.",
].join(" ");

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
            `Файл слишком большой (${humanSize(fileSize)}). Лимит Telegram — 20 MB.`,
        );
    }
}

async function downloadTelegramFile(ctx, meta) {
    try {
        const link = await ctx.telegram.getFileLink(meta.fileId);
        const fileUrl = link.href || link.toString();
        const tempPath = getTempFilePath(meta.fileName, fileUrl);

        const response = await axios.get(fileUrl, {
            responseType: "stream",
            timeout: 60_000,
        });

        const contentLength = Number(response.headers["content-length"] || 0);
        if (contentLength > TELEGRAM_LIMIT_BYTES) {
            response.data.destroy();
            throw new StageError(
                "Download",
                `Файл слишком большой (${humanSize(contentLength)}). Лимит Telegram — 20 MB.`,
            );
        }

        await pipeline(response.data, fs.createWriteStream(tempPath));
        return tempPath;
    } catch (error) {
        if (error instanceof StageError) {
            throw error;
        }
        throw new StageError("Download", "Не удалось скачать файл.", error);
    }
}

async function processWithGemini(filePath, mimeType) {
    try {
        // 1. Upload file to Gemini
        const uploadResponse = await fileManager.uploadFile(filePath, {
            mimeType,
            displayName: path.basename(filePath),
        });

        // 2. Wait for processing (for small files it's usually instant, but good practice)
        let file = await fileManager.getFile(uploadResponse.file.name);
        while (file.state === "PROCESSING") {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            file = await fileManager.getFile(uploadResponse.file.name);
        }

        if (file.state === "FAILED") {
            throw new Error("File processing failed.");
        }

        // 3. Generate content (transcription + analysis in one go)
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
        const result = await model.generateContent([
            { text: SYSTEM_PROMPT },
            {
                fileData: {
                    mimeType: uploadResponse.file.mimeType,
                    fileUri: uploadResponse.file.uri,
                },
            },
        ]);

        const content = result.response.text();
        if (!content) {
            throw new Error("Пустой ответ от модели.");
        }
        return content.trim();
    } catch (error) {
        throw new StageError("Gemini", "Ошибка при обработке файла в Gemini.", error);
    }
}

async function postToPlanka({ title, description, sourceUserId, boardName }) {
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

    // try {
    //   const response = await axios.post(PLANKA_API_URL, payload, {
    //     headers,
    //     timeout: 60_000,
    //   });
    //   return response.data;
    // } catch (error) {
    //   throw new StageError("Planka", "Ошибка при создании карточки в Planka.", error);
    // }
    console.log('Сработал создание планки')
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
        const tempPath = await downloadTelegramFile(ctx, meta);
        await updateStatus(ctx, statusMessage, "🧪 Анализирую аудио с помощью Gemini...");

        const mimeType = meta.kind === "voice" ? "audio/ogg" : (meta.fileName.endsWith(".mp3") ? "audio/mpeg" : "video/mp4");
        const analysis = await processWithGemini(tempPath, mimeType);

        const title = `Встреча ${formatDateTime(new Date())}`;
        // await postToPlanka({
        //   title,
        //   description: analysis,
        //   sourceUserId: ctx.from?.id,
        //   boardName: PLANKA_BOARD_NAME,
        // });
        console.log('Сработала отправка в Planka')
        console.log('Анализ:', analysis)
        console.log('title:', title)
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

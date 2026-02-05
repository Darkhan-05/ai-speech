import 'dotenv/config';
import { Telegraf } from 'telegraf';
import Groq from 'groq-sdk';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

bot.start((ctx) => {
  ctx.reply('Привет! Пришли мне голосовое сообщение, аудио или видео файл, и я составлю протокол встречи.');
});

async function handleMedia(ctx, fileId, fileName) {
  try {
    await ctx.reply('Загружаю файл...');

    const file = await ctx.telegram.getFile(fileId);
    if (file.file_size > MAX_FILE_SIZE) {
      return ctx.reply('Файл слишком большой. Максимальный размер — 25МБ (ограничение Groq).');
    }

    const fileLink = await ctx.telegram.getFileLink(fileId);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-bot-'));
    const filePath = path.join(tempDir, fileName || `file_${fileId}`);

    const response = await axios({
      method: 'get',
      url: fileLink.href,
      responseType: 'stream',
    });

    await pipeline(response.data, fs.createWriteStream(filePath));

    await ctx.reply('Расшифровываю аудио...');

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-large-v3',
    });

    if (!transcription.text || transcription.text.trim().length === 0) {
      throw new Error('Transcription is empty');
    }

    await ctx.reply('Анализирую суть...');

    const analysis = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Ты — профессиональный ассистент по протоколированию встреч. Твоя задача — проанализировать транскрипцию и составить отчет на РУССКОМ языке:\n1. Краткое резюме встречи.\n2. Список задач (Action Items) с указанием ответственных.\n3. Ключевые решения.\nИспользуй Markdown-разметку.',
        },
        {
          role: 'user',
          content: transcription.text,
        },
      ],
      model: 'llama-3.3-70b-versatile',
    });

    const analysisText = analysis.choices[0]?.message?.content;
    if (!analysisText) {
      throw new Error('Analysis is empty');
    }

    return { analysisText, filePath, tempDir };
  } catch (error) {
    console.error('Error handling media:', error);
    await ctx.reply('Произошла ошибка при обработке файла.');
    throw error;
  }
}

bot.on(['voice', 'audio', 'video', 'document'], async (ctx) => {
  let fileId;
  let fileName;

  if (ctx.message.voice) {
    fileId = ctx.message.voice.file_id;
    fileName = 'voice.ogg';
  } else if (ctx.message.audio) {
    fileId = ctx.message.audio.file_id;
    fileName = ctx.message.audio.file_name || 'audio.mp3';
  } else if (ctx.message.video) {
    fileId = ctx.message.video.file_id;
    fileName = ctx.message.video.file_name || 'video.mp4';
  } else if (ctx.message.document) {
    const mimeType = ctx.message.document.mime_type || '';
    if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
      fileId = ctx.message.document.file_id;
      fileName = ctx.message.document.file_name;
    } else {
      return; // Ignore other documents
    }
  }

  if (fileId) {
    let tempDir;
    try {
      const result = await handleMedia(ctx, fileId, fileName);
      const { analysisText } = result;
      tempDir = result.tempDir;

      console.log('Analysis result:', analysisText);

      await ctx.reply(analysisText, { parse_mode: 'Markdown' });

      // Integration with Planka
      try {
        await axios.post(process.env.PLANKA_API_URL, {
          title: `Встреча ${new Date().toLocaleDateString('ru-RU')}`,
          description: analysisText,
          telegram_user_id: ctx.from.id,
          metadata: { platform: 'telegram_bot' }
        });
        await ctx.reply('Готово! Карточка в Planka создана.');
      } catch (plankaError) {
        console.error('Planka integration error:', plankaError.response?.data || plankaError.message);
        await ctx.reply('Анализ выполнен, но не удалось создать карточку в Planka.');
      }
    } catch (err) {
      console.error('Error in pipeline:', err);
      // If it's a Groq error (e.g. 413 or 404), handle it
      if (err.status === 413) {
        await ctx.reply('Файл слишком велик для обработки Groq.');
      } else if (err.status === 404) {
        await ctx.reply('Модель не найдена. Пожалуйста, проверьте настройки.');
      } else {
        await ctx.reply('Произошла ошибка при обработке аудио. Попробуйте позже.');
      }
    } finally {
      if (tempDir) {
        try {
          await fs.remove(tempDir);
        } catch (cleanupErr) {
          console.error('Failed to cleanup temp directory:', cleanupErr);
        }
      }
    }
  }
});

bot.launch();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

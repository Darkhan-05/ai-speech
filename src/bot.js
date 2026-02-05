const { Telegraf } = require('telegraf');
const path = require('path');
const fs = require('fs');
const { checkFileSize, downloadFile, deleteFile } = require('./utils/fileHandler');
const { transcribeAudio, analyzeTranscript } = require('./services/groq');
const { createTask } = require('./services/planka');

const setupBot = (token) => {
    const bot = new Telegraf(token);

    const handleMessage = async (ctx) => {
        let fileId, fileSize, fileUniqueId;
        const message = ctx.message;

        if (message.voice) {
            fileId = message.voice.file_id;
            fileSize = message.voice.file_size;
            fileUniqueId = message.voice.file_unique_id;
        } else if (message.audio) {
            fileId = message.audio.file_id;
            fileSize = message.audio.file_size;
            fileUniqueId = message.audio.file_unique_id;
        } else if (message.video) {
            fileId = message.video.file_id;
            fileSize = message.video.file_size;
            fileUniqueId = message.video.file_unique_id;
        } else if (message.video_note) {
            fileId = message.video_note.file_id;
            fileSize = message.video_note.file_size;
            fileUniqueId = message.video_note.file_unique_id;
        } else {
            return; // Not a supported media type
        }

        // 1. Check Size
        const sizeCheck = checkFileSize(fileSize);
        if (!sizeCheck.valid) {
            return ctx.reply(`❌ Ошибка: ${sizeCheck.message}`);
        }

        let localFilePath = null;

        try {
            // 2. Feedback
            await ctx.reply('🔄 Обрабатываю файл...');

            // 3. Download
            const fileLink = await ctx.telegram.getFileLink(fileId);
            const ext = path.extname(fileLink.href) || '.mp3'; // Default to mp3 if unknown, though link usually has it
            const timestamp = Date.now();
            localFilePath = path.join(__dirname, '../temp', `${timestamp}_${fileUniqueId}${ext}`);

            await downloadFile(fileLink.href, localFilePath);

            // 4. STT
            const transcript = await transcribeAudio(localFilePath);

            // 5. Feedback
            await ctx.reply('📝 Транскрибация завершена, анализирую смыслы...');

            // 6. LLM
            const analysis = await analyzeTranscript(transcript);

            // 7. Planka
            const date = new Date();
            const formattedDate = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

            const taskData = {
                title: `Встреча [${formattedDate}]`,
                description: analysis,
                source_user_id: String(ctx.from.id),
                board_name: process.env.PLANKA_BOARD_NAME || 'Протокол'
            };

            await createTask(taskData);

            // 8. Success
            await ctx.reply('✅ Карточка создана в Planka.');

        } catch (error) {
            console.error('Error processing message:', error);
            await ctx.reply(`❌ Ошибка: ${error.message}`);
        } finally {
            // 9. Cleanup
            if (localFilePath) {
                await deleteFile(localFilePath);
            }
        }
    };

    bot.on(['voice', 'audio', 'video', 'video_note'], handleMessage);

    return bot;
};

module.exports = setupBot;

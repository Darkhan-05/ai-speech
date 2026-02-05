const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
require('dotenv').config();

const GROQ_API_URL = 'https://api.groq.com/openai/v1';

/**
 * Transcribes audio file using Groq Whisper model.
 * @param {string} filePath - Path to the audio file.
 * @returns {Promise<string>} - Transcribed text.
 */
const transcribeAudio = async (filePath) => {
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY is not defined');
    }

    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('model', 'whisper-large-v3');

    try {
        const response = await axios.post(`${GROQ_API_URL}/audio/transcriptions`, formData, {
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                ...formData.getHeaders()
            }
        });
        return response.data.text;
    } catch (error) {
        console.error('Error during transcription:', error.response ? error.response.data : error.message);
        throw error;
    }
};

/**
 * Analyzes transcript using Groq LLM.
 * @param {string} transcript - Transcribed text.
 * @returns {Promise<string>} - Analyzed insights.
 */
const analyzeTranscript = async (transcript) => {
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY is not defined');
    }

    const systemPrompt = "You are a helpful assistant. Output must be in Russian with headers: 📌 Темы, ✅ Чек-лист задач, and ❗️ Решения.";

    try {
        const response = await axios.post(`${GROQ_API_URL}/chat/completions`, {
            model: 'llama-3-70b-8192',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: transcript }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('Error during analysis:', error.response ? error.response.data : error.message);
        throw error;
    }
};

module.exports = {
    transcribeAudio,
    analyzeTranscript
};

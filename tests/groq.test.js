const nock = require('nock');
const path = require('path');
const fs = require('fs');
const { transcribeAudio, analyzeTranscript } = require('../src/services/groq');

// Mock environment variables
process.env.GROQ_API_KEY = 'test-key';

describe('Groq Service', () => {
    afterEach(() => {
        nock.cleanAll();
    });

    test('transcribeAudio should return text', async () => {
        const filePath = path.join(__dirname, 'test_audio.mp3');
        fs.writeFileSync(filePath, 'dummy content');

        nock('https://api.groq.com')
            .post('/openai/v1/audio/transcriptions')
            .reply(200, { text: 'Hello world' });

        const result = await transcribeAudio(filePath);
        expect(result).toBe('Hello world');

        // Cleanup
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    });

    test('analyzeTranscript should return analysis', async () => {
        nock('https://api.groq.com')
            .post('/openai/v1/chat/completions')
            .reply(200, {
                choices: [{
                    message: {
                        content: 'Analysis Result'
                    }
                }]
            });

        const result = await analyzeTranscript('Hello world');
        expect(result).toBe('Analysis Result');
    });
});

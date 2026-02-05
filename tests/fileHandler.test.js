const { checkFileSize } = require('../src/utils/fileHandler');

describe('File Handler Utilities', () => {
    test('checkFileSize should return valid for small files', () => {
        const result = checkFileSize(1024);
        expect(result.valid).toBe(true);
    });

    test('checkFileSize should return invalid for files > 20MB', () => {
        const result = checkFileSize(21 * 1024 * 1024);
        expect(result.valid).toBe(false);
        expect(result.message).toContain('Telegram bot download');
    });

    test('checkFileSize should return invalid for files > 25MB', () => {
        const result = checkFileSize(26 * 1024 * 1024);
        expect(result.valid).toBe(false);
        expect(result.message).toContain('Telegram bot download');
    });
});

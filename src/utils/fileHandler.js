const fs = require('fs');
const axios = require('axios');
const path = require('path');

// Constants
const TELEGRAM_MAX_SIZE = 20 * 1024 * 1024; // 20 MB
const GROQ_MAX_SIZE = 25 * 1024 * 1024; // 25 MB

/**
 * Checks if the file size is within limits.
 * @param {number} fileSize - Size of the file in bytes.
 * @returns {Object} - { valid: boolean, message: string }
 */
const checkFileSize = (fileSize) => {
    if (fileSize > TELEGRAM_MAX_SIZE) {
        return { valid: false, message: 'File is too large for Telegram bot download (Max 20MB).' };
    }
    if (fileSize > GROQ_MAX_SIZE) {
        return { valid: false, message: 'File is too large for Groq API (Max 25MB).' };
    }
    return { valid: true };
};

/**
 * Downloads a file from a URL to a local path.
 * @param {string} url - The URL to download from.
 * @param {string} filepath - The local path to save the file.
 * @returns {Promise<void>}
 */
const downloadFile = async (url, filepath) => {
    // Ensure directory exists
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir, { recursive: true });
    }

    const writer = fs.createWriteStream(filepath);

    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
};

/**
 * Deletes a file from the filesystem.
 * @param {string} filepath - The path of the file to delete.
 * @returns {Promise<void>}
 */
const deleteFile = async (filepath) => {
    try {
        if (fs.existsSync(filepath)) {
            await fs.promises.unlink(filepath);
        }
    } catch (error) {
        console.error(`Error deleting file ${filepath}:`, error);
    }
};

module.exports = {
    checkFileSize,
    downloadFile,
    deleteFile
};

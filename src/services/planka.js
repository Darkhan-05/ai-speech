const axios = require('axios');
require('dotenv').config();

/**
 * Creates a task in Planka.
 * @param {Object} data - The task data.
 * @param {string} data.title - Title of the task.
 * @param {string} data.description - Description (Markdown formatted).
 * @param {string} data.source_user_id - Telegram User ID.
 * @param {string} data.board_name - Name of the board.
 * @returns {Promise<Object>} - Response from Planka.
 */
const createTask = async (data) => {
    const PLANKA_BACKEND_URL = process.env.PLANKA_BACKEND_URL;
    if (!PLANKA_BACKEND_URL) {
        throw new Error('PLANKA_BACKEND_URL is not defined');
    }

    try {
        const response = await axios.post(PLANKA_BACKEND_URL, data, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error creating task in Planka:', error.response ? error.response.data : error.message);
        throw error;
    }
};

module.exports = {
    createTask
};

const nock = require('nock');
const { createTask } = require('../src/services/planka');

// Mock environment variables
process.env.PLANKA_BACKEND_URL = 'https://planka.example.com/api';

describe('Planka Service', () => {
    afterEach(() => {
        nock.cleanAll();
    });

    test('createTask should post data and return response', async () => {
        const taskData = {
            title: 'Test Task',
            description: 'Desc',
            source_user_id: '123',
            board_name: 'Board'
        };

        nock('https://planka.example.com')
            .post('/api', taskData)
            .reply(200, { id: 'card-1' });

        const result = await createTask(taskData);
        expect(result).toEqual({ id: 'card-1' });
    });
});

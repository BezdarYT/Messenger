const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { Pool } = require('pg');
const crypto = require('crypto');

app.use(express.static('public'));
app.use(express.json());

// Подключение к PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ============ Инициализация таблиц ============
const initDB = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            display_name VARCHAR(100),
            recovery_code VARCHAR(20),
            created_at TIMESTAMP DEFAULT NOW()
        );
        
        CREATE TABLE IF NOT EXISTS device_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            token VARCHAR(255) UNIQUE NOT NULL,
            device_name VARCHAR(100),
            last_seen TIMESTAMP DEFAULT NOW(),
            created_at TIMESTAMP DEFAULT NOW()
        );
        
        CREATE TABLE IF NOT EXISTS rooms (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100),
            type VARCHAR(20) DEFAULT 'group',
            creator_id INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT NOW()
        );
        
        CREATE TABLE IF NOT EXISTS room_participants (
            room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            joined_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (room_id, user_id)
        );
        
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id),
            username VARCHAR(50),
            text TEXT NOT NULL,
            time VARCHAR(20),
            created_at TIMESTAMP DEFAULT NOW()
        );
        
        CREATE TABLE IF NOT EXISTS password_resets (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            code VARCHAR(255) NOT NULL,
            expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '1 hour',
            used BOOLEAN DEFAULT FALSE
        );
    `);
    
    // Создаём общий чат, если его нет
    const generalRoom = await pool.query(`
        INSERT INTO rooms (id, name, type, creator_id)
        SELECT 1, 'Общий чат', 'group', NULL
        WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE id = 1)
    `);
    
    console.log('База данных готова');
};
initDB();

// ============ Вспомогательные функции ============
function validateUsername(username) {
    return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

function validatePassword(password) {
    return /^[a-zA-Z0-9]{4,50}$/.test(password);
}

function validateEmail(email) {
    return /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/.test(email);
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateRecoveryCode() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ============ API ============

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, password, email, displayName, deviceName } = req.body;
    
    if (!validateUsername(username)) {
        return res.status(400).json({ error: 'Юзернейм: только англ. буквы, цифры и _, 3-20 символов' });
    }
    if (!validatePassword(password)) {
        return res.status(400).json({ error: 'Пароль: только англ. буквы и цифры, 4-50 символов' });
    }
    if (!validateEmail(email)) {
        return res.status(400).json({ error: 'Неверный формат email' });
    }
    
    try {
        const recoveryCode = generateRecoveryCode();
        
        const result = await pool.query(
            `INSERT INTO users (username, password, email, display_name, recovery_code)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, username, display_name, email`,
            [username, password, email, displayName || username, recoveryCode]
        );
        
        const user = result.rows[0];
        const token = generateToken();
        
        await pool.query(
            `INSERT INTO device_tokens (user_id, token, device_name)
             VALUES ($1, $2, $3)`,
            [user.id, token, deviceName || 'Неизвестное устройство']
        );
        
        // Добавляем в общий чат
        await pool.query(
            `INSERT INTO room_participants (room_id, user_id)
             VALUES (1, $1) ON CONFLICT DO NOTHING`,
            [user.id]
        );
        
        res.json({
            success: true,
            user: { id: user.id, username: user.username, displayName: user.display_name, email: user.email },
            token: token,
            recoveryCode: recoveryCode
        });
    } catch (err) {
        if (err.code === '23505') {
            res.status(400).json({ error: 'Юзернейм или email уже занят' });
        } else {
            console.error(err);
            res.status(500).json({ error: 'Ошибка регистрации' });
        }
    }
});

// Вход
app.post('/api/login', async (req, res) => {
    const { username, password, deviceName } = req.body;
    
    try {
        const result = await pool.query(
            `SELECT id, username, display_name, email FROM users 
             WHERE username = $1 AND password = $2`,
            [username, password]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        
        const user = result.rows[0];
        const token = generateToken();
        
        await pool.query(
            `INSERT INTO device_tokens (user_id, token, device_name)
             VALUES ($1, $2, $3)`,
            [user.id, token, deviceName || 'Неизвестное устройство']
        );
        
        res.json({
            success: true,
            user: { id: user.id, username: user.username, displayName: user.display_name, email: user.email },
            token
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка входа' });
    }
});

// Автоматический вход по токену
app.post('/api/auto-login', async (req, res) => {
    const { token, deviceName } = req.body;
    
    try {
        const deviceResult = await pool.query(
            `SELECT user_id FROM device_tokens WHERE token = $1`,
            [token]
        );
        
        if (deviceResult.rows.length === 0) {
            return res.status(401).json({ error: 'Сессия истекла' });
        }
        
        const userResult = await pool.query(
            `SELECT id, username, display_name, email FROM users WHERE id = $1`,
            [deviceResult.rows[0].user_id]
        );
        
        const user = userResult.rows[0];
        
        // Обновляем время последнего использования
        await pool.query(
            `UPDATE device_tokens SET last_seen = NOW() WHERE token = $1`,
            [token]
        );
        
        res.json({
            success: true,
            user: { id: user.id, username: user.username, displayName: user.display_name, email: user.email },
            token
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка' });
    }
});

// Восстановление пароля - запрос кода
app.post('/api/request-reset', async (req, res) => {
    const { email } = req.body;
    
    try {
        const userResult = await pool.query(
            `SELECT id, recovery_code FROM users WHERE email = $1`,
            [email]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Email не найден' });
        }
        
        const user = userResult.rows[0];
        
        // В реальном проекте здесь отправляется письмо
        res.json({
            success: true,
            message: 'Код восстановления отправлен на email',
            recoveryCode: user.recovery_code
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка' });
    }
});

// Восстановление пароля - смена
app.post('/api/reset-password', async (req, res) => {
    const { email, recoveryCode, newPassword } = req.body;
    
    if (!validatePassword(newPassword)) {
        return res.status(400).json({ error: 'Пароль: только англ. буквы и цифры, 4-50 символов' });
    }
    
    try {
        const userResult = await pool.query(
            `SELECT id FROM users WHERE email = $1 AND recovery_code = $2`,
            [email, recoveryCode]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: 'Неверный email или код' });
        }
        
        const user = userResult.rows[0];
        const newRecoveryCode = generateRecoveryCode();
        
        await pool.query(
            `UPDATE users SET password = $1, recovery_code = $2 WHERE id = $3`,
            [newPassword, newRecoveryCode, user.id]
        );
        
        // Удаляем все токены для безопасности
        await pool.query(`DELETE FROM device_tokens WHERE user_id = $1`, [user.id]);
        
        res.json({ success: true, message: 'Пароль изменён' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка' });
    }
});

// Получить комнаты пользователя
app.get('/api/rooms/:userId', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.*, 
                   (SELECT COUNT(*) FROM room_participants WHERE room_id = r.id) as participants_count
            FROM rooms r
            JOIN room_participants rp ON r.id = rp.room_id
            WHERE rp.user_id = $1
            ORDER BY r.created_at DESC
        `, [req.params.userId]);
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка' });
    }
});

// Получить историю сообщений
app.get('/api/messages/:roomId', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 200`,
            [req.params.roomId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка' });
    }
});

// Получить список устройств
app.get('/api/devices/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT device_name, last_seen FROM device_tokens WHERE user_id = $1`,
            [req.params.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка' });
    }
});

// Выход с устройства
app.post('/api/logout-device', async (req, res) => {
    const { token } = req.body;
    
    try {
        await pool.query(`DELETE FROM device_tokens WHERE token = $1`, [token]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка' });
    }
});

// ============ SOCKET.IO ============
const onlineUsers = new Map(); // socketId -> { userId, username, displayName }

io.on('connection', (socket) => {
    console.log('Socket подключён');

    socket.on('auth', async ({ userId, username, displayName, token }) => {
        try {
            // Проверяем токен
            const deviceResult = await pool.query(
                `SELECT user_id FROM device_tokens WHERE token = $1 AND user_id = $2`,
                [token, userId]
            );
            
            if (deviceResult.rows.length === 0) {
                socket.emit('auth_error', 'Сессия истекла');
                return;
            }
            
            onlineUsers.set(socket.id, { userId, username, displayName });
            
            // Получаем комнаты пользователя
            const roomsResult = await pool.query(`
                SELECT r.*, 
                       (SELECT COUNT(*) FROM room_participants WHERE room_id = r.id) as participants_count
                FROM rooms r
                JOIN room_participants rp ON r.id = rp.room_id
                WHERE rp.user_id = $1
                ORDER BY r.created_at DESC
            `, [userId]);
            
            socket.emit('rooms list', roomsResult.rows);
            
            // Если есть комнаты, заходим в первую
            if (roomsResult.rows.length > 0) {
                const firstRoom = roomsResult.rows[0];
                const messagesResult = await pool.query(
                    `SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 200`,
                    [firstRoom.id]
                );
                socket.emit('chat history', messagesResult.rows);
                socket.join(`room_${firstRoom.id}`);
            }
            
            updateOnlineList();
        } catch (err) {
            console.error(err);
        }
    });

    // Создание группы
    socket.on('create group', async ({ name, userId, username }) => {
        try {
            const result = await pool.query(
                `INSERT INTO rooms (name, type, creator_id) VALUES ($1, 'group', $2) RETURNING *`,
                [name || `Чат ${Date.now()}`, userId]
            );
            
            const room = result.rows[0];
            
            await pool.query(
                `INSERT INTO room_participants (room_id, user_id) VALUES ($1, $2)`,
                [room.id, userId]
            );
            
            const newRoom = {
                id: room.id,
                name: room.name,
                type: room.type,
                creator_id: room.creator_id,
                participants_count: 1
            };
            
            io.emit('group created', newRoom);
            
            socket.emit('system message', {
                text: `✅ Вы создали чат "${newRoom.name}"`,
                time: new Date().toLocaleTimeString()
            });
        } catch (err) {
            console.error(err);
            socket.emit('error', 'Не удалось создать группу');
        }
    });

    // Создание личного чата
    socket.on('create dm', async ({ targetUserId, userId, username }) => {
        try {
            // Проверяем, есть ли уже личный чат
            const existing = await pool.query(`
                SELECT r.id FROM rooms r
                JOIN room_participants rp1 ON r.id = rp1.room_id AND rp1.user_id = $1
                JOIN room_participants rp2 ON r.id = rp2.room_id AND rp2.user_id = $2
                WHERE r.type = 'dm'
            `, [userId, targetUserId]);
            
            if (existing.rows.length > 0) {
                socket.emit('dm_exists', { roomId: existing.rows[0].id });
                return;
            }
            
            const userResult = await pool.query(
                `SELECT username FROM users WHERE id = $1`,
                [targetUserId]
            );
            const targetUsername = userResult.rows[0]?.username || 'пользователь';
            
            const result = await pool.query(
                `INSERT INTO rooms (name, type, creator_id) VALUES ($1, 'dm', $2) RETURNING *`,
                [`Чат с ${targetUsername}`, userId]
            );
            
            const room = result.rows[0];
            
            await pool.query(
                `INSERT INTO room_participants (room_id, user_id) VALUES ($1, $2), ($1, $3)`,
                [room.id, userId, targetUserId]
            );
            
            const newRoom = {
                id: room.id,
                name: room.name,
                type: 'dm',
                participants_count: 2
            };
            
            io.emit('dm created', newRoom);
        } catch (err) {
            console.error(err);
            socket.emit('error', 'Не удалось создать чат');
        }
    });

    // Удаление группы
    socket.on('delete group', async ({ roomId, userId }) => {
        try {
            const roomResult = await pool.query(
                `SELECT creator_id FROM rooms WHERE id = $1`,
                [roomId]
            );
            
            if (roomResult.rows.length === 0 || roomResult.rows[0].creator_id !== userId) {
                socket.emit('error', '❌ Только создатель может удалить чат');
                return;
            }
            
            await pool.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
            
            io.emit('group deleted', roomId);
        } catch (err) {
            console.error(err);
            socket.emit('error', 'Не удалось удалить чат');
        }
    });

    // Присоединение к комнате
    socket.on('join room', async ({ roomId, userId }) => {
        try {
            const roomResult = await pool.query(
                `SELECT * FROM rooms WHERE id = $1`,
                [roomId]
            );
            
            if (roomResult.rows.length === 0) return;
            const room = roomResult.rows[0];
            
            const participantResult = await pool.query(
                `SELECT * FROM room_participants WHERE room_id = $1 AND user_id = $2`,
                [roomId, userId]
            );
            
            if (participantResult.rows.length === 0) {
                socket.emit('error', 'Вы не участник этого чата');
                return;
            }
            
            // Покидаем старую комнату
            for (const [sockId, sess] of onlineUsers) {
                if (sess.userId === userId) {
                    const rooms = Array.from(io.sockets.sockets.get(sockId)?.rooms || []);
                    rooms.forEach(r => {
                        if (r.startsWith('room_')) {
                            io.sockets.sockets.get(sockId)?.leave(r);
                        }
                    });
                }
            }
            
            socket.join(`room_${roomId}`);
            
            const messagesResult = await pool.query(
                `SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 200`,
                [roomId]
            );
            socket.emit('chat history', messagesResult.rows);
            
            socket.emit('system message', {
                text: `📁 Вы перешли в чат "${room.name}"`,
                time: new Date().toLocaleTimeString()
            });
            
            updateOnlineList();
        } catch (err) {
            console.error(err);
        }
    });

    // Отправка сообщения
    socket.on('send message', async ({ roomId, text, userId, username }) => {
        try {
            const result = await pool.query(
                `INSERT INTO messages (room_id, user_id, username, text, time)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [roomId, userId, username, text, new Date().toLocaleTimeString()]
            );
            
            const message = result.rows[0];
            
            io.to(`room_${roomId}`).emit('new message', message);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        updateOnlineList();
        console.log('Пользователь отключился');
    });
    
    function updateOnlineList() {
        const online = Array.from(onlineUsers.values());
        io.emit('online users', online);
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Сервер на порту ${PORT}`));

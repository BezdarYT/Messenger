const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));
app.use(express.json());

// ============ Хранилища данных ============
const users = new Map();        // userId -> { username, password, displayName, createdAt }
const sessions = new Map();     // socketId -> { userId, username, currentRoomId }
let nextUserId = 1;

const rooms = new Map();        // roomId -> { id, name, creatorId, createdAt, members: Set, messages: [] }
let nextRoomId = 1;

// Создаём общий чат по умолчанию
rooms.set('1', {
    id: '1',
    name: 'Общий чат',
    creatorId: null,
    creatorName: 'system',
    createdAt: Date.now(),
    members: new Set(),
    messages: []
});

// ============ API ============

// Регистрация
app.post('/api/register', (req, res) => {
    const { username, password, displayName } = req.body;
    
    // Проверяем, существует ли пользователь
    for (const user of users.values()) {
        if (user.username === username) {
            return res.status(400).json({ error: 'Юзернейм уже занят' });
        }
    }
    
    const userId = String(nextUserId++);
    users.set(userId, {
        id: userId,
        username: username,
        password: password,
        displayName: displayName || username,
        createdAt: Date.now()
    });
    
    res.json({ success: true, user: { id: userId, username, displayName: displayName || username } });
});

// Вход
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    for (const user of users.values()) {
        if (user.username === username && user.password === password) {
            return res.json({ 
                success: true, 
                user: { id: user.id, username: user.username, displayName: user.displayName } 
            });
        }
    }
    
    res.status(401).json({ error: 'Неверный логин или пароль' });
});

// Получить комнаты пользователя
app.get('/api/rooms/:userId', (req, res) => {
    const userRooms = [];
    for (const room of rooms.values()) {
        if (room.members.has(req.params.userId)) {
            userRooms.push({
                id: room.id,
                name: room.name,
                creatorId: room.creatorId,
                creatorName: room.creatorName,
                membersCount: room.members.size,
                messagesCount: room.messages.length
            });
        }
    }
    res.json(userRooms);
});

// ============ SOCKET.IO ============

io.on('connection', (socket) => {
    console.log('Пользователь подключился');

    // Аутентификация
    socket.on('auth', ({ userId, username, displayName }) => {
        sessions.set(socket.id, { userId, username, displayName, currentRoomId: null });
        
        // Находим комнаты пользователя
        const userRooms = [];
        for (const room of rooms.values()) {
            if (room.members.has(userId)) {
                userRooms.push({
                    id: room.id,
                    name: room.name,
                    creatorId: room.creatorId,
                    creatorName: room.creatorName,
                    membersCount: room.members.size
                });
            }
        }
        
        socket.emit('rooms list', userRooms);
        
        // Если есть комнаты, заходим в первую
        if (userRooms.length > 0) {
            const firstRoom = userRooms[0];
            const session = sessions.get(socket.id);
            session.currentRoomId = firstRoom.id;
            socket.join(`room_${firstRoom.id}`);
            
            // Отправляем историю
            const room = rooms.get(firstRoom.id);
            socket.emit('chat history', room.messages);
        }
        
        updateOnlineList();
    });

    // Создание группы
    socket.on('create group', ({ name, userId, username }) => {
        const roomId = String(nextRoomId++);
        
        rooms.set(roomId, {
            id: roomId,
            name: name || `Чат ${roomId}`,
            creatorId: userId,
            creatorName: username,
            createdAt: Date.now(),
            members: new Set([userId]),
            messages: []
        });
        
        // Добавляем пользователя в комнату
        const session = sessions.get(socket.id);
        if (session) {
            if (session.currentRoomId) {
                socket.leave(`room_${session.currentRoomId}`);
            }
            session.currentRoomId = roomId;
            socket.join(`room_${roomId}`);
        }
        
        // Отправляем историю (пустую)
        socket.emit('chat history', []);
        
        const newRoom = {
            id: roomId,
            name: name || `Чат ${roomId}`,
            creatorId: userId,
            creatorName: username,
            membersCount: 1
        };
        
        // Уведомляем всех о новой группе
        io.emit('group created', newRoom);
        
        socket.emit('system message', {
            text: `✅ Вы создали чат "${newRoom.name}"`,
            time: new Date().toLocaleTimeString()
        });
        
        updateOnlineList();
    });

    // Удаление группы (только создатель)
    socket.on('delete group', ({ roomId, userId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        // Проверяем, создатель ли
        if (room.creatorId !== userId) {
            socket.emit('error', '❌ Только создатель может удалить чат');
            return;
        }
        
        // Удаляем комнату
        rooms.delete(roomId);
        
        // Уведомляем всех
        io.emit('group deleted', roomId);
        
        // Перенаправляем пользователей, которые были в этой комнате
        for (const [sockId, session] of sessions) {
            if (session.currentRoomId === roomId) {
                const defaultRoom = rooms.get('1');
                if (defaultRoom) {
                    session.currentRoomId = '1';
                    const sock = io.sockets.sockets.get(sockId);
                    if (sock) {
                        sock.leave(`room_${roomId}`);
                        sock.join(`room_1`);
                        sock.emit('chat history', defaultRoom.messages);
                        sock.emit('system message', {
                            text: `📁 Чат "${room.name}" был удалён, вы перемещены в общий чат`,
                            time: new Date().toLocaleTimeString()
                        });
                    }
                }
            }
        }
        
        updateOnlineList();
    });

    // Присоединение к комнате
    socket.on('join room', ({ roomId, userId }) => {
        const session = sessions.get(socket.id);
        if (!session) return;
        
        const room = rooms.get(roomId);
        if (!room) return;
        
        // Добавляем пользователя в комнату, если его там нет
        if (!room.members.has(userId)) {
            room.members.add(userId);
        }
        
        // Покидаем старую комнату
        if (session.currentRoomId) {
            socket.leave(`room_${session.currentRoomId}`);
        }
        
        session.currentRoomId = roomId;
        socket.join(`room_${roomId}`);
        
        // Отправляем историю
        socket.emit('chat history', room.messages);
        
        socket.emit('system message', {
            text: `📁 Вы перешли в чат "${room.name}"`,
            time: new Date().toLocaleTimeString()
        });
        
        updateOnlineList();
        updateRoomList();
    });

    // Отправка сообщения
    socket.on('send message', ({ roomId, text, userId, username }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        const message = {
            id: Date.now(),
            userId: userId,
            username: username,
            text: text,
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now()
        };
        
        room.messages.push(message);
        
        // Ограничиваем историю 200 сообщениями
        if (room.messages.length > 200) {
            room.messages.shift();
        }
        
        // Отправляем всем в комнате
        io.to(`room_${roomId}`).emit('new message', message);
    });

    // Отключение
    socket.on('disconnect', () => {
        sessions.delete(socket.id);
        updateOnlineList();
        console.log('Пользователь отключился');
    });
    
    function updateOnlineList() {
        const online = [];
        for (const session of sessions.values()) {
            const room = rooms.get(session.currentRoomId);
            online.push({
                userId: session.userId,
                username: session.username,
                displayName: session.displayName,
                roomId: session.currentRoomId,
                roomName: room?.name || 'Неизвестно'
            });
        }
        io.emit('online users', online);
    }
    
    function updateRoomList() {
        const roomList = [];
        for (const room of rooms.values()) {
            roomList.push({
                id: room.id,
                name: room.name,
                creatorId: room.creatorId,
                creatorName: room.creatorName,
                membersCount: room.members.size
            });
        }
        io.emit('rooms list update', roomList);
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Сервер на порту ${PORT}`));

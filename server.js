const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// Хранилище данных
const users = {};        // { socketId: { username, currentRoom } }
const rooms = {          // { roomId: { name, messages, members } }
    'general': {
        name: 'Общий чат',
        messages: [],
        members: new Set()
    }
};
let nextRoomId = 1;

io.on('connection', (socket) => {
    console.log('Пользователь подключился');

    // Вход пользователя
    socket.on('user join', ({ username, roomId = 'general' }) => {
        users[socket.id] = { username, currentRoom: roomId };
        
        // Добавляем в комнату
        if (!rooms[roomId]) {
            rooms[roomId] = {
                name: `Чат ${nextRoomId++}`,
                messages: [],
                members: new Set()
            };
        }
        rooms[roomId].members.add(socket.id);
        socket.join(roomId);
        
        // Отправляем историю комнаты
        socket.emit('chat history', rooms[roomId].messages);
        
        // Уведомляем всех в комнате
        socket.to(roomId).emit('system message', {
            text: `${username} присоединился`,
            time: new Date().toLocaleTimeString()
        });
        
        // Обновляем списки
        updateUserList();
        updateRoomList();
    });

    // Создание новой комнаты
    socket.on('create room', (roomName) => {
        const user = users[socket.id];
        if (user) {
            const roomId = `room_${Date.now()}`;
            rooms[roomId] = {
                name: roomName || `Чат ${nextRoomId++}`,
                messages: [],
                members: new Set([socket.id])
            };
            socket.join(roomId);
            user.currentRoom = roomId;
            
            updateRoomList();
            socket.emit('room created', { roomId, name: rooms[roomId].name });
        }
    });

    // Переключение комнаты
    socket.on('switch room', (roomId) => {
        const user = users[socket.id];
        if (user && rooms[roomId]) {
            // Выход из старой комнаты
            socket.leave(user.currentRoom);
            rooms[user.currentRoom]?.members.delete(socket.id);
            
            // Вход в новую
            user.currentRoom = roomId;
            rooms[roomId].members.add(socket.id);
            socket.join(roomId);
            
            // Отправляем историю новой комнаты
            socket.emit('chat history', rooms[roomId].messages);
            
            // Уведомляем
            socket.emit('system message', {
                text: `Вы перешли в чат "${rooms[roomId].name}"`,
                time: new Date().toLocaleTimeString()
            });
            
            updateUserList();
        }
    });

    // Отправка сообщения
    socket.on('chat message', ({ text }) => {
        const user = users[socket.id];
        if (user && rooms[user.currentRoom]) {
            const message = {
                user: user.username,
                text: text,
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now()
            };
            rooms[user.currentRoom].messages.push(message);
            
            // Ограничиваем историю 100 сообщениями
            if (rooms[user.currentRoom].messages.length > 100) {
                rooms[user.currentRoom].messages.shift();
            }
            
            io.to(user.currentRoom).emit('chat message', message);
        }
    });

    // Отключение
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            rooms[user.currentRoom]?.members.delete(socket.id);
            delete users[socket.id];
            updateUserList();
            updateRoomList();
            
            io.emit('system message', {
                text: `${user.username} покинул чат`,
                time: new Date().toLocaleTimeString()
            });
        }
    });
    
    function updateUserList() {
        const list = Object.values(users).map(u => ({
            username: u.username,
            room: u.currentRoom
        }));
        io.emit('user list', list);
    }
    
    function updateRoomList() {
        const roomList = Object.entries(rooms).map(([id, room]) => ({
            id: id,
            name: room.name,
            members: room.members.size
        }));
        io.emit('room list', roomList);
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Сервер на порту ${PORT}`));

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

io.on('connection', (socket) => {
    console.log('Пользователь подключился');

    // Вход пользователя
    socket.on('user join', ({ username, roomId = 'general' }) => {
        users[socket.id] = { username, currentRoom: roomId };
        
        // Добавляем в комнату
        if (!rooms[roomId]) {
            rooms[roomId] = {
                name: 'Новый чат',
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

    // СОЗДАНИЕ НОВОЙ КОМНАТЫ (ВОТ ЭТО БЫЛО ПРОПУЩЕНО!)
    socket.on('create room', (roomName) => {
        const user = users[socket.id];
        if (user) {
            const roomId = `room_${Date.now()}`;
            rooms[roomId] = {
                name: roomName || `Чат ${Object.keys(rooms).length}`,
                messages: [],
                members: new Set([socket.id])
            };
            
            // Выходим из старой комнаты
            const oldRoom = user.currentRoom;
            if (oldRoom && rooms[oldRoom]) {
                rooms[oldRoom].members.delete(socket.id);
                socket.leave(oldRoom);
            }
            
            // Входим в новую
            user.currentRoom = roomId;
            socket.join(roomId);
            
            // Отправляем историю (пустую)
            socket.emit('chat history', []);
            
            // Уведомление о создании
            socket.emit('system message', {
                text: `Вы создали чат "${rooms[roomId].name}"`,
                time: new Date().toLocaleTimeString()
            });
            
            // Обновляем списки для всех
            updateRoomList();
            updateUserList();
            
            // Отправляем событие о создании комнаты
            socket.emit('room created', { roomId, name: rooms[roomId].name });
        }
    });

    // Переключение комнаты
    socket.on('switch room', (roomId) => {
        const user = users[socket.id];
        if (user && rooms[roomId]) {
            // Выход из старой комнаты
            if (user.currentRoom && rooms[user.currentRoom]) {
                rooms[user.currentRoom].members.delete(socket.id);
                socket.leave(user.currentRoom);
            }
            
            // Вход в новую
            user.currentRoom = roomId;
            rooms[roomId].members.add(socket.id);
            socket.join(roomId);
            
            // Отправляем историю новой комнаты
            socket.emit('chat history', rooms[roomId].messages);
            
            // Уведомление
            socket.emit('system message', {
                text: `Вы перешли в чат "${rooms[roomId].name}"`,
                time: new Date().toLocaleTimeString()
            });
            
            updateUserList();
            updateRoomList();
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
            if (user.currentRoom && rooms[user.currentRoom]) {
                rooms[user.currentRoom].members.delete(socket.id);
            }
            delete users[socket.id];
            updateUserList();
            updateRoomList();
            
            io.emit('system message', {
                text: `${user.username} покинул чат`,
                time: new Date().toLocaleTimeString()
            });
        }
        console.log('Пользователь отключился');
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
http.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));

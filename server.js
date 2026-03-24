const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// Храним пользователей: { socketId: { username, currentChatWith } }
const users = {};

io.on('connection', (socket) => {
    console.log('Новый пользователь подключился');

    // Пользователь входит с именем
    socket.on('user join', (username) => {
        users[socket.id] = { 
            username: username, 
            currentChatWith: null,
            socketId: socket.id
        };
        
        // Отправляем подтверждение
        socket.emit('joined', { username });
        
        // Обновляем список пользователей для всех
        updateUserList();
        
        // Системное сообщение
        socket.broadcast.emit('system message', {
            text: `${username} присоединился к чату`,
            time: new Date().toLocaleTimeString()
        });
    });

    // Начать чат с пользователем
    socket.on('start private chat', (targetSocketId) => {
        const user = users[socket.id];
        const target = users[targetSocketId];
        
        if (user && target) {
            user.currentChatWith = targetSocketId;
            
            // Создаём приватную комнату для двух пользователей
            const roomName = [socket.id, targetSocketId].sort().join('_');
            socket.join(roomName);
            
            // Уведомляем, что чат начат
            socket.emit('chat started', {
                with: target.username,
                withId: targetSocketId
            });
        }
    });

    // Отправка приватного сообщения
    socket.on('private message', ({ toId, text }) => {
        const sender = users[socket.id];
        const recipient = users[toId];
        
        if (sender && recipient) {
            const roomName = [socket.id, toId].sort().join('_');
            
            // Отправляем сообщение в приватную комнату
            io.to(roomName).emit('private message', {
                from: sender.username,
                fromId: socket.id,
                text: text,
                time: new Date().toLocaleTimeString(),
                isSelf: false
            });
            
            // Отправляем себе с пометкой "self"
            socket.emit('private message', {
                from: sender.username,
                text: text,
                time: new Date().toLocaleTimeString(),
                isSelf: true
            });
        }
    });

    // Закрыть приватный чат
    socket.on('close private chat', () => {
        const user = users[socket.id];
        if (user) {
            user.currentChatWith = null;
            socket.emit('chat closed');
        }
    });

    // Отключение пользователя
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            socket.broadcast.emit('system message', {
                text: `${user.username} покинул чат`,
                time: new Date().toLocaleTimeString()
            });
            delete users[socket.id];
            updateUserList();
        }
        console.log('Пользователь отключился');
    });
    
    function updateUserList() {
        const userList = Object.values(users).map(user => ({
            username: user.username,
            socketId: user.socketId
        }));
        io.emit('user list', userList);
    }
});

http.listen(3000, () => {
    console.log('Сервер запущен на http://localhost:3000');
});
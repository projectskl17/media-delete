const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const cron = require('node-cron');
const config = require('./config');
const bot = new TelegramBot(config.BOT_TOKEN, {
    polling: true
});
const ChatMessageSchema = new mongoose.Schema({
    _id: Number,
    userId: Number,
    title: String,
    deleteTime: Number,
    messages: [{
        _id: Number,
        date: Number
    }]
});
const ChatMessage = mongoose.model('ChatMessage', ChatMessageSchema);
const chatSchema = new mongoose.Schema({
    chatId: {
        type: String,
        required: true
    },
    chatName: {
        type: String,
        required: true
    }
});
const userSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        unique: true
    },
    chats: [chatSchema]
});
const User = mongoose.model('User', userSchema);
mongoose.connect(config.MONGO_URI, {})
    .then(async () => {
        console.log('Connected to MongoDB');
    })
    .catch(err => console.log('Database connection error:', err));
cron.schedule('*/10 * * * * *', async () => {
    try {
        const chatMessages = await ChatMessage.find();
        for (const chatMessage of chatMessages) {
            const currentTime = Math.floor(Date.now() / 1000);
            const messagesToKeep = [];
            const messagesToDelete = [];
            for (const msg of chatMessage.messages) {
                if (currentTime - msg.date >= chatMessage.deleteTime) {
                    messagesToDelete.push(msg._id);
                } else {
                    messagesToKeep.push(msg);
                }
            }
            if (messagesToDelete.length > 0) {
                while (messagesToDelete.length > 0) {
                    const batch = messagesToDelete.splice(0, 100);
                    try {
                        await bot.deleteMessages(chatMessage._id, batch);
                    } catch (error) {
                        messagesToDelete.unshift(...batch);
                    }
                }
                chatMessage.messages = messagesToKeep;
                await chatMessage.save();
            }
        }
    } catch (error) {}
});
const cache = new Map();
async function getName(id) {
    if (cache.has(id)) {
        return cache.get(id);
    }
    try {
        const chat = await bot.getChat(id);
        const title = chat.title;
        cache.set(id, title);
        return title;
    } catch (error) {
        return 'null';
    }
}
const adminStatusCache = new Map();
async function checkBotAdminStatus(chatId) {
    const cacheKey = `bot_admin_status:${chatId}`;
    if (adminStatusCache.has(cacheKey)) {
        return adminStatusCache.get(cacheKey);
    }
    try {
        const botId = config.BOT_TOKEN.split(':')[0];
        const chatMember = await bot.getChatMember(chatId, botId);
        const isAdmin = chatMember.status === 'administrator' || chatMember.status === 'creator';
        adminStatusCache.set(cacheKey, isAdmin);
        return isAdmin;
    } catch (error) {
        return false;
    }
}
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const userId = msg.from.id;
    if (chatType === 'group' || chatType === 'supergroup') {
        if (!(await isAdmin(chatId, userId))) {
            return;
        }
    }
    let user = await User.findOne({
        userId: chatId
    });
    let responseText = '';
    let replyMarkup = null;
    if (chatType === 'group' || chatType === 'supergroup') {
        if (user && user.chats.some(chat => chat.chatId === chatId.toString())) {
            responseText = `This group (ID: ${chatId}) is already set up for media deletion.\n\n`;
            responseText += 'You can:\n';
            responseText += '**Set New Time**: Change the time for automatic media deletion.\n\n';
            responseText += '**Disable**: Turn off media deletion for this group.\n\n';
            replyMarkup = {
                inline_keyboard: [
                    [{
                        text: 'Set New Time',
                        callback_data: `yes;${chatId}`
                    }],
                    [{
                        text: 'Disable',
                        callback_data: `disable;${chatId}`
                    }]
                ]
            };
        } else {
            responseText = '*Media Deleter Bot* 🎉\n\n';
            responseText += 'To get started, please either:\n';
            responseText += '1. Forward a message from a channel where you want to manage media deletion.\n';
            responseText += '2. Add this bot to a group to enable media management there.\n\n';
            responseText += '3. **Get Help**: Use the Help button below if you need more information.\n\n';
            responseText += 'Need more information? Use the Help button below.';
            replyMarkup = {
                inline_keyboard: [
                    [{
                        text: 'Add This Group',
                        callback_data: `yes;${chatId}`
                    }]
                ]
            };
        }
    } else {
        responseText = '*Media Deleter Bot* 🎉\n\n';
        responseText += 'To get started, please either:\n';
        responseText += '1. Forward a message from a channel where you want to manage media deletion.\n';
        responseText += '2. Add this bot to a group to enable media management there.\n\n';
        responseText += 'Need more information? Use the Help button below.';
        replyMarkup = {
            inline_keyboard: [
                [{
                    text: 'Help',
                    callback_data: 'help'
                }]
            ]
        };
    }
    bot.sendMessage(chatId, responseText, {
        reply_markup: replyMarkup,
        parse_mode: 'Markdown'
    });
});
bot.on('message', async (msg) => {
    if (msg.forward_from_chat &&
        !(msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
        await bot.sendMessage(msg.chat.id, `Do you want to delete media from ${msg.forward_from_chat.title}?`, {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: 'Yes',
                        callback_data: `yes;${msg.forward_from_chat.id}`
                    }, {
                        text: 'No',
                        callback_data: 'no'
                    }]
                ]
            }
        });
    }
    if ((msg.chat.type === 'group' || msg.chat.type === 'supergroup') &&
        (msg.photo || msg.video || msg.document || msg.audio)) {
        try {
            let chatMessage = await ChatMessage.findOne({
                _id: msg.chat.id
            });
            if (!chatMessage) return;
            chatMessage.messages.push({
                _id: msg.message_id,
                date: Math.floor(Date.now() / 1000)
            });
            await chatMessage.save();
        } catch (error) {}
    }
});
const adminCache = new Map();
async function isAdmin(chatId, userId) {
    const cacheKey = `${chatId}:${userId}`;
    if (adminCache.has(cacheKey)) {
        return adminCache.get(cacheKey);
    }
    try {
        const chatMember = await bot.getChatMember(chatId, userId);
        const isAdmin = ['creator', 'administrator'].includes(chatMember.status);
        adminCache.set(cacheKey, isAdmin);
        return isAdmin;
    } catch (error) {
        return false;
    }
}
bot.on('callback_query', async (query) => {
    if (query.message.chat.type === 'group' || query.message.chat.type === 'supergroup') {
        if (!(await isAdmin(query.message.chat.id, query.from.id))) {
            await bot.answerCallbackQuery(query.id, {
                text: 'Only admins can use this feature in groups.',
                show_alert: true
            });
            return;
        }
    }
    if (query.data === 'no') {
        await bot.deleteMessage(query.message.chat.id, query.message.message_id);
        await bot.answerCallbackQuery(query.id, {
            text: 'Action canceled.'
        });
        return;
    }
    if (query.data.startsWith('yes')) {
        const [action, _id] = query.data.split(';');
        try {
            const title = await getName(_id);
            const isAdmin = await checkBotAdminStatus(_id);
            if (!isAdmin) {
                await bot.sendMessage(query.message.chat.id, 'Please make the bot an admin in the group to manage media deletion.');
                await bot.answerCallbackQuery(query.id, {
                    text: 'Bot is not an admin.',
                    show_alert: true
                });
                return;
            }
            await bot.sendMessage(query.message.chat.id, 'Select a time to delete media:', {
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: '15 Minutes',
                            callback_data: `time;900;${_id}`
                        }, {
                            text: '30 Minutes',
                            callback_data: `time;1800;${_id}`
                        }],
                        [{
                            text: '1 Hour',
                            callback_data: `time;3600;${_id}`
                        }, {
                            text: '6 Hours',
                            callback_data: `time;21600;${_id}`
                        }],
                        [{
                            text: '12 Hours',
                            callback_data: `time;43200;${_id}`
                        }, {
                            text: '24 Hours',
                            callback_data: `time;86400;${_id}`
                        }],
                        [{
                            text: 'Custom Time',
                            callback_data: `custom;${_id}`
                        }, {
                            text: 'Cancel',
                            callback_data: 'cancel'
                        }]
                    ]
                }
            });
            await bot.deleteMessage(query.message.chat.id, query.message.message_id);
        } catch (error) {
            await bot.answerCallbackQuery(query.id, {
                text: 'Bot is not an admin in this channel.',
                show_alert: true
            });
        }
        if (query.data.startsWith('disable')) {
            const [action, _id] = query.data.split(';');
            const title = await getName(_id);
            try {
                await ChatMessage.deleteOne({
                    _id: parseInt(_id)
                });
                await User.updateOne({
                    userId: query.message.chat.id
                }, {
                    $pull: {
                        chats: {
                            chatId: _id
                        }
                    }
                });
                await bot.editMessageText(`Media deletion has been disabled for ${title}.`, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                });
            } catch (error) {}
        }
    }
    if (query.data === 'help') {
        const helpText = `
    *Media Deleter Bot Help* 📖
    
    This bot helps you automatically delete media from your chats after a specified time.
    
    **How to Use:**
    1. **For Groups:** Forward a message from a group to this bot to set up media deletion for that group.
    2. **For Channels:** Forward a message from a channel to manage media deletion there.
    
    Once added, make sure to give the bot *admin access* to manage media deletion properly.
    
    **Commands:**
    - Use /list to view the list of channels or groups where you've added this bot.
    
    You can then choose or set a custom time for when the media should be deleted.
    
    Need to go back? Use the button below.
        `;
        await bot.editMessageText(helpText, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: 'Back',
                        callback_data: 'back'
                    }]
                ]
            },
            parse_mode: 'Markdown'
        });
    }
    if (query.data.startsWith('custom')) {
        const [, _id] = query.data.split(';');
        const title = await getName(_id);
        await bot.sendMessage(query.message.chat.id, 'Enter time in seconds:', {
            reply_markup: {
                force_reply: true
            }
        }).then((sent) => {
            bot.onReplyToMessage(sent.chat.id, sent.message_id, async (reply) => {
                const time = parseInt(reply.text);
                await bot.sendMessage(query.message.chat.id, `Media from "${title}" will be deleted after ${time} seconds.`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{
                                text: 'Confirm',
                                callback_data: `confirm;${time};${_id}`
                            }, {
                                text: 'Cancel',
                                callback_data: 'cancel'
                            }]
                        ]
                    }
                });
                await bot.deleteMessage(query.message.chat.id, query.message.message_id);
                await bot.deleteMessage(query.message.chat.id, sent.message_id);
            });
        });
    }
    if (query.data.startsWith('confirm')) {
        const [, time, _id] = query.data.split(';');
        const title = await getName(_id);
        try {
            let chatMessage = await ChatMessage.findOne({
                _id: parseInt(_id)
            });
            if (chatMessage) {
                chatMessage.deleteTime = parseInt(time);
            } else {
                chatMessage = new ChatMessage({
                    _id: parseInt(_id),
                    deleteTime: parseInt(time),
                    messages: []
                });
            }
            await chatMessage.save();
            await bot.editMessageText(`Media from ${title} will be deleted after ${time} seconds.`, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: 'Disable',
                            callback_data: `disable;${_id}`
                        }]
                    ]
                }
            });
            await User.findOneAndUpdate({
                userId: query.message.chat.id
            }, {
                userId: query.message.chat.id,
                $push: {
                    chats: {
                        chatId: _id,
                        chatName: title
                    }
                }
            }, {
                upsert: true
            }).exec();
        } catch (error) {}
    }
    if (query.data.startsWith('disable')) {
        const [action, _id] = query.data.split(';');
        const title = await getName(_id);
        try {
            await ChatMessage.deleteOne({
                _id: parseInt(_id)
            });
            await User.updateOne({
                userId: query.message.chat.id
            }, {
                $pull: {
                    chats: {
                        chatId: _id
                    }
                }
            });
            await bot.editMessageText(`Media deletion has been disabled for ${title}.`, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: 'Re-enable',
                            callback_data: `yes;${_id}`
                        }]
                    ]
                }
            });
        } catch (error) {}
    }
    if (query.data === 'back') {
        responseText = '*Media Deleter Bot* 🎉\n\n';
        responseText += 'To get started, please either:\n';
        responseText += '1. Forward a message from a channel where you want to manage media deletion.\n';
        responseText += '2. Add this bot to a group to enable media management there.\n\n';
        responseText += 'Need more information? Use the Help button below.';
        await bot.editMessageText(responseText, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: 'Help',
                        callback_data: 'help'
                    }]
                ]
            },
            parse_mode: 'Markdown'
        });
    }
    if (query.data.startsWith('time')) {
        const [action, time, _id] = query.data.split(';');
        const title = await getName(_id);
        await bot.editMessageText(`Media from ${title} will be deleted after ${time} seconds.`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: 'Disable',
                        callback_data: `disable;${_id}`
                    }]
                ]
            }
        });
        await bot.deleteMessage(query.message.chat.id, query.message.message_id);
        await User.findOneAndUpdate({
            userId: query.message.chat.id
        }, {
            userId: query.message.chat.id,
            $push: {
                chats: {
                    chatId: _id,
                    chatName: title
                }
            }
        }, {
            upsert: true
        }).exec();
    }
    if (query.data === 'cancel') bot.deleteMessage(query.message.chat.id, query.message.message_id);
});
bot.on('channel_post', async (msg) => {
    if (msg.message_id && msg.chat && msg.chat.id) {
        if (!msg.photo && !msg.video && !msg.document && !msg.audio) return;
        try {
            let chatMessage = await ChatMessage.findOne({
                _id: msg.chat.id
            });
            if (chatMessage) {
                chatMessage.messages.push({
                    _id: msg.message_id,
                    date: Math.floor(Date.now() / 1000)
                });
                await chatMessage.save();
            }
        } catch (error) {}
    }
});
bot.onText(/\/list/, async (msg) => {
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        if (!(await isAdmin(msg.chat.id, msg.from.id))) {
            return;
        }
    }
    const user = await User.findOne({
        userId: msg.chat.id
    });
    if (!user) return bot.sendMessage(msg.chat.id, 'No chats found.');
    let chatList = 'Chats:\n';
    for (const chat of user.chats) {
        chatList += `${chat.chatName} : ${chat.chatId}\n`;
    }
    bot.sendMessage(msg.chat.id, chatList);
});
bot.on('polling_error', (err) => console.log(err));

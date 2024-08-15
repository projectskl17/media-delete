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
                        callback_data: `yes;${chatId};{${msg.chat.title}}`
                    }],
                    [{
                        text: 'Disable',
                        callback_data: `disable;${chatId};{${msg.chat.title}}`
                    }]
                ]
            };
        } else {
            responseText = '*Media Deleter Bot* 🎉\n\n';
            responseText += 'To get started, please either:\n';
            responseText += '1. Forward a message from a channel where you want to manage media deletion.\n';
            responseText += '2. Add this bot to a group to enable media deletion there.\n\n';
            responseText += '3. **Get Help**: Use the Help button below if you need more information.\n\n';
            responseText += 'Need more information? Use the Help button below.';
            replyMarkup = {
                inline_keyboard: [
                    [{
                        text: 'Add This Group',
                        callback_data: `yes;${chatId};{${msg.chat.title}}`
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
                        callback_data: `yes;${msg.forward_from_chat.id};{${msg.forward_from_chat.title}}`
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
async function isAdmin(chatId, userId) {
    try {
        const chatMember = await bot.getChatMember(chatId, userId);
        return ['creator', 'administrator'].includes(chatMember.status);
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
        const [action, _id, title] = query.data.split(';');
        try {
            const chatMember = await bot.getChatMember(_id, config.BOT_TOKEN.split(':')[0]);
            if (chatMember.status !== 'administrator' && chatMember.status !== 'creator') {
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
                            callback_data: `time;900;${_id};${title}`
                        }, {
                            text: '30 Minutes',
                            callback_data: `time;1800;${_id};${title}`
                        }],
                        [{
                            text: '1 Hour',
                            callback_data: `time;3600;${_id};${title}`
                        }, {
                            text: '6 Hours',
                            callback_data: `time;21600;${_id};${title}`
                        }],
                        [{
                            text: '12 Hours',
                            callback_data: `time;43200;${_id};${title}`
                        }, {
                            text: '24 Hours',
                            callback_data: `time;86400;${_id};${title}`
                        }],
                        [{
                            text: 'Custom Time',
                            callback_data: `custom;${_id};${title}`
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
            const [action, _id, title] = query.data.split(';');
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
                await bot.editMessageText(`Media deletion has been disabled for ${title.replace(/{|}/g, '')}.`, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                });
            } catch (error) {
                await bot.answerCallbackQuery(query.id, {
                    text: 'An error occurred. Please try again.',
                    show_alert: true
                });
            }
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
        const [, _id, title] = query.data.split(';');
        await bot.sendMessage(query.message.chat.id, 'Enter time in seconds:', {
            reply_markup: {
                force_reply: true
            }
        }).then((sent) => {
            bot.onReplyToMessage(sent.chat.id, sent.message_id, async (reply) => {
                const time = parseInt(reply.text);
                await bot.sendMessage(query.message.chat.id, `Media from "${title.replace(/{|}/g, '')}" will be deleted after ${time} seconds.`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{
                                text: 'Confirm',
                                callback_data: `confirm;${time};${_id};${title}`
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
        const [, time, _id, name] = query.data.split(';');
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
            await bot.editMessageText(`Media from ${name.replace(/{|}/g, '')} will be deleted after ${time} seconds.`, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: 'Disable',
                            callback_data: `disable;${_id};${name}`
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
                        chatName: name.replace(/{|}/g, '')
                    }
                }
            }, {
                upsert: true
            }).exec();
        } catch (error) {
            await bot.answerCallbackQuery(query.id, {
                text: 'An error occurred. Please try again.',
                show_alert: true
            });
        }
    }
    if (query.data.startsWith('disable')) {
        const [action, _id, name] = query.data.split(';');
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
            await bot.editMessageText(`Media deletion has been disabled for ${name.replace(/{|}/g, '')}.`, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: 'Re-enable',
                            callback_data: `yes;${_id};${name}`
                        }]
                    ]
                }
            });
        } catch (error) {
            await bot.answerCallbackQuery(query.id, {
                text: 'An error occurred. Please try again.',
                show_alert: true
            });
        }
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
        const [action, time, _id, title] = query.data.split(';');
        await bot.editMessageText(`Media from ${title.replace(/{|}/g, '')} will be deleted after ${time} seconds.`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: 'Disable',
                        callback_data: `disable;${_id};${title}`
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
                    chatName: title.replace(/{|}/g, '')
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

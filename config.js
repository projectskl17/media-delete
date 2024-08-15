const fs = require('fs');
if (fs.existsSync('config.env')) require('dotenv').config({ path: './config.env', override: true });

module.exports = {
    BOT_TOKEN: process.env.BOT_TOKEN || '',
    MONGO_URI: process.env.MONGO_URI || '',
};
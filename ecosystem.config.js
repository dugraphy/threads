require('dotenv').config();

// SCHEDULE_TIME (예: "13:00")을 pm2 cron 표현식으로 변환
const scheduleTime = process.env.SCHEDULE_TIME || '09:00';
const [hour, minute] = scheduleTime.split(':');
const cronExpr = `${parseInt(minute)} ${parseInt(hour)} * * *`;

module.exports = {
  apps: [
    {
      name: '스레드자동발행',
      script: './post.js',
      cron_restart: cronExpr,
      autorestart: false,
      watch: false,
    }
  ]
};
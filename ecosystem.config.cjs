module.exports = {
  apps: [{
    name: 'tally',
    script: './server.js',
    node_args: '--env-file=.env',
    cwd: '/home/claude/projects/tally',
    env: {
      NODE_ENV: 'production',
    },
    out_file: '/home/claude/.pm2/logs/tally-out.log',
    error_file: '/home/claude/.pm2/logs/tally-err.log',
    max_memory_restart: '300M',
  }, {
    name: 'wall-verse',
    script: './scripts/wall-verse.js',
    cwd: '/home/claude/projects/tally',
    autorestart: false,
    cron_restart: '10 0,6 * * *',
    out_file: '/home/claude/.pm2/logs/wall-verse-out.log',
    error_file: '/home/claude/.pm2/logs/wall-verse-err.log',
  }],
};

export default {
  apps: [{
    name: 'tally',
    script: './server.js',
    cwd: '/home/claude/projects/tally',
    env: {
      PORT: 3007,
      SESSION_SECRET: 'CHANGE_THIS_BEFORE_DEPLOY',
      NODE_ENV: 'production',
    },
    out_file: '/home/claude/.pm2/logs/tally-out.log',
    error_file: '/home/claude/.pm2/logs/tally-err.log',
    max_memory_restart: '300M',
  }],
};

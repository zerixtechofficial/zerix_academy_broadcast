module.exports = {
  apps: [
    {
      name: 'broadcast-engine',
      script: './dist/index.js',
      instances: process.env.PM2_INSTANCES || 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      listen_timeout: 10000,
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        HOST: '0.0.0.0',
        ALLOW_DEV_TOKENS: 'true',
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 4000,
        HOST: '0.0.0.0',
        ALLOW_DEV_TOKENS: 'true',
      },
    },
  ],
};

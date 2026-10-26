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
        DATA_SOURCE_MODE: 'laravel_api',
        LARAVEL_API_BASE_URL: 'https://api-academy.zerixtech.com',
        LIVEKIT_PUBLIC_URL: 'wss://studio.zerixtech.com/livekit',
      },
    },
  ],
};

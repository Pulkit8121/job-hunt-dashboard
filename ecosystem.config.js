module.exports = {
  apps: [
    {
      name: 'job-hunt-dashboard',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      cwd: '/var/www/job-hunt-dashboard',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: 'production', PORT: '3000' },
    },
  ],
};

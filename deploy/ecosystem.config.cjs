module.exports = {
  apps: [
    { name: 'wa-api', script: 'src/server.js', instances: 1, exec_mode: 'fork', node_args: '--env-file=/etc/wa-commerce/app.env', kill_timeout: 650000, env: { NODE_ENV: 'production', CONFIG_ENV_PATH: '/etc/wa-commerce/app.env' } },
    { name: 'wa-worker', script: 'src/worker.js', instances: 1, exec_mode: 'fork', node_args: '--env-file=/etc/wa-commerce/app.env', kill_timeout: 650000, env: { NODE_ENV: 'production', CONFIG_ENV_PATH: '/etc/wa-commerce/app.env' } },
  ],
};

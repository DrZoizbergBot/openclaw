module.exports = {
  apps: [
    {
      name: 'edgar_monitor',
      script: '/home/davide/openclaw-scripts/edgar_monitor.mjs',
      env_file: '/home/davide/openclaw_telegram.env',
    },
    {
      name: 'pipeline',
      script: '/home/davide/openclaw-scripts/pipeline.mjs',
      env_file: '/home/davide/openclaw_telegram.env',
    }
  ]
};

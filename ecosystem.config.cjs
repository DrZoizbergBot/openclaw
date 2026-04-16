module.exports = {
  apps: [
    {
      name: 'openclaw-listener',
      script: '/home/davide/openclaw-scripts/telegram_listener.mjs',
      env: {
        TOKEN: '8630398582:AAFkCX0gNGs3T3cl9LAzxWzQf5OrePe56Og',
        CHAT: '672803762',
        ALPACA_KEY: 'PKVILZNOV7COGTZSWQGLFF7FFM',
        ALPACA_SECRET: 'AXbHqxvVa9dAncdXgSP4oxk7neQfGttyhFfCSFewvCTL',
        FINNHUB_KEY: 'd773mp1r01qtg3nfh4q0d773mp1r01qtg3nfh4qg',
        OPENAI_API_KEY: 'OPENAI_KEY_HERE',
      script: '/home/davide/openclaw-scripts/edgar_monitor.mjs',
      env: {
        TOKEN: '8630398582:AAFkCX0gNGs3T3cl9LAzxWzQf5OrePe56Og',
        CHAT: '672803762',
        ALPACA_KEY: 'PKVILZNOV7COGTZSWQGLFF7FFM',
        ALPACA_SECRET: 'AXbHqxvVa9dAncdXgSP4oxk7neQfGttyhFfCSFewvCTL',
        FINNHUB_KEY: 'd773mp1r01qtg3nfh4q0d773mp1r01qtg3nfh4qg',
        OPENAI_API_KEY: 'OPENAI_KEY_HERE',
      }
    },
    {
      name: 'pipeline',
      script: '/home/davide/openclaw-scripts/pipeline.mjs',
      env: {
        TOKEN: '8630398582:AAFkCX0gNGs3T3cl9LAzxWzQf5OrePe56Og',
        CHAT: '672803762',
        ALPACA_KEY: 'PKVILZNOV7COGTZSWQGLFF7FFM',
        ALPACA_SECRET: 'AXbHqxvVa9dAncdXgSP4oxk7neQfGttyhFfCSFewvCTL',
        FINNHUB_KEY: 'd773mp1r01qtg3nfh4q0d773mp1r01qtg3nfh4qg',
        OPENAI_API_KEY: 'OPENAI_KEY_HERE',
      }
    }
  ]
};

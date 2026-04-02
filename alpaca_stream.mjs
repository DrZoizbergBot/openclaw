import Alpaca from '@alpacahq/alpaca-trade-api';

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_KEY,
  secretKey: process.env.ALPACA_SECRET,
  paper: true,
  feed: 'iex',
});

const UNIVERSE = ['AAPL', 'TSLA', 'NVDA', 'AMD', 'MARA', 'COIN', 'SPY', 'QQQ'];

const stream = alpaca.data_stream_v2;

stream.onConnect(() => {
  console.log('Alpaca WebSocket connected');
  stream.subscribeForBars(UNIVERSE);
});

stream.onStateChange((status) => {
  console.log('Status:', status);
});

stream.onStockBar((bar) => {
  console.log(`${bar.Symbol} | Close: ${bar.ClosePrice} | Vol: ${bar.Volume} | Time: ${bar.Timestamp}`);
});

stream.onError((err) => {
  console.error('Alpaca stream error:', err);
});

stream.onDisconnect(() => {
  console.warn('Alpaca stream disconnected — reconnecting in 5s');
  setTimeout(() => stream.connect(), 5000);
});

stream.connect();

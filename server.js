const express = require('express');
const os = require('os');

const APP_VERSION = process.env.APP_VERSION || 'v1';
const APP_COLOR = process.env.APP_COLOR || 'blue';
const SIMULATE_FAILURE = process.env.SIMULATE_FAILURE === 'true';

function createApp() {
  const app = express();

  app.get('/health', (req, res) => {
    if (SIMULATE_FAILURE) {
      return res.status(500).json({ status: 'error', reason: 'fallo simulado' });
    }
    res.status(200).json({ status: 'ok' });
  });

  app.get('/version', (req, res) => {
    res.status(200).json({
      version: APP_VERSION,
      color: APP_COLOR,
      hostname: os.hostname(),
    });
  });

  app.get('/', (req, res) => {
    res.status(200).send(
      '<html><body style="font-family: sans-serif; background:' + APP_COLOR +
      '; color:white; text-align:center; padding-top:80px;">' +
      '<h1>Sistemas Distribuidos - Cristian Timbi</h1>' +
      '<h2>Version desplegada: ' + APP_VERSION + '</h2>' +
      '<p>Pod: ' + os.hostname() + '</p>' +
      '</body></html>'
    );
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log('Servidor escuchando en puerto ' + PORT + ' (version=' + APP_VERSION + ', color=' + APP_COLOR + ')');
  });
}

module.exports = { createApp };

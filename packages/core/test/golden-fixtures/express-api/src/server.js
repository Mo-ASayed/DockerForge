const express = require('express');
const app = express();
app.get('/health', (_, res) => res.send('ok'));
app.listen(3000);

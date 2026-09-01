require('dotenv').config();
// Force a fresh Railway rebuild with the correct backend root directory.
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth');
const timeEntryRoutes = require('./routes/timeEntries');
const userRoutes = require('./routes/users');

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5500').split(','),
    credentials: true, // required so the browser will send/receive the refresh cookie
  })
);
app.use(express.json());
app.use(cookieParser());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/shifts', timeEntryRoutes);
app.use('/api/users', userRoutes);

// Central error handler — never leak stack traces to the client
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Shift tracker API running on http://localhost:${PORT}`);
});

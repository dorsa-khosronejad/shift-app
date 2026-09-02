const nodemailer = require('nodemailer');
const db = require('../db/database');

const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

function sendEmail({ to, subject, text }) {
  if (!mailer || !to || !process.env.SMTP_FROM) return false;
  mailer.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      text,
  }).catch((error) => console.error('Notification email failed:', error.message));
  return true;
}

function notifyUser(userId, { type, title, message, emailSubject, emailText }) {
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  db.prepare('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)')
    .run(userId, type, title, message);
  sendEmail({ to: user?.email, subject: emailSubject || title, text: emailText || message });
}

module.exports = { notifyUser, sendEmail };

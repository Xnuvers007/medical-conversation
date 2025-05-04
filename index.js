const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const { initWhatsAppBot } = require('./bot');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');

require('dotenv').config();

const randomHex = crypto.randomBytes(16).toString('hex');

const app = express();
const db = new sqlite3.Database('./db.sqlite');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/gambar', express.static(path.join(__dirname, 'public/gambar')));


app.use(session({
    secret: randomHex,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: true,
        maxAge: 1000 * 60 * 60 * 24, // 1 day
        sameSite: 'strict',
        httpOnly: true,
    }
  }));

app.use(helmet());
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
    imgSrc: ["'self'", "*"],
    scriptSrcAttr: ["'none'"],
    styleSrcAttr: ["'none'"],
  }
}));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 13, // Maksimum 13 percakapan
    message: "Terlalu banyak permintaan, coba lagi nanti. tunggu 15 menit.",
    standardHeaders: true,
    legacyHeaders: false,
  });
  
  app.use(limiter);
  

function isAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized' });
}

function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized - Admins only' });
}

function isUser(req, res, next) {
    if (req.session.user && req.session.user.role === 'patient') {
        return next();
    }
    res.status(403).json({ error: 'Unauthorized - Users only' });
}

app.set('trust proxy', 1);

// === Setup Database ===
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    role TEXT CHECK(role IN ('admin', 'patient')),
    username TEXT UNIQUE,
    password TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS doctors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    specialization TEXT,
    phone TEXT,
    photo_url TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    doctor_id INTEGER,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(doctor_id) REFERENCES doctors(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER,
    sender TEXT CHECK(sender IN ('doctor', 'patient')),
    message TEXT,
    msg_id TEXT,
    has_media BOOLEAN, 
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(booking_id) REFERENCES bookings(id)
  )`);
});

// === Routes ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);  // Log error for debugging
  res.status(500).json({ message: 'Internal Server Error' });
});

// if (process.env.NODE_ENV === 'production') {
//   app.use((req, res, next) => {
//     if (req.protocol === 'http') {
//       return res.redirect(301, 'https://' + req.headers.host + req.url);
//     }
//     next();
//   });
// }

app.post('/book', isAuthenticated, (req, res) => {
  if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
  const { user_id, doctor_id, message } = req.body;
  db.run(`INSERT INTO bookings (user_id, doctor_id, message) VALUES (?, ?, ?)`,
    [user_id, doctor_id, message],
    function (err) {
      if (err) return res.status(500).send('Database error');
      return res.json({ status: 'success', booking_id: this.lastID });
    });
});

app.get('/dashboard', isAuthenticated, (req, res) => {
    if (!req.session.user) return res.redirect('/');
  
    if (req.session.user.role === 'admin') {
      res.sendFile(path.join(__dirname, 'public/admin.html'));
    } else {
      res.sendFile(path.join(__dirname, 'public/patient.html'));
    }
  });
  

// Register route
app.post('/register', [
  body('username').isAlphanumeric().withMessage('Username must be alphanumeric'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('email').isEmail().withMessage('Please provide a valid email address'),
], (req, res) => {
    const { username, password, name } = req.body;
    console.log(`Mencoba mendaftarkan pengguna baru: ${username}`);
  
    db.run(`INSERT INTO users (name, role, username, password) VALUES (?, 'patient', ?, ?)`,
      [name, username, password], function (err) {
        if (err) {
          console.log('Gagal mendaftarkan pengguna:', err.message);
          return res.status(400).json({ status: 'error', message: 'Username already exists' });
        }
        console.log('Pengguna berhasil didaftarkan:', username);
        req.session.user = { id: this.lastID, name, role: 'patient', username };
        res.json({ status: 'success' });
      });
  });
  // Login route
  app.post('/login', (req, res) => {
    const { username, password } = req.body;
  
    // Hardcoded admin login
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (username === adminUsername && password === adminPassword) {
      req.session.user = { username: adminUsername, role: 'admin' };
      return res.json({ status: 'success', role: 'admin' });
    }
  
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
      if (user) {
        req.session.user = { id: user.id, name: user.name, role: user.role, username: user.username };
        res.json({ status: 'success', role: user.role });
      } else {
        res.status(401).json({ status: 'error', message: 'Invalid credentials' });
      }
    });
  });

// Get current logged in user
app.get('/get-user', isAuthenticated || isUser, (req, res) => {
    if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
    res.json(req.session.user);
  });
  
  // Get all doctors
  app.get('/doctors', isAuthenticated, (req, res) => {
    if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
    db.all('SELECT * FROM doctors', (err, rows) => {
    //   res.json(rows);
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
        res.json(rows);
    });
  });

  // get all photo from public/gambar
  app.get('/images', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const directoryPath = path.join(__dirname, 'public/gambar');

    fs.readdir(directoryPath, (err, files) => {
      if (err) {
        return res.status(500).json({ error: 'Unable to scan directory: ' + err });
      }
      const images = files.map(file => path.join('/gambar', file));
      res.json(images);
    });
  });
  
  // Add new doctor (admin only)
  app.post('/doctors', isAuthenticated && isAdmin, (req, res) => {
    if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
    const { name, specialization, phone, photo_url } = req.body;
    
    if (!photo_url.startsWith('http://') && !photo_url.startsWith('https://')) {
      return res.status(400).json({ error: 'Invalid photo URL' });
    }

    db.run(`INSERT INTO doctors (name, specialization, phone, photo_url) VALUES (?, ?, ?, ?)`,
      [name, specialization, phone, photo_url], (err) => {
        if (err) return res.status(500).json({ error: 'Gagal tambah dokter' });
        res.json({ status: 'success' });
      });
  });
  
  // Delete doctor (admin only)
  app.delete('/doctors/:id', isAuthenticated && isAdmin, (req, res) => {
    if (!req.session.user) return res.status(403).json({ error: 'Unauthorized' });
    const id = req.params.id;
    db.run(`DELETE FROM doctors WHERE id = ?`, [id], function(err) {
      if (err) return res.status(500).json({ error: 'Gagal hapus dokter' });
      res.json({ status: 'deleted' });
    });
  });

  app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to logout' });
      }
      res.json({ status: 'success', message: 'Logged out successfully' });
    });
  });
  

initWhatsAppBot(db);

app.listen(3000, () => {
  console.log(`Server started on http://localhost:3000`);
});
const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-me';

const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');

const app = express();

// --- ЗАЩИТА ОТ ПЕРЕБОРА ---
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: "Слишком много попыток входа, попробуйте через 15 минут." }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== БАЗА И ПАПКИ ====================
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const db = new sqlite3.Database('bookings.db', (err) => {
    if (err) console.error('Ошибка БД:', err);
    db.run(`CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, datetime TEXT UNIQUE)`);
    db.run(`CREATE TABLE IF NOT EXISTS blocked_dates (date TEXT PRIMARY KEY)`);
    db.run(`CREATE TABLE IF NOT EXISTS blocked_ranges (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, start_time TEXT, end_time TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, image TEXT, date TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, rating INTEGER, text TEXT, date TEXT, approved INTEGER DEFAULT 0)`);
});

// ==================== MULTER (ЗАЩИЩЕННЫЙ) ====================
const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|webp/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) return cb(null, true);
        cb(new Error("Только изображения (jpg, png, webp)!"));
    }
}).single('image');

// ==================== МИДЛВАР JWT ====================
const checkToken = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    if (!token) return res.status(401).json({ error: 'Нужна авторизация' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Сессия истекла' });
        req.admin = decoded;
        next();
    });
};

// ==================== СТРАНИЦЫ ====================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin-login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));

// ==================== АВТОРИЗАЦИЯ ====================
app.post('/api/admin-login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
    }
});

app.get('/api/check-auth', checkToken, (req, res) => res.json({ success: true }));

// ==================== БРОНИРОВАНИЕ ====================
app.get('/api/bookings', checkToken, (req, res) => {
    db.all('SELECT * FROM bookings ORDER BY datetime DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/book', (req, res) => {
    const { name, phone, datetime } = req.body;
    db.run('INSERT INTO bookings (name, phone, datetime) VALUES (?, ?, ?)', [name, phone, datetime], function(err) {
        if (err) return res.json({ success: false, message: 'Это время уже занято!' });
        res.json({ success: true });
    });
});

app.delete('/api/bookings/:id', checkToken, (req, res) => {
    db.run('DELETE FROM bookings WHERE id = ?', [req.params.id], () => res.json({ success: true }));
});

// ==================== СЛОТЫ ====================
app.get('/api/available-slots', (req, res) => {
    const { date } = req.query;
    const slots = [];
    for (let h = 10; h < 22; h++) slots.push(`${date}T${h.toString().padStart(2, '0')}:00`);

    // Параллельно проверяем: уже забронированные + заблокированные диапазоны
    db.all('SELECT datetime FROM bookings WHERE datetime LIKE ?', [`${date}%`], (err, bookedRows) => {
        const booked = bookedRows.map(r => r.datetime);

        db.all('SELECT start_time, end_time FROM blocked_ranges WHERE date = ?', [date], (err, ranges) => {
            const available = slots.filter(s => {
                if (booked.includes(s)) return false;

                // Проверяем попадает ли слот в заблокированный диапазон
                const slotTime = s.split('T')[1]; // "14:00"
                for (const range of ranges) {
                    if (slotTime >= range.start_time && slotTime < range.end_time) return false;
                }

                return true;
            });

            res.json(available.map(s => ({ datetime: s })));
        });
    });
});

// ==================== ДАТЫ ====================
app.get('/api/blocked-dates', (req, res) => {
    db.all('SELECT date FROM blocked_dates', (err, rows) => res.json(rows.map(r => r.date)));
});

app.post('/api/block-date', checkToken, (req, res) => {
    db.run('INSERT OR IGNORE INTO blocked_dates (date) VALUES (?)', [req.body.date], () => res.json({ success: true }));
});

app.delete('/api/blocked-dates/:date', checkToken, (req, res) => {
    db.run('DELETE FROM blocked_dates WHERE date = ?', [req.params.date], () => res.json({ success: true }));
});

// ==================== БЛОКИРОВКА ВРЕМЕННЫХ ДИАПАЗОНОВ ====================
app.get('/api/blocked-ranges', (req, res) => {
    db.all('SELECT * FROM blocked_ranges ORDER BY date, start_time', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/block-range', checkToken, (req, res) => {
    const { date, start_time, end_time } = req.body;
    if (!date || !start_time || !end_time) {
        return res.status(400).json({ success: false, message: 'Заполните все поля' });
    }
    if (start_time >= end_time) {
        return res.status(400).json({ success: false, message: 'Начало должно быть раньше конца' });
    }
    db.run(
        'INSERT INTO blocked_ranges (date, start_time, end_time) VALUES (?, ?, ?)',
        [date, start_time, end_time],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.delete('/api/blocked-ranges/:id', checkToken, (req, res) => {
    db.run('DELETE FROM blocked_ranges WHERE id = ?', [req.params.id], () => res.json({ success: true }));
});

// ==================== НОВОСТИ ====================
app.get('/api/news', (req, res) => {
    db.all('SELECT * FROM news ORDER BY date DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// POST — поддерживает и JSON (без фото), и multipart (с фото)
app.post('/api/news', checkToken, (req, res) => {
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
        // Запрос с картинкой
        upload(req, res, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            const { title, content } = req.body;
            const img = req.file ? `/uploads/${req.file.filename}` : null;
            db.run(
                'INSERT INTO news (title, content, image, date) VALUES (?, ?, ?, ?)',
                [title, content, img, new Date().toISOString().split('T')[0]],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true });
                }
            );
        });
    } else {
        // Запрос без картинки (JSON из admin.js)
        const { title, content } = req.body;
        db.run(
            'INSERT INTO news (title, content, image, date) VALUES (?, ?, ?, ?)',
            [title, content, null, new Date().toISOString().split('T')[0]],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    }
});

// PUT — поддерживает и JSON (без фото), и multipart (с фото)
app.put('/api/news/:id', checkToken, (req, res) => {
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
        upload(req, res, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            const { title, content, image } = req.body;
            const finalImg = req.file ? `/uploads/${req.file.filename}` : (image || null);
            db.run(
                'UPDATE news SET title=?, content=?, image=? WHERE id=?',
                [title, content, finalImg, req.params.id],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true });
                }
            );
        });
    } else {
        // JSON из admin.js — обновляем только title и content, картинку не трогаем
        const { title, content } = req.body;
        db.run(
            'UPDATE news SET title=?, content=? WHERE id=?',
            [title, content, req.params.id],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    }
});

app.delete('/api/news/:id', checkToken, (req, res) => {
    db.run('DELETE FROM news WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});



const PORT = process.env.PORT || 3000;
// ==================== ОТЗЫВЫ ====================

// Публичные — только одобренные
app.get('/api/reviews', (req, res) => {
    db.all('SELECT * FROM reviews WHERE approved = 1 ORDER BY date DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Оставить отзыв
app.post('/api/reviews', (req, res) => {
    const { name, rating, text } = req.body;
    if (!name || !rating || !text) {
        return res.status(400).json({ success: false, message: 'Заполните все поля' });
    }
    if (rating < 1 || rating > 5) {
        return res.status(400).json({ success: false, message: 'Оценка от 1 до 5' });
    }
    const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    db.run(
        'INSERT INTO reviews (name, rating, text, date, approved) VALUES (?, ?, ?, ?, 0)',
        [name.slice(0, 100), parseInt(rating), text.slice(0, 1000), date],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// Админ — все отзывы
app.get('/api/admin/reviews', checkToken, (req, res) => {
    db.all('SELECT * FROM reviews ORDER BY approved ASC, date DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Одобрить отзыв
app.put('/api/admin/reviews/:id/approve', checkToken, (req, res) => {
    db.run('UPDATE reviews SET approved = 1 WHERE id = ?', [req.params.id], () => {
        res.json({ success: true });
    });
});

// Удалить отзыв
app.delete('/api/admin/reviews/:id', checkToken, (req, res) => {
    db.run('DELETE FROM reviews WHERE id = ?', [req.params.id], () => {
        res.json({ success: true });
    });
});

app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
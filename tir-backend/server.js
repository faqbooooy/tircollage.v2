const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
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
app.use(cookieParser());
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
    db.run(`CREATE TABLE IF NOT EXISTS news_images (id INTEGER PRIMARY KEY AUTOINCREMENT, news_id INTEGER NOT NULL, image_path TEXT NOT NULL, sort_order INTEGER DEFAULT 0)`);
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
}).array('images', 10);

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
    const { username, password, remember } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        // Обычный краткосрочный токен для работы (24 часа)
        const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: '24h' });

        // Если "Запомнить меня" — ставим httpOnly cookie на 30 дней
        if (remember) {
            const rememberToken = jwt.sign({ user: username, type: 'remember' }, JWT_SECRET, { expiresIn: '30d' });
            res.cookie('adminRemember', rememberToken, {
                httpOnly: true,   // JS не может прочитать — защита от XSS
                sameSite: 'strict', // защита от CSRF
                maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней в мс
                path: '/api'
            });
        }

        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
    }
});

// Обмен remember-cookie на свежий JWT (вызывается при открытии админки)
app.post('/api/refresh-token', (req, res) => {
    const rememberToken = req.cookies?.adminRemember;
    if (!rememberToken) return res.status(401).json({ success: false });

    jwt.verify(rememberToken, JWT_SECRET, (err, decoded) => {
        if (err || decoded.type !== 'remember') {
            res.clearCookie('adminRemember', { path: '/api' });
            return res.status(401).json({ success: false });
        }
        const token = jwt.sign({ user: decoded.user }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token });
    });
});

// Выход — удаляем cookie
app.post('/api/admin-logout', (req, res) => {
    res.clearCookie('adminRemember', { path: '/api' });
    res.json({ success: true });
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

    // Валидация полей
    if (!name || !phone || !datetime) {
        return res.status(400).json({ success: false, message: 'Заполните все поля' });
    }
    if (name.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Укажите корректное имя' });
    }

    // Проверка, что datetime не в прошлом
    const now = new Date();
    const bookingTime = new Date(datetime);
    if (isNaN(bookingTime.getTime())) {
        return res.status(400).json({ success: false, message: 'Некорректный формат времени' });
    }
    if (bookingTime <= now) {
        return res.json({ success: false, message: 'Нельзя забронировать прошедшее время' });
    }

    const bookingDate = datetime.split('T')[0];
    const bookingTime2 = datetime.split('T')[1]?.slice(0, 5);

    // Проверка заблокированных дней
    db.get('SELECT date FROM blocked_dates WHERE date = ?', [bookingDate], (err, blockedDay) => {
        if (err) return res.status(500).json({ success: false, message: 'Ошибка базы данных' });
        if (blockedDay) {
            return res.json({ success: false, message: 'В этот день запись недоступна' });
        }

        // Проверка заблокированных временных диапазонов
        db.all('SELECT start_time, end_time FROM blocked_ranges WHERE date = ?', [bookingDate], (err, ranges) => {
            if (err) return res.status(500).json({ success: false, message: 'Ошибка базы данных' });

            const isBlocked = ranges.some(r => bookingTime2 >= r.start_time && bookingTime2 < r.end_time);
            if (isBlocked) {
                return res.json({ success: false, message: 'Это время недоступно для записи' });
            }

            db.run('INSERT INTO bookings (name, phone, datetime) VALUES (?, ?, ?)', [name.trim(), phone.trim(), datetime], function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.json({ success: false, message: 'Это время уже занято!' });
                    }
                    return res.status(500).json({ success: false, message: 'Ошибка базы данных' });
                }
                res.json({ success: true });
            });
        });
    });
});

app.delete('/api/bookings/:id', checkToken, (req, res) => {
    db.run('DELETE FROM bookings WHERE id = ?', [req.params.id], () => res.json({ success: true }));
});

// ==================== СЛОТЫ ====================
app.get('/api/available-slots', (req, res) => {
    const { date } = req.query;

    // Валидация параметра date
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Укажите корректную дату (YYYY-MM-DD)' });
    }

    const slots = [];
    for (let h = 10; h < 22; h++) slots.push(`${date}T${h.toString().padStart(2, '0')}:00`);

    db.all('SELECT datetime FROM bookings WHERE datetime LIKE ?', [`${date}%`], (err, bookedRows) => {
        if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
        const booked = bookedRows.map(r => r.datetime);

        db.all('SELECT start_time, end_time FROM blocked_ranges WHERE date = ?', [date], (err, ranges) => {
            if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
            const available = slots.filter(s => {
                if (booked.includes(s)) return false;

                const slotTime = s.split('T')[1];
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
    db.all('SELECT * FROM news ORDER BY date DESC', (err, newsRows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (newsRows.length === 0) return res.json([]);

        db.all('SELECT * FROM news_images ORDER BY news_id, sort_order', (err, imgRows) => {
            if (err) return res.status(500).json({ error: err.message });

            // Группируем картинки по news_id
            const imageMap = {};
            imgRows.forEach(img => {
                if (!imageMap[img.news_id]) imageMap[img.news_id] = [];
                imageMap[img.news_id].push(img.image_path);
            });

            const result = newsRows.map(n => ({
                ...n,
                // Если есть записи в news_images — используем их,
                // иначе fallback на legacy поле news.image
                images: imageMap[n.id] && imageMap[n.id].length > 0
                    ? imageMap[n.id]
                    : (n.image ? [n.image] : [])
            }));

            res.json(result);
        });
    });
});

app.post('/api/news', checkToken, (req, res) => {
    upload(req, res, (err) => {
        if (err) return res.status(500).json({ error: err.message });

        const { title, content } = req.body;
        if (!title || !title.trim()) {
            return res.status(400).json({ success: false, message: 'Заголовок обязателен' });
        }

        const files = req.files || [];
        const firstImg = files.length > 0 ? `/uploads/${files[0].filename}` : null;

        db.run(
            'INSERT INTO news (title, content, image, date) VALUES (?, ?, ?, ?)',
            [title.trim(), content, firstImg, new Date().toISOString().split('T')[0]],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                const newsId = this.lastID;

                if (files.length === 0) return res.json({ success: true });

                // Вставляем все изображения в news_images
                let completed = 0;
                files.forEach((file, i) => {
                    db.run(
                        'INSERT INTO news_images (news_id, image_path, sort_order) VALUES (?, ?, ?)',
                        [newsId, `/uploads/${file.filename}`, i],
                        (err) => {
                            if (err) console.error('Ошибка вставки изображения:', err);
                            if (++completed === files.length) res.json({ success: true });
                        }
                    );
                });
            }
        );
    });
});

app.put('/api/news/:id', checkToken, (req, res) => {
    upload(req, res, (err) => {
        if (err) return res.status(500).json({ error: err.message });

        const { title, content, keepImages } = req.body;
        const files = req.files || [];
        const newsId = req.params.id;

        // keepImages — JSON-массив путей к существующим картинкам, которые нужно сохранить
        let kept = [];
        try { kept = keepImages ? JSON.parse(keepImages) : []; } catch (e) { kept = []; }

        // Собираем итоговый список: сначала сохранённые, затем новые
        const allImages = [
            ...kept.map(path => path),
            ...files.map(f => `/uploads/${f.filename}`)
        ];
        const firstImg = allImages.length > 0 ? allImages[0] : null;

        // Удаляем все старые записи изображений для этой новости
        db.run('DELETE FROM news_images WHERE news_id = ?', [newsId], (err) => {
            if (err) return res.status(500).json({ error: err.message });

            // Обновляем саму новость
            db.run(
                'UPDATE news SET title=?, content=?, image=? WHERE id=?',
                [title, content, firstImg, newsId],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });

                    if (allImages.length === 0) return res.json({ success: true });

                    // Вставляем все изображения заново
                    let completed = 0;
                    allImages.forEach((imgPath, i) => {
                        db.run(
                            'INSERT INTO news_images (news_id, image_path, sort_order) VALUES (?, ?, ?)',
                            [newsId, imgPath, i],
                            (err) => {
                                if (err) console.error('Ошибка вставки изображения:', err);
                                if (++completed === allImages.length) res.json({ success: true });
                            }
                        );
                    });
                }
            );
        });
    });
});

app.delete('/api/news/:id', checkToken, (req, res) => {
    db.run('DELETE FROM news WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ==================== ОТЗЫВЫ ====================

app.get('/api/reviews', (req, res) => {
    db.all('SELECT * FROM reviews WHERE approved = 1 ORDER BY date DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

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

app.get('/api/admin/reviews', checkToken, (req, res) => {
    db.all('SELECT * FROM reviews ORDER BY approved ASC, date DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.put('/api/admin/reviews/:id/approve', checkToken, (req, res) => {
    db.run('UPDATE reviews SET approved = 1 WHERE id = ?', [req.params.id], () => {
        res.json({ success: true });
    });
});

app.delete('/api/admin/reviews/:id', checkToken, (req, res) => {
    db.run('DELETE FROM reviews WHERE id = ?', [req.params.id], () => {
        res.json({ success: true });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));

// ==================== АВТОУДАЛЕНИЕ СТАРЫХ БРОНЕЙ ====================
function cleanupOldBookings() {
    // Удаляем брони, дата которых была более 14 дней назад
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM

    db.run('DELETE FROM bookings WHERE datetime < ?', [cutoffStr], function(err) {
        if (err) return console.error('Ошибка очистки броней:', err.message);
        if (this.changes > 0) {
            console.log(`Автоудаление: удалено ${this.changes} устаревших броней (старше 14 дней)`);
        }
    });
}

// Запуск при старте сервера и затем раз в сутки
cleanupOldBookings();
setInterval(cleanupOldBookings, 24 * 60 * 60 * 1000);
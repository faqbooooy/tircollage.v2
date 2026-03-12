const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
require('dotenv').config();

// Фиксируем часовой пояс Москвы (UTC+3).
// Это влияет на new Date() и сравнение слотов на сервере.
// Клиент присылает datetime в формате ISO (YYYY-MM-DDTHH:MM) без зоны,
// сервер интерпретирует его как локальное время — поэтому TZ должен
// совпадать с реальным местоположением тира.
process.env.TZ = 'Europe/Moscow';

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

// Не более 3 бронирований с одного IP в час
const bookingLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    message: { success: false, message: 'Вы уже отправили несколько заявок. Попробуйте через час или позвоните нам.' }
});

// Не более 1 отзыва с одного IP в сутки
const reviewLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 1,
    message: { success: false, message: 'Вы уже оставили отзыв сегодня. Попробуйте завтра.' }
});

// Не более 5 попыток входа в кабинет с одного IP за 15 минут (защита от брутфорса пина)
const pinLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Слишком много попыток. Попробуйте через 15 минут.' }
});

app.set('trust proxy', 1); // Доверяем X-Forwarded-For от nginx для корректного rate limit
app.use(helmet({
    // Разрешаем загрузку шрифтов и скриптов с внешних CDN (Quill, Google Fonts)
    contentSecurityPolicy: false,
    // crossOriginEmbedderPolicy ломает Yandex Maps iframe
    crossOriginEmbedderPolicy: false
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== БАЗА И ПАПКИ ====================
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const db = new sqlite3.Database(path.join(__dirname, 'bookings.db'), (err) => {
    if (err) console.error('Ошибка БД:', err);
});

// WAL режим — снижает блокировки при одновременных запросах
// Запускается отдельно, вне транзакции
db.run('PRAGMA journal_mode=WAL', (err) => {
    if (err) console.error('WAL mode error:', err.message);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, datetime TEXT UNIQUE)`);
    db.run(`CREATE TABLE IF NOT EXISTS blocked_dates (date TEXT PRIMARY KEY)`);
    db.run(`CREATE TABLE IF NOT EXISTS blocked_ranges (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, start_time TEXT, end_time TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, image TEXT, date TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, rating INTEGER, text TEXT, date TEXT, approved INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS news_images (id INTEGER PRIMARY KEY AUTOINCREMENT, news_id INTEGER NOT NULL, image_path TEXT NOT NULL, sort_order INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    // Накопительная статистика — не удаляется при автоочистке броней
    db.run(`CREATE TABLE IF NOT EXISTS stats_daily (date TEXT PRIMARY KEY, count INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS stats_hourly (hour INTEGER PRIMARY KEY, count INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS stats_weekday (weekday INTEGER PRIMARY KEY, count INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS blacklist (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE NOT NULL, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    // Миграция: заполняем статистику из существующих броней если таблицы только что созданы
    db.run('SELECT 1', () => migrateStatsFromBookings());
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

// Отдельный инстанс для одиночной загрузки (inline-картинки в редакторе)
const uploadSingle = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|webp/;
        if (filetypes.test(file.mimetype) && filetypes.test(path.extname(file.originalname).toLowerCase())) {
            return cb(null, true);
        }
        cb(new Error("Только изображения (jpg, png, webp)!"));
    }
}).single('image');

// ==================== МИДЛВАР JWT ====================

// Хелпер: хэш пина с солью (phone как соль — уникально для каждого пользователя)
function hashPin(phone, pin) {
    return crypto.createHash('sha256').update(phone + ':' + pin).digest('hex');
}

// Мидлвар для админа
const checkToken = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    if (!token) return res.status(401).json({ error: 'Нужна авторизация' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Сессия истекла' });
        if (decoded.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
        req.admin = decoded;
        next();
    });
};

// Мидлвар для пользователя личного кабинета
const checkUserToken = (req, res, next) => {
    const token = req.headers['x-user-token'];
    if (!token) return res.status(401).json({ error: 'Нужна авторизация' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Сессия истекла' });
        if (decoded.role !== 'user') return res.status(403).json({ error: 'Нет доступа' });
        req.user = decoded;
        next();
    });
};

// ==================== СТРАНИЦЫ ====================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin-login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/cabinet', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cabinet.html')));

// ==================== АВТОРИЗАЦИЯ ====================

// Проверка: есть ли у номера пин (для переключения режима на фронте)
app.post('/api/check-phone', pinLimiter, (req, res) => {
    const phone = (req.body.phone || '').replace(/\D/g, '');
    if (phone.length !== 11) return res.status(400).json({ success: false, message: 'Неверный номер' });

    db.get('SELECT id FROM users WHERE phone = ?', [phone], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exists: !!user });
    });
});

// Регистрация пина (первый вход)
app.post('/api/user/register', pinLimiter, (req, res) => {
    const phone = (req.body.phone || '').replace(/\D/g, '');
    const pin = String(req.body.pin || '').trim();

    if (phone.length !== 11) return res.status(400).json({ success: false, message: 'Неверный номер телефона' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ success: false, message: 'Пин должен быть 4 цифры' });

    // Проверяем что этот телефон вообще есть в бронях
    db.get('SELECT id FROM bookings WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone," ",""),"-",""),"(",""),")",""),"+","") = ?',
        [phone],
        (err, booking) => {
            if (!booking) return res.status(403).json({ success: false, message: 'Номер не найден в системе. Сначала оформите бронь.' });

            const pin_hash = hashPin(phone, pin);
            db.run('INSERT INTO users (phone, pin_hash) VALUES (?, ?)', [phone, pin_hash], function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) return res.status(409).json({ success: false, message: 'Этот номер уже зарегистрирован' });
                    return res.status(500).json({ error: err.message });
                }
                const token = jwt.sign({ role: 'user', phone }, JWT_SECRET, { expiresIn: '7d' });
                res.json({ success: true, token });
            });
        }
    );
});

// Вход пользователя по номеру + пину
app.post('/api/user/login', pinLimiter, (req, res) => {
    const phone = (req.body.phone || '').replace(/\D/g, '');
    const pin = String(req.body.pin || '').trim();

    if (phone.length !== 11) return res.status(400).json({ success: false, message: 'Неверный номер телефона' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ success: false, message: 'Введите 4-значный пин' });

    const pin_hash = hashPin(phone, pin);
    db.get('SELECT id FROM users WHERE phone = ? AND pin_hash = ?', [phone, pin_hash], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ success: false, message: 'Неверный номер или пин' });

        const token = jwt.sign({ role: 'user', phone }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token });
    });
});

// Вход администратора
app.post('/api/admin-login', loginLimiter, (req, res) => {
    const { username, password, remember } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin', user: username }, JWT_SECRET, { expiresIn: '24h' });

        if (remember) {
            const rememberToken = jwt.sign({ role: 'admin', user: username, type: 'remember' }, JWT_SECRET, { expiresIn: '30d' });
            res.cookie('adminRemember', rememberToken, {
                httpOnly: true,
                sameSite: 'lax',
                maxAge: 30 * 24 * 60 * 60 * 1000,
                path: '/'
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
            res.clearCookie('adminRemember', { path: '/' });
            return res.status(401).json({ success: false });
        }
        const token = jwt.sign({ role: 'admin', user: decoded.user }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token });
    });
});

// Выход — удаляем cookie
app.post('/api/admin-logout', (req, res) => {
    res.clearCookie('adminRemember', { path: '/' });
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

app.post('/api/book', bookingLimiter, (req, res) => {
    const { name, phone, datetime, website } = req.body;

    // Honeypot: боты заполняют скрытые поля, люди — нет
    if (website) {
        return res.json({ success: true }); // тихо игнорируем, не сообщаем боту об ошибке
    }

    // Валидация полей
    if (!name || !phone || !datetime) {
        return res.status(400).json({ success: false, message: 'Заполните все поля' });
    }
    if (name.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Укажите корректное имя' });
    }

    // Валидация телефона: только российские номера (+7 или 8, 11 цифр)
    const phoneDigits = phone.replace(/\D/g, '');
    const isRussianPhone = phoneDigits.length === 11 && (phoneDigits[0] === '7' || phoneDigits[0] === '8');
    if (!isRussianPhone) {
        return res.status(400).json({ success: false, message: 'Укажите российский номер телефона (+7 или 8)' });
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

    // Проверка чёрного списка
    const normalizedPhone = phoneDigits.startsWith('8') ? '7' + phoneDigits.slice(1) : phoneDigits;
    db.get('SELECT id FROM blacklist WHERE phone = ?', [normalizedPhone], (err, blacklisted) => {
        if (blacklisted) {
            return res.json({ success: false, message: 'Запись с этого номера недоступна. Обратитесь в тир.' });
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
                incrementStats(datetime);
                res.json({ success: true });
            });
        });
    });
    }); // конец проверки чёрного списка
});

// Ручное добавление брони администратором — без rate limit
app.post('/api/admin/book', checkToken, (req, res) => {
    const { name, phone, datetime } = req.body;

    if (!name || !phone || !datetime) {
        return res.status(400).json({ success: false, message: 'Заполните все поля' });
    }
    if (name.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Укажите корректное имя' });
    }

    const phoneDigits = phone.replace(/\D/g, '');
    const isRussianPhone = phoneDigits.length === 11 && (phoneDigits[0] === '7' || phoneDigits[0] === '8');
    if (!isRussianPhone) {
        return res.status(400).json({ success: false, message: 'Укажите российский номер телефона' });
    }

    const bookingTime = new Date(datetime);
    if (isNaN(bookingTime.getTime())) {
        return res.status(400).json({ success: false, message: 'Некорректный формат времени' });
    }

    const bookingDate = datetime.split('T')[0];
    const bookingTimeStr = datetime.split('T')[1]?.slice(0, 5);

    db.get('SELECT date FROM blocked_dates WHERE date = ?', [bookingDate], (err, blockedDay) => {
        if (blockedDay) return res.json({ success: false, message: 'В этот день запись недоступна' });

        db.all('SELECT start_time, end_time FROM blocked_ranges WHERE date = ?', [bookingDate], (err, ranges) => {
            const isBlocked = (ranges || []).some(r => bookingTimeStr >= r.start_time && bookingTimeStr < r.end_time);
            if (isBlocked) return res.json({ success: false, message: 'Это время недоступно для записи' });

            db.run('INSERT INTO bookings (name, phone, datetime) VALUES (?, ?, ?)',
                [name.trim(), phone.trim(), datetime],
                function(err) {
                    if (err) {
                        if (err.message.includes('UNIQUE')) {
                            return res.json({ success: false, message: 'Это время уже занято!' });
                        }
                        return res.status(500).json({ success: false, message: 'Ошибка базы данных' });
                    }
                    incrementStats(datetime);
                    res.json({ success: true });
                }
            );
        });
    });
});

app.delete('/api/bookings/:id', checkToken, (req, res) => {
    db.run('DELETE FROM bookings WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Бронь не найдена' });
        res.json({ success: true });
    });
});

// ==================== ЧЁРНЫЙ СПИСОК ====================
app.get('/api/blacklist', checkToken, (req, res) => {
    db.all('SELECT * FROM blacklist ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post('/api/blacklist', checkToken, (req, res) => {
    let { phone, reason } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Укажите номер телефона' });
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 11) return res.status(400).json({ success: false, message: 'Некорректный номер' });
    const normalized = digits.startsWith('8') ? '7' + digits.slice(1) : digits;

    db.run('INSERT OR IGNORE INTO blacklist (phone, reason) VALUES (?, ?)',
        [normalized, reason || ''],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.json({ success: false, message: 'Номер уже в чёрном списке' });

            // Ищем активные брони этого номера (в будущем)
            const d = new Date();
            const now = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
            db.all(
                `SELECT id, name, datetime FROM bookings
                 WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone," ",""),"-",""),"(",""),")",""),"+","") = ?
                 AND datetime >= ?
                 ORDER BY datetime ASC`,
                [normalized, now],
                (err, bookings) => {
                    if (err) return res.json({ success: true, activeBookings: [] });
                    res.json({ success: true, id: this.lastID, activeBookings: bookings || [] });
                }
            );
        }
    );
});

app.delete('/api/blacklist/:id', checkToken, (req, res) => {
    db.run('DELETE FROM blacklist WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: 'Запись не найдена' });
        res.json({ success: true });
    });
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
    db.run('DELETE FROM blocked_dates WHERE date = ?', [req.params.date], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
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
    db.run('DELETE FROM blocked_ranges WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

// ==================== ЗАГРУЗКА INLINE-ИЗОБРАЖЕНИЙ ====================
// Используется редактором новостей для вставки картинок прямо в текст
app.post('/api/upload-inline', checkToken, (req, res) => {
    uploadSingle(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        if (!req.file) return res.status(400).json({ success: false, message: 'Файл не получен' });
        res.json({ success: true, url: `/uploads/${req.file.filename}` });
    });
});

// ==================== НОВОСТИ ====================
app.get('/api/news', (req, res) => {
    db.all('SELECT * FROM news ORDER BY id DESC', (err, newsRows) => {
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
    const newsId = req.params.id;

    // Получаем пути всех картинок новости перед удалением
    db.all('SELECT image_path FROM news_images WHERE news_id = ?', [newsId], (err, imgRows) => {
        db.get('SELECT image FROM news WHERE id = ?', [newsId], (err, newsRow) => {

            db.run('DELETE FROM news WHERE id = ?', [newsId], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ success: false, message: 'Новость не найдена' });

                // Удаляем записи из news_images
                db.run('DELETE FROM news_images WHERE news_id = ?', [newsId]);

                // Собираем все пути и удаляем файлы с диска
                const paths = (imgRows || []).map(r => r.image_path);
                if (newsRow?.image && !paths.includes(newsRow.image)) paths.push(newsRow.image);

                paths.forEach(imgPath => {
                    if (!imgPath || imgPath.startsWith('http')) return;
                    const fullPath = path.join(__dirname, 'public', imgPath);
                    fs.unlink(fullPath, (err) => {
                        if (err && err.code !== 'ENOENT') {
                            console.error(`Не удалось удалить файл ${fullPath}:`, err.message);
                        }
                    });
                });

                res.json({ success: true });
            });
        });
    });
});

// ==================== ОТЗЫВЫ ====================

app.get('/api/reviews', (req, res) => {
    db.all('SELECT * FROM reviews WHERE approved = 1 ORDER BY date DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/reviews', reviewLimiter, (req, res) => {
    const { name, rating, text, website } = req.body;

    // Honeypot
    if (website) return res.json({ success: true });

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
            res.json({ success: true, id: this.lastID });
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
    db.run('DELETE FROM reviews WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

// ==================== ЛИЧНЫЙ КАБИНЕТ ====================

// Мои брони (предстоящие и прошлые)
app.get('/api/cabinet/bookings', checkUserToken, (req, res) => {
    const phone = req.user.phone;
    db.all(
        `SELECT * FROM bookings WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone," ",""),"-",""),"(",""),")",""),"+","") = ? ORDER BY datetime DESC`,
        [phone],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// Отмена брони (только если до неё > 1 часа)
app.delete('/api/cabinet/bookings/:id', checkUserToken, (req, res) => {
    const phone = req.user.phone;
    db.get('SELECT * FROM bookings WHERE id = ?', [req.params.id], (err, booking) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!booking) return res.status(404).json({ success: false, message: 'Бронь не найдена' });

        // Проверяем что это бронь этого пользователя
        const bookingPhone = booking.phone.replace(/\D/g, '');
        if (bookingPhone !== phone) {
            return res.status(403).json({ success: false, message: 'Нет доступа' });
        }

        // Проверяем что до брони > 1 часа
        const bookingTime = new Date(booking.datetime);
        const hoursUntil = (bookingTime - new Date()) / (1000 * 60 * 60);
        if (hoursUntil < 1) {
            return res.status(400).json({ success: false, message: 'Отменить можно не позднее чем за 1 час до визита' });
        }

        db.run('DELETE FROM bookings WHERE id = ?', [req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// Мои отзывы
app.get('/api/cabinet/reviews', checkUserToken, (req, res) => {
    const phone = req.user.phone;
    // Ищем отзывы по имени — связываем через брони этого телефона
    db.get(
        `SELECT name FROM bookings WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone," ",""),"-",""),"(",""),")",""),"+","") = ? LIMIT 1`,
        [phone],
        (err, booking) => {
            if (err || !booking) return res.json([]);
            db.all('SELECT * FROM reviews WHERE name = ? ORDER BY date DESC', [booking.name], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows);
            });
        }
    );
});

// ==================== СТАТИСТИКА ====================
app.get('/api/stats', checkToken, (req, res) => {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const weekStr = weekStart.toISOString().slice(0, 10);
    const monthStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);

    const stats = {};

    // Всего броней из накопительной статистики
    db.get('SELECT SUM(count) as cnt FROM stats_daily', (err, row) => {
        stats.total = row?.cnt || 0;

        // За эту неделю
        db.get('SELECT SUM(count) as cnt FROM stats_daily WHERE date >= ?', [weekStr], (err, row) => {
            stats.week = row?.cnt || 0;

            // За этот месяц
            db.get('SELECT SUM(count) as cnt FROM stats_daily WHERE date >= ?', [monthStr], (err, row) => {
                stats.month = row?.cnt || 0;

                // Отзывы
                db.get('SELECT COUNT(*) as cnt, AVG(rating) as avg FROM reviews WHERE approved = 1', (err, row) => {
                    stats.reviews = row?.cnt || 0;
                    stats.rating = row?.avg ? Math.round(row.avg * 10) / 10 : null;

                    db.get('SELECT COUNT(*) as cnt FROM reviews WHERE approved = 0', (err, row) => {
                        stats.pending = row?.cnt || 0;

                        // Популярные часы из накопительной таблицы
                        db.all('SELECT hour, count as cnt FROM stats_hourly ORDER BY cnt DESC LIMIT 5', (err, rows) => {
                            stats.popularHours = (rows || []).map(r => ({
                                hour: String(r.hour).padStart(2, '0'),
                                cnt: r.cnt
                            }));

                            // Дни недели из накопительной таблицы
                            const dayNames = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
                            db.all('SELECT weekday, count as cnt FROM stats_weekday ORDER BY weekday', (err, rows) => {
                                const map = {};
                                (rows || []).forEach(r => map[r.weekday] = r.cnt);
                                stats.weekdays = dayNames.map((name, i) => ({ name, cnt: map[i] || 0 }));
                                res.json(stats);
                            });
                        });
                    });
                });
            });
        });
    });
});

// ==================== 404 ====================
app.use((req, res) => {
    // API-запросы получают JSON
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Не найдено' });
    }
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ==================== ГЛОБАЛЬНЫЙ ОБРАБОТЧИК ОШИБОК ====================
// Перехватывает необработанные ошибки Express и логирует их с контекстом
app.use((err, req, res, next) => {
    console.error(`[${new Date().toISOString()}] Необработанная ошибка:`, {
        method: req.method,
        url: req.url,
        error: err.message,
        stack: err.stack
    });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));

// ==================== НАКОПИТЕЛЬНАЯ СТАТИСТИКА ====================

// Инкремент при новой брони
function incrementStats(datetimeStr) {
    const d = new Date(datetimeStr);
    const date = datetimeStr.slice(0, 10);           // YYYY-MM-DD
    const hour = d.getHours();                        // 0-23
    const weekday = d.getDay();                       // 0=вс, 1=пн...

    db.run(`INSERT INTO stats_daily (date, count) VALUES (?, 1)
            ON CONFLICT(date) DO UPDATE SET count = count + 1`, [date]);
    db.run(`INSERT INTO stats_hourly (hour, count) VALUES (?, 1)
            ON CONFLICT(hour) DO UPDATE SET count = count + 1`, [hour]);
    db.run(`INSERT INTO stats_weekday (weekday, count) VALUES (?, 1)
            ON CONFLICT(weekday) DO UPDATE SET count = count + 1`, [weekday]);
}

// Миграция: заполняем статистику из существующих броней (запускается один раз при старте)
function migrateStatsFromBookings() {
    db.get('SELECT COUNT(*) as cnt FROM stats_daily', (err, row) => {
        if (err || (row && row.cnt > 0)) return; // уже есть данные — пропускаем
        db.all('SELECT datetime FROM bookings', (err, rows) => {
            if (err || !rows.length) return;
            console.log(`[stats] Миграция: обрабатываем ${rows.length} броней...`);
            rows.forEach(r => incrementStats(r.datetime));
            console.log('[stats] Миграция завершена');
        });
    });
}

// ==================== АВТОУДАЛЕНИЕ СТАРЫХ БРОНЕЙ ====================
function cleanupOldBookings() {
    // Удаляем брони, дата которых была более 1 года назад
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const cutoffStr = cutoff.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM

    db.run('DELETE FROM bookings WHERE datetime < ?', [cutoffStr], function(err) {
        if (err) return console.error('Ошибка очистки броней:', err.message);
        if (this.changes > 0) {
            console.log(`Автоудаление: удалено ${this.changes} устаревших броней (старше 1 года)`);
        }
    });
}

// Запуск при старте сервера и затем раз в сутки
cleanupOldBookings();
setInterval(cleanupOldBookings, 24 * 60 * 60 * 1000);
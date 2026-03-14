// ==================== АВТОРИЗАЦИЯ ====================

function getToken() { return localStorage.getItem('userToken'); }

function authHeaders() {
    return { 'Content-Type': 'application/json', 'X-User-Token': getToken() };
}

function parsePhone(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.phone || '';
    } catch { return ''; }
}

// БАГ 11 FIX: проверяем истёк ли токен по полю exp в payload
// Если истёк — показываем понятное сообщение вместо молчаливого редиректа
function isTokenExpired(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp && payload.exp * 1000 < Date.now();
    } catch { return true; }
}

function formatPhone(phone) {
    const d = String(phone).replace(/\D/g, '');
    if (d.length !== 11) return phone;
    return `+7 (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7,9)}-${d.slice(9,11)}`;
}

// Проверяем токен при загрузке
(async () => {
    const token = getToken();
    if (!token) { window.location.replace('/login'); return; }

    // БАГ 11 FIX: проверяем срок токена до запроса — показываем понятный тост
    if (isTokenExpired(token)) {
        localStorage.removeItem('userToken');
        // Передаём сообщение через sessionStorage чтобы показать на странице логина
        sessionStorage.setItem('loginHint', 'Сессия истекла, войдите снова');
        window.location.replace('/login');
        return;
    }

    try {
        const res = await fetch('/api/cabinet/bookings', { headers: authHeaders() });
        if (res.status === 401 || res.status === 403) {
            localStorage.removeItem('userToken');
            sessionStorage.setItem('loginHint', 'Сессия истекла, войдите снова');
            window.location.replace('/login');
            return;
        }
        const bookings = await res.json();

        // Показываем номер телефона
        const phone = parsePhone(token);
        document.getElementById('cabinet-phone').textContent = formatPhone(phone);

        renderBookings(bookings);
    } catch {
        window.location.replace('/login');
    }
})();

// ==================== ВЫХОД ====================

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('userToken');
    window.location.replace('/login');
});

// ==================== ТАБЫ ====================

document.querySelectorAll('.cabinet-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.cabinet-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.cabinet-tab-content').forEach(c => c.style.display = 'none');
        document.getElementById('cab-tab-' + tab.dataset.tab).style.display = 'block';
    });
});

// ==================== БРОНИ ====================

function formatDateTime(datetime) {
    const d = new Date(datetime);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
        + ' в ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function hoursUntil(datetime) {
    return (new Date(datetime) - new Date()) / (1000 * 60 * 60);
}

function renderBookings(bookings) {
    const now = new Date();
    const upcoming = bookings.filter(b => new Date(b.datetime) > now);
    const past = bookings.filter(b => new Date(b.datetime) <= now);

    // Предстоящие
    const upcomingEl = document.getElementById('upcoming-list');
    if (upcoming.length === 0) {
        upcomingEl.innerHTML = '<p class="cabinet-empty">Предстоящих броней нет. <a href="/#booking">Записаться?</a></p>';
    } else {
        upcomingEl.innerHTML = '';
        upcoming.forEach(b => {
            const card = document.createElement('div');
            card.className = 'cabinet-booking-card';
            const canCancel = hoursUntil(b.datetime) >= 1;

            card.innerHTML = `
                <div class="cabinet-booking-info">
                    <div class="cabinet-booking-date">${formatDateTime(b.datetime)}</div>
                    <div class="cabinet-booking-name">${escapeHtml(b.name)}</div>
                </div>
                <div class="cabinet-booking-actions">
                    ${canCancel
                        ? `<button class="cabinet-cancel-btn" data-id="${b.id}" data-date="${formatDateTime(b.datetime)}">Отменить</button>`
                        : `<span class="cabinet-cancel-soon">Отмена недоступна<br><small>менее 1 часа</small></span>`
                    }
                </div>
            `;
            upcomingEl.appendChild(card);
        });
    }

    // История
    const pastEl = document.getElementById('past-list');
    if (past.length === 0) {
        pastEl.innerHTML = '<p class="cabinet-empty">Истории посещений пока нет.</p>';
    } else {
        pastEl.innerHTML = '';
        past.forEach(b => {
            const card = document.createElement('div');
            card.className = 'cabinet-booking-card cabinet-booking-card--past';
            card.innerHTML = `
                <div class="cabinet-booking-info">
                    <div class="cabinet-booking-date">${formatDateTime(b.datetime)}</div>
                    <div class="cabinet-booking-name">${escapeHtml(b.name)}</div>
                </div>
                <span class="cabinet-badge">Посещено</span>
            `;
            pastEl.appendChild(card);
        });
    }

    // Навешиваем обработчики отмены
    document.querySelectorAll('.cabinet-cancel-btn').forEach(btn => {
        btn.addEventListener('click', () => confirmCancel(btn.dataset.id, btn.dataset.date));
    });
}

// ==================== ОТМЕНА БРОНИ ====================

let cancelTarget = null;

function confirmCancel(id, dateStr) {
    cancelTarget = id;
    document.getElementById('cancel-modal-text').textContent =
        `Отменить бронь на ${dateStr}?`;
    document.getElementById('cancel-modal').style.display = 'flex';
}

document.getElementById('cancel-confirm').addEventListener('click', async () => {
    if (!cancelTarget) return;
    document.getElementById('cancel-modal').style.display = 'none';

    try {
        const res = await fetch(`/api/cabinet/bookings/${cancelTarget}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        const data = await res.json();

        if (data.success) {
            // Перезагружаем брони
            const res2 = await fetch('/api/cabinet/bookings', { headers: authHeaders() });
            renderBookings(await res2.json());
        } else {
            alert(data.message || 'Ошибка при отмене');
        }
    } catch { alert('Ошибка соединения'); }

    cancelTarget = null;
});

document.getElementById('cancel-dismiss').addEventListener('click', () => {
    document.getElementById('cancel-modal').style.display = 'none';
    cancelTarget = null;
});

// ==================== XSS-защита ====================
function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
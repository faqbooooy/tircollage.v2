// ================= ИНИЦИАЛИЗАЦИЯ =================

let quill;

document.addEventListener('DOMContentLoaded', async () => {
    const ok = await checkAuth();
    if (!ok) return;

    initTabs();
    initQuill();
    initForms();

    loadBookings();
    startPolling();
});

// ================= АВТОРИЗАЦИЯ =================

function authHeaders(extra = {}) {
    return {
        'X-Admin-Token': localStorage.getItem('adminToken'),
        ...extra
    };
}

async function checkAuth() {
    const token = localStorage.getItem('adminToken');
    if (!token) {
        window.location.href = '/admin-login';
        return false;
    }

    try {
        const res = await fetch('/api/check-auth', {
            headers: authHeaders()
        });

        if (!res.ok) {
            localStorage.removeItem('adminToken');
            window.location.href = '/admin-login';
            return false;
        }
    } catch {
        showError('Нет связи с сервером. Проверьте подключение.');
        return false;
    }

    return true;
}

// ================= POLLING =================

function startPolling() {
    setInterval(() => {
        // Обновляем только если вкладка "Брони" активна — незачем грузить фоном
        const bookingsTab = document.getElementById('bookings');
        if (bookingsTab && bookingsTab.classList.contains('active')) {
            loadBookings();
        }
    }, 30000); // каждые 30 секунд
}

// ================= ВКЛАДКИ =================

function initTabs() {
    const loaders = {
        bookings: loadBookings,
        blocked: () => { loadBlocked(); loadBlockedRanges(); },
        'news-add': () => {},           // форма всегда готова, грузить нечего
        'news-list-tab': loadNews,
        'reviews-tab': loadAdminReviews
    };

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');

            loaders[btn.dataset.tab]?.();
        });
    });
}

// ================= QUILL =================

function initQuill() {
    quill = new Quill('#editor', {
        theme: 'snow',
        placeholder: 'Текст новости...'
    });
}

// ================= ВСПОМОГАТЕЛЬНОЕ =================

function showError(message) {
    console.error(message);
    alert(message);
}

// ================= БРОНИ =================

// ================= БРОНИ + КАЛЕНДАРЬ =================

let allBookings = [];
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let selectedDate = null;

async function loadBookings() {
    try {
        const res = await fetch('/api/bookings', { headers: authHeaders() });
        if (!res.ok) throw new Error(`Ошибка: ${res.status}`);
        allBookings = await res.json();
        renderCalendar();
        if (selectedDate) renderDayBookings(selectedDate);
    } catch (err) {
        showError('Не удалось загрузить брони: ' + err.message);
    }
}

function renderCalendar() {
    const monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                        'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

    document.getElementById('cal-month-label').textContent =
        `${monthNames[calMonth]} ${calYear}`;

    // Считаем сколько броней на каждый день месяца
    const counts = {};
    allBookings.forEach(b => {
        const d = b.datetime.split('T')[0];
        counts[d] = (counts[d] || 0) + 1;
    });

    const firstDay = new Date(calYear, calMonth, 1);
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    // Понедельник = 0
    let startDow = firstDay.getDay() - 1;
    if (startDow < 0) startDow = 6;

    const today = new Date().toISOString().split('T')[0];
    const container = document.getElementById('cal-days');
    container.innerHTML = '';

    // Пустые ячейки до первого дня
    for (let i = 0; i < startDow; i++) {
        const empty = document.createElement('div');
        empty.className = 'cal-day cal-day--empty';
        container.appendChild(empty);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${calYear}-${String(calMonth + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const count = counts[dateStr] || 0;

        const cell = document.createElement('div');
        cell.className = 'cal-day';
        if (dateStr === today) cell.classList.add('cal-day--today');
        if (dateStr === selectedDate) cell.classList.add('cal-day--selected');
        if (count > 0) cell.classList.add('cal-day--has-bookings');

        cell.innerHTML = `<span class="cal-day-num">${d}</span>
            ${count > 0 ? `<span class="cal-day-count">${count}</span>` : ''}`;

        cell.addEventListener('click', () => {
            selectedDate = dateStr;
            renderCalendar(); // перерисовываем чтобы выделить выбранный день
            renderDayBookings(dateStr);
        });

        container.appendChild(cell);
    }

    // Навигация
    document.getElementById('cal-prev').onclick = () => {
        calMonth--;
        if (calMonth < 0) { calMonth = 11; calYear--; }
        renderCalendar();
    };
    document.getElementById('cal-next').onclick = () => {
        calMonth++;
        if (calMonth > 11) { calMonth = 0; calYear++; }
        renderCalendar();
    };
}

function renderDayBookings(dateStr) {
    const dayBookings = allBookings.filter(b => b.datetime.startsWith(dateStr));
    const container = document.getElementById('bookings-container');
    const title = document.getElementById('bookings-day-title');

    const dateObj = new Date(dateStr + 'T00:00:00');
    const formatted = dateObj.toLocaleDateString('ru-RU', {
        weekday: 'long', day: 'numeric', month: 'long'
    });
    title.textContent = formatted.charAt(0).toUpperCase() + formatted.slice(1);

    container.innerHTML = '';

    if (dayBookings.length === 0) {
        container.innerHTML = '<p class="empty-state">В этот день броней нет</p>';
        return;
    }

    // Сортируем по времени
    dayBookings.sort((a, b) => a.datetime.localeCompare(b.datetime));

    dayBookings.forEach(b => {
        const time = b.datetime.split('T')[1].slice(0, 5);
        const item = document.createElement('div');
        item.className = 'booking-item';
        item.innerHTML = `
            <span class="booking-time">${time}</span>
            <span class="booking-name">${b.name}</span>
            <span class="booking-phone">${b.phone}</span>
            <button class="booking-delete-btn">Удалить</button>
        `;
        item.querySelector('button').addEventListener('click', () => deleteBooking(b.id, item, dateStr));
        container.appendChild(item);
    });
}

async function deleteBooking(id, row, dateStr) {
    if (!confirm('Удалить эту бронь?')) return;
    try {
        await fetch(`/api/bookings/${id}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        // Убираем из локального массива и перерисовываем
        allBookings = allBookings.filter(b => b.id !== id);
        row.remove();
        renderCalendar();
        // Если в этот день больше нет броней — показываем пустое состояние
        if (dateStr && !allBookings.some(b => b.datetime.startsWith(dateStr))) {
            document.getElementById('bookings-container').innerHTML =
                '<p class="empty-state">В этот день броней нет</p>';
        }
    } catch (err) {
        showError('Ошибка при удалении: ' + err.message);
    }
}

// ================= ЗАПРЕЩЁННЫЕ ДНИ =================

function initForms() {
    document.getElementById('block-form').addEventListener('submit', async e => {
        e.preventDefault();
        const input = document.getElementById('block-date');
        const date = input.value;

        try {
            await fetch('/api/block-date', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ date })
            });
            input.value = '';
            loadBlocked();
        } catch (err) {
            showError('Ошибка при добавлении даты: ' + err.message);
        }
    });

    document.getElementById('block-range-form').addEventListener('submit', async e => {
        e.preventDefault();
        const date = document.getElementById('range-date').value;
        const start_time = document.getElementById('range-start').value;
        const end_time = document.getElementById('range-end').value;

        try {
            const res = await fetch('/api/block-range', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ date, start_time, end_time })
            });
            const result = await res.json();
            if (!result.success) {
                showError(result.message);
                return;
            }
            document.getElementById('block-range-form').reset();
            loadBlockedRanges();
        } catch (err) {
            showError('Ошибка при добавлении диапазона: ' + err.message);
        }
    });

    document.getElementById('news-preview-btn').addEventListener('click', showNewsPreview);
    document.getElementById('news-preview-close').addEventListener('click', closeNewsPreview);
    document.getElementById('news-preview-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('news-preview-modal')) closeNewsPreview();
    });

    document.getElementById('news-image').addEventListener('change', (e) => {
        const label = document.getElementById('file-label-text');
        label.textContent = e.target.files[0]
            ? '✅ ' + e.target.files[0].name
            : '📎 Прикрепить изображение';
    });

    document.getElementById('news-form').addEventListener('submit', submitNews);
}

async function loadBlocked() {
    try {
        const res = await fetch('/api/blocked-dates', {
            headers: authHeaders()
        });

        if (!res.ok) throw new Error(`Ошибка: ${res.status}`);

        const dates = await res.json();
        const list = document.getElementById('blocked-list');
        list.innerHTML = '';

        if (dates.length === 0) {
            list.innerHTML = '<li style="opacity:0.5;">Запрещённых дней нет</li>';
            return;
        }

        dates.forEach(d => {
            const li = document.createElement('li');
            li.innerHTML = `<span>${d}</span><button>Удалить</button>`;
            li.querySelector('button').addEventListener('click', async () => {
                try {
                    await fetch(`/api/blocked-dates/${d}`, {
                        method: 'DELETE',
                        headers: authHeaders()
                    });
                    li.remove();
                } catch (err) {
                    showError('Ошибка при удалении: ' + err.message);
                }
            });
            list.appendChild(li);
        });

    } catch (err) {
        showError('Не удалось загрузить запрещённые даты: ' + err.message);
    }
}

async function loadBlockedRanges() {
    try {
        const res = await fetch('/api/blocked-ranges', {
            headers: authHeaders()
        });

        if (!res.ok) throw new Error(`Ошибка: ${res.status}`);

        const ranges = await res.json();
        const list = document.getElementById('blocked-ranges-list');
        list.innerHTML = '';

        if (ranges.length === 0) {
            list.innerHTML = '<li style="opacity:0.5;">Диапазонов нет</li>';
            return;
        }

        ranges.forEach(r => {
            const li = document.createElement('li');
            li.innerHTML = `
                <span>${r.date}, с ${r.start_time} до ${r.end_time}</span>
                <button>Удалить</button>
            `;
            li.querySelector('button').addEventListener('click', async () => {
                try {
                    await fetch(`/api/blocked-ranges/${r.id}`, {
                        method: 'DELETE',
                        headers: authHeaders()
                    });
                    li.remove();
                } catch (err) {
                    showError('Ошибка при удалении: ' + err.message);
                }
            });
            list.appendChild(li);
        });

    } catch (err) {
        showError('Не удалось загрузить диапазоны: ' + err.message);
    }
}

// ================= НОВОСТИ =================

async function loadNews() {
    try {
        const res = await fetch('/api/news', {
            headers: authHeaders()
        });

        if (!res.ok) throw new Error(`Ошибка: ${res.status}`);

        const news = await res.json();
        const container = document.getElementById('news-list');
        container.innerHTML = '';

        if (news.length === 0) {
            container.innerHTML = '<p class="empty-state">Новостей пока нет</p>';
            return;
        }

        news.forEach(item => {
            const div = document.createElement('div');
            div.className = 'news-card';
            div.innerHTML = `
                ${item.image ? `<img src="${item.image}" alt="${item.title}" class="news-card-img">` : ''}
                <div class="news-card-body">
                    <strong>${item.title}</strong>
                    <small>${item.date || ''}</small>
                </div>
                <div class="news-actions">
                    <button data-edit="${item.id}">Редактировать</button>
                    <button data-delete="${item.id}">Удалить</button>
                </div>
            `;

            div.querySelector('[data-edit]').addEventListener('click', () => {
                switchTab('news-add');
                document.getElementById('news-title').value = item.title;
                quill.root.innerHTML = item.content;
                document.getElementById('news-submit').textContent = 'Сохранить';
                document.getElementById('news-submit').dataset.editId = item.id;
                document.querySelector('#news-add .tab-title').textContent = 'Редактировать новость';
            });

            div.querySelector('[data-delete]').addEventListener('click', async () => {
                if (!confirm(`Удалить новость "${item.title}"?`)) return;
                try {
                    await fetch(`/api/news/${item.id}`, {
                        method: 'DELETE',
                        headers: authHeaders()
                    });
                    div.remove();
                } catch (err) {
                    showError('Ошибка при удалении: ' + err.message);
                }
            });

            container.appendChild(div);
        });

    } catch (err) {
        showError('Не удалось загрузить новости: ' + err.message);
    }
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
    document.getElementById(tabId).classList.add('active');
}

function showNewsPreview() {
    const title = document.getElementById('news-title').value || 'Заголовок новости';
    const content = quill.root.innerHTML;
    const file = document.getElementById('news-image').files[0];
    const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

    const modal = document.getElementById('news-preview-modal');

    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            document.getElementById('preview-img').src = e.target.result;
            document.getElementById('preview-img').style.display = 'block';
        };
        reader.readAsDataURL(file);
    } else {
        document.getElementById('preview-img').style.display = 'none';
    }

    document.getElementById('preview-title').textContent = title;
    document.getElementById('preview-date').textContent = date;
    document.getElementById('preview-body').innerHTML = content;

    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeNewsPreview() {
    document.getElementById('news-preview-modal').style.display = 'none';
    document.body.style.overflow = '';
}

async function submitNews(e) {
    e.preventDefault();

    const submitBtn = document.getElementById('news-submit');
    const editId = submitBtn.dataset.editId;
    const isEdit = !!editId;

    const formData = new FormData();
    formData.append('title', document.getElementById('news-title').value);
    formData.append('content', quill.root.innerHTML);

    const file = document.getElementById('news-image').files[0];
    if (file) formData.append('image', file);

    try {
        const url = isEdit ? `/api/news/${editId}` : '/api/news';
        const method = isEdit ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method,
            headers: authHeaders(),
            body: formData
        });

        if (!res.ok) throw new Error(`Ошибка: ${res.status}`);

    } catch (err) {
        showError('Ошибка при сохранении новости: ' + err.message);
        return;
    }

    resetNewsForm();
    switchTab('news-list-tab');
    loadNews();
}

function resetNewsForm() {
    const submitBtn = document.getElementById('news-submit');
    submitBtn.textContent = 'Опубликовать';
    delete submitBtn.dataset.editId;
    document.getElementById('news-form').reset();
    document.getElementById('file-label-text').textContent = '📎 Прикрепить изображение';
    document.querySelector('#news-add .tab-title').textContent = 'Добавить новость';
    quill.root.innerHTML = '';
}

// ================= ОТЗЫВЫ =================

async function loadAdminReviews() {
    try {
        const res = await fetch('/api/admin/reviews', { headers: authHeaders() });
        if (!res.ok) throw new Error(`Ошибка: ${res.status}`);
        const reviews = await res.json();

        const pending = reviews.filter(r => !r.approved);
        const approved = reviews.filter(r => r.approved);

        renderAdminReviews('reviews-pending', pending, false);
        renderAdminReviews('reviews-approved', approved, true);
    } catch (err) {
        showError('Не удалось загрузить отзывы: ' + err.message);
    }
}

function renderAdminReviews(containerId, reviews, isApproved) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    if (reviews.length === 0) {
        container.innerHTML = '<p class="empty-state">Нет отзывов</p>';
        return;
    }

    reviews.forEach(r => {
        const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
        const card = document.createElement('div');
        card.className = 'admin-review-card';
        card.innerHTML = `
            <div class="admin-review-header">
                <span class="admin-review-name">${r.name}</span>
                <span class="admin-review-stars">${stars}</span>
                <span class="admin-review-date">${r.date}</span>
            </div>
            <p class="admin-review-text">${r.text}</p>
            <div class="admin-review-actions">
                ${!isApproved ? `<button class="btn-approve" data-id="${r.id}">✓ Опубликовать</button>` : ''}
                <button class="btn-reject" data-id="${r.id}">Удалить</button>
            </div>
        `;

        if (!isApproved) {
            card.querySelector('.btn-approve').addEventListener('click', async () => {
                await fetch(`/api/admin/reviews/${r.id}/approve`, {
                    method: 'PUT', headers: authHeaders()
                });
                loadAdminReviews();
            });
        }

        card.querySelector('.btn-reject').addEventListener('click', async () => {
            if (!confirm('Удалить отзыв?')) return;
            await fetch(`/api/admin/reviews/${r.id}`, {
                method: 'DELETE', headers: authHeaders()
            });
            loadAdminReviews();
        });

        container.appendChild(card);
    });
}
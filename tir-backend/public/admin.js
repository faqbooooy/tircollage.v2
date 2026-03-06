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
        const bookingsTab = document.getElementById('bookings');
        if (bookingsTab && bookingsTab.classList.contains('active')) {
            loadBookings();
        }
    }, 30000);
}

// ================= ВКЛАДКИ =================

function initTabs() {
    const loaders = {
        bookings: loadBookings,
        blocked: () => { loadBlocked(); loadBlockedRanges(); },
        'news-add': () => {},
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
    showToast(message, 'error');
}

// ================= TOAST =================

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) {
        // Если контейнера нет, создадим временный
        const newContainer = document.createElement('div');
        newContainer.id = 'toast-container';
        newContainer.className = 'toast-container';
        document.body.appendChild(newContainer);
        showToast(message, type);
        return;
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

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

    const counts = {};
    allBookings.forEach(b => {
        const d = b.datetime.split('T')[0];
        counts[d] = (counts[d] || 0) + 1;
    });

    const firstDay = new Date(calYear, calMonth, 1);
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    let startDow = firstDay.getDay() - 1;
    if (startDow < 0) startDow = 6;

    const today = new Date().toISOString().split('T')[0];
    const container = document.getElementById('cal-days');
    container.innerHTML = '';

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
            renderCalendar();
            renderDayBookings(dateStr);
        });

        container.appendChild(cell);
    }

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

    dayBookings.sort((a, b) => a.datetime.localeCompare(b.datetime));

    dayBookings.forEach(b => {
        const time = b.datetime.split('T')[1].slice(0, 5);
        const item = document.createElement('div');
        item.className = 'booking-item';

        // Подсветка прошедших броней
        const bookingDateTime = new Date(b.datetime);
        if (bookingDateTime < new Date()) {
            item.classList.add('booking-item--past');
        }

        // Безопасное создание элементов (защита от XSS)
        const timeSpan = document.createElement('span');
        timeSpan.className = 'booking-time';
        timeSpan.textContent = time;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'booking-name';
        nameSpan.textContent = b.name;

        const phoneSpan = document.createElement('span');
        phoneSpan.className = 'booking-phone';
        phoneSpan.textContent = b.phone;

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'booking-delete-btn';
        deleteBtn.textContent = 'Удалить';
        deleteBtn.addEventListener('click', () => deleteBooking(b.id, item, dateStr));

        item.append(timeSpan, nameSpan, phoneSpan, deleteBtn);
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
        allBookings = allBookings.filter(b => b.id !== id);
        row.remove();
        renderCalendar();
        if (dateStr && !allBookings.some(b => b.datetime.startsWith(dateStr))) {
            document.getElementById('bookings-container').innerHTML =
                '<p class="empty-state">В этот день броней нет</p>';
        }
        showToast('Бронь удалена', 'success');
    } catch (err) {
        showError('Ошибка при удалении: ' + err.message);
    }
}

// ================= РУЧНОЕ ДОБАВЛЕНИЕ БРОНИ =================
function initManualBooking() {
    const adminDate = document.getElementById('admin-date');
    const adminTime = document.getElementById('admin-time');
    const adminBookingForm = document.getElementById('admin-booking-form');

    if (!adminDate || !adminTime || !adminBookingForm) return;

    const today = new Date().toISOString().split('T')[0];
    adminDate.setAttribute('min', today);

    adminDate.addEventListener('change', async (e) => {
        const date = e.target.value;
        if (!date) return;
        try {
            const res = await fetch(`/api/available-slots?date=${date}`);
            const slots = await res.json();
            let availableSlots = slots.map(s => s.datetime);

            // Фильтруем прошедшие слоты для сегодняшней даты
            if (date === today) {
                const now = new Date();
                availableSlots = availableSlots.filter(slot => {
                    const slotDate = new Date(slot);
                    return slotDate > now;
                });
            }

            adminTime.innerHTML = '<option value="">Выберите время</option>';
            if (availableSlots.length === 0) {
                adminTime.innerHTML += '<option value="" disabled>Нет свободного времени</option>';
            } else {
                availableSlots.forEach(slot => {
                    const time = slot.split('T')[1].slice(0,5);
                    const opt = document.createElement('option');
                    opt.value = slot;
                    opt.textContent = time;
                    adminTime.appendChild(opt);
                });
            }
        } catch (err) {
            showError('Ошибка загрузки времени');
        }
    });

    adminBookingForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('admin-name').value.trim();
        const phone = document.getElementById('admin-phone').value.trim();
        const datetime = adminTime.value;

        if (!name || !phone || !datetime) {
            showToast('Заполните все поля', 'warning');
            return;
        }

        try {
            const res = await fetch('/api/book', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, phone, datetime })
            });
            const result = await res.json();
            if (result.success) {
                adminBookingForm.reset();
                adminTime.innerHTML = '<option value="">Сначала выберите дату</option>';
                await loadBookings();
                showToast('Бронь успешно добавлена', 'success');
            } else {
                showToast(result.message || 'Ошибка при добавлении', 'error');
            }
        } catch (err) {
            showError('Ошибка соединения');
        }
    });
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
            showToast('Дата заблокирована', 'success');
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
                showToast(result.message, 'error');
                return;
            }
            document.getElementById('block-range-form').reset();
            loadBlockedRanges();
            showToast('Диапазон заблокирован', 'success');
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
        const files = e.target.files;
        const label = document.getElementById('file-label-text');
        label.textContent = files.length > 0
            ? `✅ Выбрано файлов: ${files.length}`
            : '📎 Прикрепить изображения (можно несколько)';

        // Удаляем превью новых файлов (не трогаем существующие)
        document.querySelectorAll('#images-preview .img-preview-item--new').forEach(el => el.remove());

        for (const file of files) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const item = document.createElement('div');
                item.className = 'img-preview-item img-preview-item--new';
                item.innerHTML = `<img src="${ev.target.result}" alt=""><span class="img-preview-badge">Новое</span>`;
                document.getElementById('images-preview').appendChild(item);
            };
            reader.readAsDataURL(file);
        }
    });

    document.getElementById('news-form').addEventListener('submit', submitNews);

    // Инициализация ручного добавления брони
    initManualBooking();
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
                    showToast('Дата разблокирована', 'success');
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
                    showToast('Диапазон удалён', 'success');
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
            const images = item.images || (item.image ? [item.image] : []);
            const div = document.createElement('div');
            div.className = 'news-card';
            div.innerHTML = `
                ${images.length > 0 ? `
                    <div class="news-card-img-wrap">
                        <img src="${images[0]}" alt="${item.title}" class="news-card-img">
                        ${images.length > 1 ? `<span class="news-card-img-count">+${images.length - 1}</span>` : ''}
                    </div>` : ''}
                <div class="news-card-body">
                    <strong></strong>
                    <small>${item.date || ''}</small>
                </div>
                <div class="news-actions">
                    <button data-edit="${item.id}">Редактировать</button>
                    <button data-delete="${item.id}">Удалить</button>
                </div>
            `;
            div.querySelector('.news-card-body strong').textContent = item.title;

            div.querySelector('[data-edit]').addEventListener('click', () => {
                switchTab('news-add');
                document.getElementById('news-title').value = item.title;
                quill.root.innerHTML = item.content;
                const submitBtn = document.getElementById('news-submit');
                submitBtn.textContent = 'Сохранить';
                submitBtn.dataset.editId = item.id;
                delete submitBtn.dataset.existingImage;

                // Очищаем превью и показываем существующие изображения
                const preview = document.getElementById('images-preview');
                preview.innerHTML = '';
                images.forEach(path => addExistingImagePreview(path));

                // Сбрасываем файловый инпут
                const fileInput = document.getElementById('news-image');
                fileInput.value = '';
                document.getElementById('file-label-text').textContent = '📎 Прикрепить изображения (можно несколько)';

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
                    showToast('Новость удалена', 'success');
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

// Добавляет превью существующего (сохранённого) изображения с кнопкой удаления
function addExistingImagePreview(path) {
    const preview = document.getElementById('images-preview');
    const item = document.createElement('div');
    item.className = 'img-preview-item img-preview-item--existing';
    item.dataset.path = path;
    item.innerHTML = `
        <img src="${path}" alt="">
        <button type="button" class="img-preview-remove" title="Удалить">×</button>
    `;
    item.querySelector('.img-preview-remove').addEventListener('click', () => item.remove());
    preview.appendChild(item);
}

function showNewsPreview() {
    const title = document.getElementById('news-title').value || 'Заголовок новости';
    const content = quill.root.innerHTML;
    const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

    const modal = document.getElementById('news-preview-modal');
    const previewImg = document.getElementById('preview-img');

    // Берём первое доступное изображение: из новых файлов или из существующих
    const newFile = document.getElementById('news-image').files[0];
    const existingItem = document.querySelector('#images-preview .img-preview-item--existing');

    if (newFile) {
        const reader = new FileReader();
        reader.onload = (e) => {
            previewImg.src = e.target.result;
            previewImg.style.display = 'block';
        };
        reader.readAsDataURL(newFile);
    } else if (existingItem) {
        previewImg.src = existingItem.dataset.path;
        previewImg.style.display = 'block';
    } else {
        previewImg.style.display = 'none';
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

    const title = document.getElementById('news-title').value.trim();
    if (!title) {
        showToast('Введите заголовок новости', 'warning');
        return;
    }

    const formData = new FormData();
    formData.append('title', title);
    formData.append('content', quill.root.innerHTML);

    // Собираем пути существующих изображений, которые не были удалены
    if (isEdit) {
        const kept = [...document.querySelectorAll('#images-preview .img-preview-item--existing')]
            .map(el => el.dataset.path)
            .filter(Boolean);
        formData.append('keepImages', JSON.stringify(kept));
    }

    // Добавляем новые файлы
    const files = document.getElementById('news-image').files;
    for (const file of files) {
        formData.append('images', file);
    }

    try {
        const url = isEdit ? `/api/news/${editId}` : '/api/news';
        const method = isEdit ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method,
            headers: authHeaders(),
            body: formData
        });

        if (!res.ok) throw new Error(`Ошибка: ${res.status}`);

        showToast(isEdit ? 'Новость обновлена' : 'Новость опубликована', 'success');

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
    delete submitBtn.dataset.existingImage;
    document.getElementById('news-form').reset();
    document.getElementById('images-preview').innerHTML = '';
    document.getElementById('file-label-text').textContent = '📎 Прикрепить изображения (можно несколько)';
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

        // Шаблон с безопасными полями (звёзды — только ★/☆, id — число)
        card.innerHTML = `
            <div class="admin-review-header">
                <span class="admin-review-name"></span>
                <span class="admin-review-stars">${stars}</span>
                <span class="admin-review-date"></span>
            </div>
            <p class="admin-review-text"></p>
            <div class="admin-review-actions">
                ${!isApproved ? `<button class="btn-approve" data-id="${r.id}">✓ Опубликовать</button>` : ''}
                <button class="btn-reject" data-id="${r.id}">Удалить</button>
            </div>
        `;

        // Безопасно вставляем пользовательские данные через textContent
        card.querySelector('.admin-review-name').textContent = r.name;
        card.querySelector('.admin-review-date').textContent = r.date;
        card.querySelector('.admin-review-text').textContent = r.text;

        if (!isApproved) {
            card.querySelector('.btn-approve').addEventListener('click', async () => {
                await fetch(`/api/admin/reviews/${r.id}/approve`, {
                    method: 'PUT', headers: authHeaders()
                });
                loadAdminReviews();
                showToast('Отзыв опубликован', 'success');
            });
        }

        card.querySelector('.btn-reject').addEventListener('click', async () => {
            if (!confirm('Удалить отзыв?')) return;
            await fetch(`/api/admin/reviews/${r.id}`, {
                method: 'DELETE', headers: authHeaders()
            });
            loadAdminReviews();
            showToast('Отзыв удалён', 'success');
        });

        container.appendChild(card);
    });
}
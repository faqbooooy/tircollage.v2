// ================= ИНИЦИАЛИЗАЦИЯ =================

let quill;

document.addEventListener('DOMContentLoaded', async () => {
    const ok = await checkAuth();
    if (!ok) return;

    initTabs();
    initQuill();
    initForms();

    loadBookings();
    loadAdminReviews(); // сразу чтобы бейдж и title обновились при открытии
    startPolling();

    // Устанавливаем высоту левой колонки после загрузки
    setTimeout(setAddBookingHeight, 100);
    window.addEventListener('resize', setAddBookingHeight);
});

// [!] Функция синхронизации высоты левой колонки с календарём
function setAddBookingHeight() {
    const calendarCol = document.querySelector('.bookings-calendar-col');
    const addCol = document.querySelector('.bookings-add-col');
    if (!calendarCol || !addCol) return;

    // На мобильных (ширина < 768px) сбрасываем принудительную высоту
    if (window.innerWidth < 768) {
        addCol.style.height = '';
        addCol.style.overflowY = '';
        return;
    }

    const calHeight = calendarCol.offsetHeight;
    addCol.style.height = calHeight + 'px';
    addCol.style.overflowY = 'auto'; // если контент не поместится
}

// ================= АВТОРИЗАЦИЯ =================

function authHeaders(extra = {}) {
    return {
        'X-Admin-Token': localStorage.getItem('adminToken'),
        ...extra
    };
}

async function tryRefreshToken() {
    try {
        const res = await fetch('/api/refresh-token', { method: 'POST' });
        if (!res.ok) return false;
        const data = await res.json();
        if (data.success && data.token) {
            localStorage.setItem('adminToken', data.token);
            return true;
        }
    } catch {}
    return false;
}

async function checkAuth() {
    const token = localStorage.getItem('adminToken');

    // Нет токена — пробуем обновить по cookie
    if (!token) {
        const refreshed = await tryRefreshToken();
        if (!refreshed) { window.location.href = '/login?tab=admin'; return false; }
    }

    try {
        const res = await fetch('/api/check-auth', { headers: authHeaders() });

        if (!res.ok) {
            // Токен истёк — пробуем обновить по cookie
            const refreshed = await tryRefreshToken();
            if (!refreshed) {
                localStorage.removeItem('adminToken');
                window.location.href = '/login?tab=admin';
                return false;
            }
            // Проверяем снова с новым токеном
            const res2 = await fetch('/api/check-auth', { headers: authHeaders() });
            if (!res2.ok) {
                localStorage.removeItem('adminToken');
                window.location.href = '/login?tab=admin';
                return false;
            }
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
        // Всегда обновляем бейдж отзывов независимо от активной вкладки
        loadAdminReviews();
    }, 30000);
}

// ================= ВКЛАДКИ =================

function initTabs() {
    const loaders = {
        bookings: loadBookings,
        blocked: () => { loadBlocked(); loadBlockedRanges(); },
        'news-add': () => {},
        'news-list-tab': loadNews,
        'reviews-tab': loadAdminReviews,
        'stats-tab': loadStats
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
    // Регистрируем модуль ресайза изображений если доступен
    if (window.ImageResize) {
        // suppress=true чтобы не было предупреждения "Overwriting modules/imageResize"
        Quill.register('modules/imageResize', window.ImageResize.default || window.ImageResize, true);
    }

    quill = new Quill('#editor', {
        theme: 'snow',
        placeholder: 'Текст новости...',
        modules: {
            toolbar: {
                container: [
                    [{ header: [2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ color: [] }],
                    [{ list: 'ordered' }, { list: 'bullet' }],
                    [{ align: [] }],
                    ['blockquote'],
                    ['link', 'image'],
                    ['clean']
                ],
                handlers: {
                    image: quillImageHandler
                }
            },
            ...(window.ImageResize ? {
                imageResize: { displaySize: true }
            } : {})
        }
    });

    // ===== Счётчик символов =====
    const counter = document.getElementById('editor-char-counter');
    function updateCounter() {
        const len = quill.getText().trim().length;
        if (counter) {
            counter.textContent = len.toLocaleString('ru') + ' символов';
            counter.classList.toggle('editor-char-counter--warn', len > 4000);
        }
    }
    quill.on('text-change', () => {
        updateCounter();
        scheduleAutosave();
    });
    updateCounter();

    // ===== Автосохранение черновика =====
    const DRAFT_KEY = 'news_draft';
    let autosaveTimer = null;

    function scheduleAutosave() {
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(saveDraft, 1500);
    }

    function saveDraft() {
        const title = document.getElementById('news-title')?.value || '';
        const content = quill.root.innerHTML;
        const text = quill.getText().trim();
        if (!title && !text) return; // не сохраняем пустое
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
            title,
            content,
            savedAt: new Date().toISOString()
        }));
        showAutosaveIndicator('Черновик сохранён');
    }

    function showAutosaveIndicator(msg) {
        const el = document.getElementById('autosave-indicator');
        if (!el) return;
        el.textContent = '✓ ' + msg;
        el.classList.add('autosave-indicator--visible');
        clearTimeout(el._hideTimer);
        el._hideTimer = setTimeout(() => el.classList.remove('autosave-indicator--visible'), 2500);
    }

    // Автосохранение при вводе в поле заголовка
    document.getElementById('news-title')?.addEventListener('input', scheduleAutosave);

    // Проверяем наличие черновика при загрузке
    const draft = (() => {
        try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; }
    })();

    if (draft && (draft.title || draft.content)) {
        const savedAt = new Date(draft.savedAt).toLocaleString('ru-RU', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
        });
        const restore = confirm(`Найден черновик от ${savedAt}.\nВосстановить?`);
        if (restore) {
            if (draft.title) document.getElementById('news-title').value = draft.title;
            if (draft.content) quill.root.innerHTML = draft.content;
            updateCounter();
            showAutosaveIndicator('Черновик восстановлен');
        } else {
            localStorage.removeItem(DRAFT_KEY);
        }
    }

    // Очищаем черновик после успешной публикации
    quill._clearDraft = () => localStorage.removeItem(DRAFT_KEY);
}

// ===== Обработчик вставки inline-изображения через тулбар =====
function quillImageHandler() {
    const input = document.createElement('input');
    input.setAttribute('type', 'file');
    input.setAttribute('accept', 'image/jpeg,image/png,image/webp');
    input.click();

    input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) {
            showToast('Файл слишком большой (максимум 5 МБ)', 'warning');
            return;
        }

        // Запоминаем позицию курсора до загрузки
        const range = quill.getSelection(true);

        // Вставляем временный placeholder пока грузится
        quill.insertText(range.index, '⏳ Загрузка...', { color: '#666' });
        quill.setSelection(range.index + 14);

        try {
            const formData = new FormData();
            formData.append('image', file);

            const res = await fetch('/api/upload-inline', {
                method: 'POST',
                headers: authHeaders(), // Content-Type не нужен — браузер сам ставит boundary для FormData
                body: formData
            });
            const data = await res.json();

            // Удаляем placeholder
            quill.deleteText(range.index, 14);

            if (data.success) {
                quill.insertEmbed(range.index, 'image', data.url);
                quill.setSelection(range.index + 1);
            } else {
                showToast('Не удалось загрузить изображение: ' + (data.message || ''), 'error');
            }
        } catch (err) {
            quill.deleteText(range.index, 14);
            showToast('Ошибка загрузки изображения', 'error');
        }
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
        setAddBookingHeight(); // синхронизация после переключения месяца
    };
    document.getElementById('cal-next').onclick = () => {
        calMonth++;
        if (calMonth > 11) { calMonth = 0; calYear++; }
        renderCalendar();
        setAddBookingHeight(); // синхронизация после переключения месяца
    };

    // Синхронизация после полной отрисовки
    setTimeout(setAddBookingHeight, 0);
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

        const bookingDateTime = new Date(b.datetime);
        if (bookingDateTime < new Date()) {
            item.classList.add('booking-item--past');
        }

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

    // ===== Маска телефона =====
    const phoneInput = document.getElementById('admin-phone');
    phoneInput.setAttribute('placeholder', '+7 (___) ___-__-__');
    phoneInput.setAttribute('maxlength', '18');
    phoneInput.addEventListener('input', () => {
        const digits = phoneInput.value.replace(/\D/g, '').slice(0, 11);
        if (!digits) { phoneInput.value = ''; return; }
        let result = '+7';
        if (digits.length > 1) result += ' (' + digits.slice(1, 4);
        if (digits.length > 4) result += ') ' + digits.slice(4, 7);
        if (digits.length > 7) result += '-' + digits.slice(7, 9);
        if (digits.length > 9) result += '-' + digits.slice(9, 11);
        phoneInput.value = result;
    });

    adminDate.addEventListener('change', async (e) => {
        const date = e.target.value;
        if (!date) return;
        try {
            const res = await fetch(`/api/available-slots?date=${date}`);
            const slots = await res.json();
            let availableSlots = slots.map(s => s.datetime);

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
        const phone = phoneInput.value.trim();
        const datetime = adminTime.value;

        if (!name || !phone || !datetime) {
            showToast('Заполните все поля', 'warning');
            return;
        }

        // Имя: минимум 2 символа
        if (name.length < 2) {
            showToast('Введите корректное имя (минимум 2 символа)', 'warning');
            return;
        }

        // Телефон: 11 цифр, начало 7 или 8
        const phoneDigits = phone.replace(/\D/g, '');
        if (phoneDigits.length !== 11 || (phoneDigits[0] !== '7' && phoneDigits[0] !== '8')) {
            showToast('Введите корректный российский номер телефона', 'warning');
            phoneInput.focus();
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
        const files = Array.from(e.target.files);
        const label = document.getElementById('file-label-text');
        label.textContent = files.length > 0
            ? `✅ Выбрано файлов: ${files.length}`
            : '📎 Прикрепить изображения (можно несколько)';

        // Удаляем старые новые превью
        document.querySelectorAll('#images-preview .img-preview-item--new').forEach(el => el.remove());

        for (const file of files) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const item = createPreviewItem(ev.target.result, 'new', null, file);
                document.getElementById('images-preview').appendChild(item);
                initDragAndDrop();
            };
            reader.readAsDataURL(file);
        }
    });

    document.getElementById('news-form').addEventListener('submit', submitNews);

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

                const preview = document.getElementById('images-preview');
                preview.innerHTML = '';
                images.forEach(path => addExistingImagePreview(path));

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

// ===== СОЗДАНИЕ ПРЕВЬЮ-ЭЛЕМЕНТА =====
// type: 'new' | 'existing'
// file: File object (для новых) | null (для существующих)
function createPreviewItem(src, type, path, file) {
    const item = document.createElement('div');
    item.className = `img-preview-item img-preview-item--${type}`;
    item.draggable = true;
    if (path) item.dataset.path = path;
    if (file) item._file = file; // храним File прямо на DOM-элементе

    const badge = type === 'new' ? '<span class="img-preview-badge">Новое</span>' : '';
    item.innerHTML = `
        <img src="${src}" alt="">
        <button type="button" class="img-preview-remove" title="Удалить">×</button>
        <div class="img-preview-drag-handle" title="Перетащить">⠿</div>
        ${badge}
    `;
    item.querySelector('.img-preview-remove').addEventListener('click', () => item.remove());
    return item;
}

function addExistingImagePreview(path) {
    const item = createPreviewItem(path, 'existing', path, null);
    document.getElementById('images-preview').appendChild(item);
    initDragAndDrop();
}

// ===== DRAG-AND-DROP СОРТИРОВКА =====
let dragSrc = null;

function initDragAndDrop() {
    const grid = document.getElementById('images-preview');
    const items = grid.querySelectorAll('.img-preview-item');

    items.forEach(item => {
        item.removeEventListener('dragstart', onDragStart);
        item.removeEventListener('dragover', onDragOver);
        item.removeEventListener('drop', onDrop);
        item.removeEventListener('dragend', onDragEnd);
        item.removeEventListener('dragleave', onDragLeave);

        item.addEventListener('dragstart', onDragStart);
        item.addEventListener('dragover', onDragOver);
        item.addEventListener('drop', onDrop);
        item.addEventListener('dragend', onDragEnd);
        item.addEventListener('dragleave', onDragLeave);
    });
}

function onDragStart(e) {
    dragSrc = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // required for Firefox
    setTimeout(() => this.classList.add('img-preview-dragging'), 0);
}

function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (this !== dragSrc) this.classList.add('img-preview-drag-over');
}

function onDragLeave() {
    this.classList.remove('img-preview-drag-over');
}

function onDrop(e) {
    e.preventDefault();
    this.classList.remove('img-preview-drag-over');
    if (dragSrc === this) return;

    const grid = document.getElementById('images-preview');
    const items = Array.from(grid.querySelectorAll('.img-preview-item'));
    const srcIdx = items.indexOf(dragSrc);
    const tgtIdx = items.indexOf(this);

    if (srcIdx < tgtIdx) {
        grid.insertBefore(dragSrc, this.nextSibling);
    } else {
        grid.insertBefore(dragSrc, this);
    }
}

function onDragEnd() {
    this.classList.remove('img-preview-dragging');
    document.querySelectorAll('.img-preview-drag-over').forEach(el => el.classList.remove('img-preview-drag-over'));
    dragSrc = null;
}

function showNewsPreview() {
    const title = document.getElementById('news-title').value || 'Заголовок новости';
    const content = quill.root.innerHTML;
    const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

    const modal = document.getElementById('news-preview-modal');
    const previewImg = document.getElementById('preview-img');

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
        document.getElementById('news-title').focus();
        return;
    }
    if (title.length < 3) {
        showToast('Заголовок слишком короткий (минимум 3 символа)', 'warning');
        document.getElementById('news-title').focus();
        return;
    }
    if (title.length > 200) {
        showToast('Заголовок слишком длинный (максимум 200 символов)', 'warning');
        return;
    }

    const contentText = quill.getText().trim();
    if (!contentText || contentText.length < 10) {
        showToast('Добавьте текст новости (минимум 10 символов)', 'warning');
        quill.focus();
        return;
    }

    const formData = new FormData();
    formData.append('title', title);
    formData.append('content', quill.root.innerHTML);

    // Собираем все элементы превью в текущем порядке (после drag-and-drop)
    const allItems = [...document.querySelectorAll('#images-preview .img-preview-item')];
    const keptPaths = [];
    const newFiles = [];

    allItems.forEach(item => {
        if (item.classList.contains('img-preview-item--existing') && item.dataset.path) {
            keptPaths.push(item.dataset.path);
        } else if (item._file) {
            newFiles.push(item._file);
        }
    });

    if (isEdit) {
        formData.append('keepImages', JSON.stringify(keptPaths));
    }

    // Порядок файлов в FormData = желаемый sort_order
    for (const file of newFiles) {
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
    document.querySelector('#news-add .tab-title').textContent = 'Добавить новость ';
    quill.root.innerHTML = '';
    if (quill._clearDraft) quill._clearDraft();
    const counter = document.getElementById('editor-char-counter');
    if (counter) counter.textContent = '0 символов';
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

        // Бейдж на кнопке вкладки
        const badge = document.getElementById('reviews-badge');
        if (badge) {
            if (pending.length > 0) {
                badge.textContent = pending.length;
                badge.style.display = 'inline-flex';
            } else {
                badge.style.display = 'none';
            }
        }

        // Счётчик в заголовке вкладки браузера
        const baseTitle = 'Панель управления';
        document.title = pending.length > 0 ? `(${pending.length}) ${baseTitle}` : baseTitle;

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
        card.dataset.id = r.id;

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

        card.querySelector('.admin-review-name').textContent = r.name;
        card.querySelector('.admin-review-date').textContent = r.date;
        card.querySelector('.admin-review-text').textContent = r.text;

        if (!isApproved) {
            card.querySelector('.btn-approve').addEventListener('click', async () => {
                const approvedId = r.id;
                await fetch(`/api/admin/reviews/${approvedId}/approve`, {
                    method: 'PUT', headers: authHeaders()
                });
                await loadAdminReviews();
                showToast('Отзыв опубликован', 'success');
                // Подсвечиваем только что одобренный отзыв в колонке "Опубликованные"
                const approvedCard = document.querySelector(`#reviews-approved [data-id="${approvedId}"]`);
                if (approvedCard) {
                    approvedCard.classList.add('admin-review-card--new');
                    setTimeout(() => approvedCard.classList.remove('admin-review-card--new'), 3000);
                    approvedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
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
// ==================== СТАТИСТИКА ====================
async function loadStats() {
    try {
        const res = await fetch('/api/stats', { headers: authHeaders() });
        if (!res.ok) throw new Error('Ошибка загрузки');
        const s = await res.json();

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

        set('stat-week', s.week ?? '—');
        set('stat-month', s.month ?? '—');
        set('stat-total', s.total ?? '—');
        set('stat-rating', s.rating ? s.rating + ' ★' : '—');
        set('stat-reviews', s.reviews ?? '—');
        set('stat-pending', s.pending ?? '—');

        // Популярные часы — горизонтальные бары
        const hoursEl = document.getElementById('stats-hours');
        if (hoursEl && s.popularHours) {
            const max = Math.max(...s.popularHours.map(h => h.cnt), 1);
            hoursEl.innerHTML = s.popularHours.map(h => `
                <div class="stats-bar-row">
                    <span class="stats-bar-label">${h.hour}:00</span>
                    <div class="stats-bar-track">
                        <div class="stats-bar-fill" style="width:${Math.round(h.cnt/max*100)}%"></div>
                    </div>
                    <span class="stats-bar-value">${h.cnt}</span>
                </div>
            `).join('') || '<p class="empty-state">Нет данных</p>';
        }

        // Дни недели
        const wdEl = document.getElementById('stats-weekdays');
        if (wdEl && s.weekdays) {
            const max = Math.max(...s.weekdays.map(d => d.cnt), 1);
            wdEl.innerHTML = s.weekdays.map(d => `
                <div class="stats-bar-row">
                    <span class="stats-bar-label">${d.name}</span>
                    <div class="stats-bar-track">
                        <div class="stats-bar-fill" style="width:${Math.round(d.cnt/max*100)}%"></div>
                    </div>
                    <span class="stats-bar-value">${d.cnt}</span>
                </div>
            `).join('');
        }

    } catch (err) {
        showError('Не удалось загрузить статистику: ' + err.message);
    }
}
// ==================== ВЫХОД ====================
async function logout() {
    try {
        await fetch('/api/admin-logout', { method: 'POST' });
    } catch {}
    localStorage.removeItem('adminToken');
    window.location.href = '/login?tab=admin';
}
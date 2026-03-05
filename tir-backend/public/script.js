// ==================== script.js ====================

const scrollTopBtn = document.getElementById('scroll-top');
const navToggle = document.querySelector('.nav-toggle');
const navMenu = document.querySelector('.nav-menu');
const bookingForm = document.getElementById('booking-form');
const bookingSuccess = document.getElementById('booking-success');
const dateInput = document.getElementById('date');
const datetimeSelect = document.getElementById('datetime');

let blockedDates = [];
let selectedRating = 0;

// ====================== ЗАПРЕТ ПРОШЕДШИХ ДАТ (ЛОКАЛЬНО) ======================
const nowLocal = new Date();
const today = nowLocal.getFullYear() + '-' + 
              String(nowLocal.getMonth() + 1).padStart(2, '0') + '-' + 
              String(nowLocal.getDate()).padStart(2, '0');
dateInput.setAttribute('min', today);

function filterPastSlots(slots) {
    const now = new Date();
    return slots.filter(slot => {
        const slotDate = new Date(slot.datetime);
        // Если дата слота сегодня — проверяем время
        if (slot.datetime.split('T')[0] === today) {
            return slotDate.getHours() > now.getHours() ||
                   (slotDate.getHours() === now.getHours() && slotDate.getMinutes() > now.getMinutes());
        }
        return true;
    });
}

function loadAvailableSlots(selectedDate) {
    fetch(`/api/available-slots?date=${selectedDate}&_=${Date.now()}`)
        .then(r => r.json())
        .then(slots => {
            let available = selectedDate === today ? filterPastSlots(slots) : slots;
            datetimeSelect.innerHTML = '<option value="">Выберите время</option>';
            
            if (available.length === 0 || blockedDates.includes(selectedDate)) {
                datetimeSelect.innerHTML += '<option value="" disabled>Нет свободного времени</option>';
                datetimeSelect.disabled = true;
            } else {
                datetimeSelect.disabled = false;
                available.forEach(slot => {
                    const option = document.createElement('option');
                    option.value = slot.datetime;
                    option.textContent = slot.datetime.split('T')[1].slice(0, 5);
                    datetimeSelect.appendChild(option);
                });
            }
        })
        .catch(() => {
            datetimeSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        });
}

// ====================== ВЫБОР ДАТЫ ======================
dateInput.addEventListener('change', (e) => {
    const date = e.target.value;
    if (blockedDates.includes(date)) {
        alert('В этот день запись недоступна!');
        dateInput.value = '';
        datetimeSelect.innerHTML = '<option value="">Выберите время</option>';
        return;
    }
    loadAvailableSlots(date);
});

// ====================== ФОРМА ЗАПИСИ ======================
bookingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const selectedDate = dateInput.value;
    const selectedTime = datetimeSelect.value;
    if (!selectedTime) { alert('Выберите время!'); return; }
    
    // Проверка на прошлое время
    if (new Date(selectedTime) < new Date()) { 
        alert('К сожалению, это время уже ушло. Выберите другое.'); 
        loadAvailableSlots(selectedDate);
        return; 
    }

    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;

    try {
        const res = await fetch('/api/book', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, phone, datetime: selectedTime })
        });
        const result = await res.json();
        if (result.success) {
            const timeStr = selectedTime.split('T')[1].slice(0, 5);
            const dateStr = new Date(selectedDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
            document.getElementById('booking-success-text').textContent = `${name}, ждём вас ${dateStr} в ${timeStr}`;
            bookingForm.style.display = 'none';
            bookingSuccess.style.display = 'block';
        } else {
            alert('Ошибка: ' + result.message);
        }
    } catch {
        alert('Ошибка соединения с сервером');
    }
});

document.getElementById('booking-success-btn').addEventListener('click', () => {
    bookingSuccess.style.display = 'none';
    bookingForm.style.display = 'flex';
    bookingForm.reset();
    datetimeSelect.innerHTML = '<option value="">Выберите время</option>';
});

// ====================== ТЕЛЕФОН (ИСПРАВЛЕННАЯ МАСКА) ======================
const phoneInput = document.getElementById('phone');
phoneInput.addEventListener('input', (e) => {
    let input = e.target.value.replace(/\D/g, ''); // Оставляем только цифры
    if (!input) { e.target.value = ''; return; }

    let formatted = '';
    // Обработка 8, 7 и 9 в начале
    if (['7', '8', '9'].includes(input[0])) {
        if (input[0] === '8') input = '7' + input.substring(1);
        if (input[0] === '9') input = '7' + input;
        
        formatted = '+7';
        if (input.length > 1) formatted += ' (' + input.substring(1, 4);
        if (input.length >= 5) formatted += ') ' + input.substring(4, 7);
        if (input.length >= 8) formatted += '-' + input.substring(7, 9);
        if (input.length >= 10) formatted += '-' + input.substring(9, 11);
    } else {
        formatted = '+' + input.substring(0, 15);
    }
    e.target.value = formatted;
});

// Разрешаем удалять префикс +7 ( через Backspace
phoneInput.addEventListener('keydown', (e) => {
    if (e.keyCode === 8 && phoneInput.value.length <= 4) {
        // Если пользователь хочет стереть начало, даем ему это сделать
    }
});

// ====================== НОВОСТИ И ОТЗЫВЫ ======================
async function loadNews() {
    try {
        const res = await fetch('/api/news');
        if (!res.ok) return;
        const news = await res.json();
        const list = document.getElementById('news-list');
        if (!list) return;
        list.innerHTML = '';
        news.forEach(item => {
            const div = document.createElement('div');
            div.className = 'news-item';
            div.innerHTML = `
                ${item.image ? `<img src="${item.image}" alt="${item.title}">` : ''}
                <div class="news-text">
                    <h3>${item.title}</h3>
                    <div class="news-preview">${item.content}</div>
                    <small>${item.date}</small>
                    <button class="news-read-more">Читать далее →</button>
                </div>
            `;
            div.querySelector('.news-read-more').addEventListener('click', () => openNewsModal(item));
            list.appendChild(div);
        });
    } catch (err) { console.error('Новости не загружены:', err); }
}

function openNewsModal(item) {
    const modal = document.getElementById('news-modal');
    const img = document.getElementById('news-modal-img');
    img.src = item.image || '';
    img.style.display = item.image ? 'block' : 'none';
    document.getElementById('news-modal-title').textContent = item.title;
    document.getElementById('news-modal-date').textContent = item.date;
    document.getElementById('news-modal-body').innerHTML = item.content;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeNewsModal() {
    document.getElementById('news-modal').style.display = 'none';
    document.body.style.overflow = '';
}

document.getElementById('news-modal-close')?.addEventListener('click', closeNewsModal);

async function loadReviews() {
    try {
        const res = await fetch('/api/reviews');
        const reviews = await res.json();
        const container = document.getElementById('reviews-list');
        if (!container) return;
        container.innerHTML = reviews.length ? '' : '<p style="text-align:center;color:#666;">Отзывов пока нет</p>';
        reviews.forEach(r => {
            const div = document.createElement('div');
            div.className = 'review-card';
            div.innerHTML = `
                <div class="review-header">
                    <span class="review-name">${r.name}</span>
                    <span class="review-stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
                </div>
                <p class="review-text">${r.text}</p>
                <small class="review-date">${r.date}</small>
            `;
            container.appendChild(div);
        });
    } catch (err) { console.error('Отзывы не загружены:', err); }
}

// ====================== ИНИЦИАЛИЗАЦИЯ ======================
document.addEventListener('DOMContentLoaded', () => {
    loadNews();
    loadReviews();

    // Звезды в отзывах
    document.querySelectorAll('.star').forEach(star => {
        star.addEventListener('click', () => {
            selectedRating = +star.dataset.value;
            document.getElementById('review-rating').value = selectedRating;
            document.querySelectorAll('.star').forEach(s => {
                s.classList.toggle('active', +s.dataset.value <= selectedRating);
            });
        });
    });

    // Форма отзыва
    const reviewForm = document.getElementById('review-form');
    if (reviewForm) {
        reviewForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!selectedRating) { alert('Выберите оценку'); return; }
            const res = await fetch('/api/reviews', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: document.getElementById('review-name').value,
                    rating: selectedRating,
                    text: document.getElementById('review-text').value
                })
            });
            const result = await res.json();
            if (result.success) {
                reviewForm.style.display = 'none';
                document.getElementById('review-success').style.display = 'block';
            }
        });
    }

    // Загрузка заблокированных дат и слотов
    fetch('/api/blocked-dates')
        .then(r => r.json())
        .then(dates => {
            blockedDates = dates;
            loadAvailableSlots(today);
        })
        .catch(() => loadAvailableSlots(today));
});

// Прокрутка и Гамбургер (остальное без изменений)
if (scrollTopBtn) {
    window.addEventListener('scroll', () => scrollTopBtn.classList.toggle('visible', window.scrollY > 300));
    scrollTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}
if (navToggle) {
    navToggle.addEventListener('click', () => {
        navToggle.classList.toggle('active');
        navMenu.classList.toggle('active');
    });
}
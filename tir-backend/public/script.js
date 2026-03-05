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

// ====================== ЗАПРЕТ ПРОШЕДШИХ ДАТ ======================
const today = new Date().toISOString().split('T')[0];
dateInput.setAttribute('min', today);

function filterPastSlots(slots) {
    const now = new Date();
    return slots.filter(slot => {
        const slotDate = new Date(slot.datetime);
        if (slotDate.toISOString().split('T')[0] !== today) return true;
        return slotDate.getHours() > now.getHours() ||
               (slotDate.getHours() === now.getHours() && slotDate.getMinutes() >= now.getMinutes());
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
    if (new Date(selectedTime) < new Date()) { alert('Нельзя забронировать время в прошлом!'); return; }

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
            const dateStr = new Date(selectedDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
            document.getElementById('booking-success-text').textContent = `${name}, ждём вас ${dateStr} в ${timeStr}`;
            bookingForm.style.display = 'none';
            bookingSuccess.style.display = 'block';
            loadAvailableSlots(selectedDate);
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

// ====================== НОВОСТИ С МОДАЛКОЙ ======================
async function loadNews() {
    try {
        const res = await fetch('/api/news');
        if (!res.ok) return;
        const news = await res.json();
        const list = document.getElementById('news-list');
        list.innerHTML = '';
        news.forEach(item => {
            const div = document.createElement('div');
            div.className = 'news-item';
            div.innerHTML = `
                ${item.image ? `<img src="${item.image}" alt="${item.title}">` : ''}
                <div class="news-text">
                    <h3>${item.title}</h3>
                    <p class="news-preview">${item.content}</p>
                    <small>${item.date}</small>
                    <button class="news-read-more">Читать далее →</button>
                </div>
            `;
            div.querySelector('.news-read-more').addEventListener('click', () => openNewsModal(item));
            list.appendChild(div);
        });
    } catch (err) {
        console.error('Ошибка загрузки новостей:', err);
    }
}

function openNewsModal(item) {
    const img = document.getElementById('news-modal-img');
    img.src = item.image || '';
    img.style.display = item.image ? 'block' : 'none';
    document.getElementById('news-modal-title').textContent = item.title;
    document.getElementById('news-modal-date').textContent = item.date;
    document.getElementById('news-modal-body').innerHTML = item.content;
    document.getElementById('news-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeNewsModal() {
    document.getElementById('news-modal').style.display = 'none';
    document.body.style.overflow = '';
}

document.getElementById('news-modal-close').addEventListener('click', closeNewsModal);
document.getElementById('news-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('news-modal')) closeNewsModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNewsModal(); });

// ====================== ТЕЛЕФОН ======================
const phoneInput = document.getElementById('phone');
phoneInput.addEventListener('input', (e) => {
    let input = e.target.value.replace(/\D/g, '');
    if (!input) return e.target.value = '';
    let formatted = '';
    if (['7', '8', '9'].includes(input[0])) {
        if (input[0] === '8') input = '7' + input.substring(1);
        if (input[0] === '9') input = '7' + input;
        formatted = '+7';
        if (input.length > 1) formatted += ' (' + input.substring(1, 4);
        if (input.length >= 5) formatted += ') ' + input.substring(4, 7);
        if (input.length >= 8) formatted += '-' + input.substring(7, 9);
        if (input.length >= 10) formatted += '-' + input.substring(9, 12);
    } else {
        formatted = '+' + input.substring(0, 16);
    }
    e.target.value = formatted;
});
phoneInput.addEventListener('keydown', (e) => {
    if (e.target.value.length <= 4 && e.keyCode === 8) e.preventDefault();
});

// ====================== ПРОКРУТКА ======================
window.addEventListener('scroll', () => {
    if (scrollTopBtn) scrollTopBtn.classList.toggle('visible', window.scrollY > 300);
});
if (scrollTopBtn) {
    scrollTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

// ====================== ГАМБУРГЕР ======================
if (navToggle) {
    navToggle.addEventListener('click', () => {
        navToggle.classList.toggle('active');
        navMenu.classList.toggle('active');
    });
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => {
            navToggle.classList.remove('active');
            navMenu.classList.remove('active');
        });
    });
}

// ====================== ОТЗЫВЫ ======================
async function loadReviews() {
    try {
        const res = await fetch('/api/reviews');
        const reviews = await res.json();
        const container = document.getElementById('reviews-list');
        container.innerHTML = '';
        if (reviews.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:#666;">Отзывов пока нет — будьте первым!</p>';
            return;
        }
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
    } catch (err) {
        console.error('Ошибка загрузки отзывов:', err);
    }
}

// ====================== ИНИЦИАЛИЗАЦИЯ ======================
document.addEventListener('DOMContentLoaded', () => {

    loadNews();
    loadReviews();

    // Звёзды
    document.querySelectorAll('.star').forEach(star => {
        star.addEventListener('mouseover', () => {
            const val = +star.dataset.value;
            document.querySelectorAll('.star').forEach(s => {
                s.classList.toggle('active', +s.dataset.value <= val);
            });
        });
        star.addEventListener('mouseleave', () => {
            document.querySelectorAll('.star').forEach(s => {
                s.classList.toggle('active', +s.dataset.value <= selectedRating);
            });
        });
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
            const rating = +document.getElementById('review-rating').value;
            if (!rating) { alert('Пожалуйста, выберите оценку'); return; }
            try {
                const res = await fetch('/api/reviews', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: document.getElementById('review-name').value,
                        rating,
                        text: document.getElementById('review-text').value
                    })
                });
                const result = await res.json();
                if (result.success) {
                    reviewForm.style.display = 'none';
                    document.getElementById('review-success').style.display = 'block';
                } else {
                    alert(result.message);
                }
            } catch {
                alert('Ошибка отправки');
            }
        });
    }

    // Заблокированные даты
    fetch('/api/blocked-dates')
        .then(r => r.json())
        .then(dates => {
            blockedDates = dates;
            loadAvailableSlots(today);
        })
        .catch(() => loadAvailableSlots(today));

    // Мобильная кнопка — скрываем при виде формы записи
    const mobileBtn = document.querySelector('.mobile-book-btn');
    const bookingSection = document.getElementById('booking');
    if (mobileBtn && bookingSection) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                mobileBtn.style.opacity = entry.isIntersecting ? '0' : '1';
                mobileBtn.style.pointerEvents = entry.isIntersecting ? 'none' : 'auto';
            });
        }, { threshold: 0.2 });
        observer.observe(bookingSection);
    }

});
// ==================== script.js ====================

const scrollTopBtn = document.getElementById('scroll-top');
const navToggle = document.querySelector('.nav-toggle');
const navMenu = document.querySelector('.nav-menu');
const bookingForm = document.getElementById('booking-form');
const bookingSuccess = document.getElementById('booking-success');
const dateInput = document.getElementById('date');
const datetimeSelect = document.getElementById('datetime');
const phoneInput = document.getElementById('phone');

let blockedDates = [];
let selectedRating = 0;

// ====================== ЗАПРЕТ ПРОШЕДШИХ ДАТ (ЛОКАЛЬНО) ======================
const nowLocal = new Date();
const today = nowLocal.getFullYear() + '-' + 
              String(nowLocal.getMonth() + 1).padStart(2, '0') + '-' + 
              String(nowLocal.getDate()).padStart(2, '0');

if (dateInput) {
    dateInput.setAttribute('min', today);
}

function filterPastSlots(slots) {
    const now = new Date();
    return slots.filter(slot => {
        const slotDate = new Date(slot.datetime);
        if (slot.datetime.split('T')[0] === today) {
            return slotDate.getHours() > now.getHours() ||
                   (slotDate.getHours() === now.getHours() && slotDate.getMinutes() > now.getMinutes());
        }
        return true;
    });
}

function loadAvailableSlots(selectedDate) {
    if (!datetimeSelect) return;
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
if (dateInput) {
    dateInput.addEventListener('change', (e) => {
        const date = e.target.value;
        if (blockedDates.includes(date)) {
            alert('В этот день запись недоступна!');
            dateInput.value = '';
            if (datetimeSelect) datetimeSelect.innerHTML = '<option value="">Выберите время</option>';
            return;
        }
        loadAvailableSlots(date);
    });
}

// ====================== ФОРМА ЗАПИСИ ======================
if (bookingForm) {
    bookingForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const selectedDate = dateInput ? dateInput.value : '';
        const selectedTime = datetimeSelect ? datetimeSelect.value : '';
        if (!selectedTime) { alert('Выберите время!'); return; }
        
        if (new Date(selectedTime) < new Date()) { 
            alert('К сожалению, это время уже ушло. Выберите другое.'); 
            loadAvailableSlots(selectedDate);
            return; 
        }

        const name = document.getElementById('name').value;
        const phone = document.getElementById('phone').value;
        const website = document.getElementById('website')?.value || '';

        // Проверка российского номера до отправки на сервер
        const phoneDigits = phone.replace(/\D/g, '');
        const isRussianPhone = phoneDigits.length === 11 && (phoneDigits[0] === '7' || phoneDigits[0] === '8');
        if (!isRussianPhone) {
            alert('Укажите российский номер телефона (+7 или 8)');
            return;
        }

        try {
            const res = await fetch('/api/book', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, phone, datetime: selectedTime, website })
            });
            const result = await res.json();
            if (result.success) {
                const timeStr = selectedTime.split('T')[1].slice(0, 5);
                const dateStr = new Date(selectedDate).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
                const successText = document.getElementById('booking-success-text');
                if (successText) successText.textContent = `${name}, ждём вас!`;
                // Заполняем детали брони
                const bsdName = document.getElementById('bsd-name');
                const bsdDate = document.getElementById('bsd-date');
                const bsdTime = document.getElementById('bsd-time');
                if (bsdName) bsdName.textContent = name;
                if (bsdDate) bsdDate.textContent = dateStr;
                if (bsdTime) bsdTime.textContent = timeStr;
                if (bookingForm) bookingForm.style.display = 'none';
                if (bookingSuccess) bookingSuccess.style.display = 'flex';
                // Скроллим к блоку подтверждения
                bookingSuccess.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                alert('Ошибка: ' + result.message);
            }
        } catch {
            alert('Ошибка соединения с сервером');
        }
    });
}

const successBtn = document.getElementById('booking-success-btn');
if (successBtn) {
    successBtn.addEventListener('click', () => {
        if (bookingSuccess) bookingSuccess.style.display = 'none';
        if (bookingForm) {
            bookingForm.style.display = 'flex';
            bookingForm.reset();
        }
        if (datetimeSelect) datetimeSelect.innerHTML = '<option value="">Выберите время</option>';
    });
}

// ====================== ТЕЛЕФОН (МАСКА) ======================
if (phoneInput) {
    phoneInput.addEventListener('input', (e) => {
        let input = e.target.value.replace(/\D/g, '');
        if (!input) { e.target.value = ''; return; }

        let formatted = '';
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

    phoneInput.addEventListener('keydown', (e) => {
        // разрешаем удалять префикс
    });
}

// ====================== НОВОСТИ И ОТЗЫВЫ ======================

// Карусель: запускает автосмену и возвращает функцию остановки
function attachCarousel(container, slides, dots) {
    let current = 0;
    let intervalId = null;

    function goTo(idx) {
        slides[current].classList.remove('active');
        if (dots[current]) dots[current].classList.remove('active');
        current = (idx + slides.length) % slides.length;
        slides[current].classList.add('active');
        if (dots[current]) dots[current].classList.add('active');
    }

    function start() {
        intervalId = setInterval(() => goTo(current + 1), 2500);
    }

    function stop() {
        clearInterval(intervalId);
    }

    container.addEventListener('mouseenter', stop);
    container.addEventListener('mouseleave', start);
    start();
    return stop;
}

async function loadNews() {
    try {
        const res = await fetch('/api/news');
        if (!res.ok) return;
        const news = await res.json();
        const list = document.getElementById('news-list');
        if (!list) return;
        list.innerHTML = '';

        news.forEach(item => {
            const images = item.images || (item.image ? [item.image] : []);
            const div = document.createElement('div');
            div.className = 'news-item';

            // Блок изображений — карусель если несколько, одиночное если одно
            let mediaHtml = '';
            if (images.length > 1) {
                mediaHtml = `<div class="news-carousel">
                    ${images.map((src, i) => `<img src="${src}" alt="${item.title}" class="carousel-slide${i === 0 ? ' active' : ''}">`).join('')}
                    <div class="carousel-dots">
                        ${images.map((_, i) => `<span class="carousel-dot${i === 0 ? ' active' : ''}"></span>`).join('')}
                    </div>
                </div>`;
            } else if (images.length === 1) {
                mediaHtml = `<img src="${images[0]}" alt="${item.title}" class="news-single-img">`;
            }

            div.innerHTML = `
                ${mediaHtml}
                <div class="news-text">
                    <h3></h3>
                    <div class="news-preview">${item.content}</div>
                    <small></small>
                    <button class="news-read-more">Читать далее →</button>
                </div>
            `;

            div.querySelector('.news-text h3').textContent = item.title;
            div.querySelector('.news-text small').textContent = item.date;

            // Запускаем карусель если несколько изображений
            if (images.length > 1) {
                const carousel = div.querySelector('.news-carousel');
                const slides = carousel.querySelectorAll('.carousel-slide');
                const dots = carousel.querySelectorAll('.carousel-dot');
                attachCarousel(carousel, slides, dots);
            }

            div.querySelector('.news-read-more').addEventListener('click', () => openNewsModal(item));
            list.appendChild(div);
        });
    } catch (err) { console.error('Новости не загружены:', err); }
}

// Текущий индекс галереи в модале
let galleryImages = [];
let galleryIndex = 0;

function openNewsModal(item) {
    const modal = document.getElementById('news-modal');
    const titleEl = document.getElementById('news-modal-title');
    const dateEl = document.getElementById('news-modal-date');
    const bodyEl = document.getElementById('news-modal-body');
    if (!modal || !titleEl || !dateEl || !bodyEl) return;

    titleEl.textContent = item.title;
    dateEl.textContent = item.date;
    bodyEl.innerHTML = item.content;

    const images = item.images || (item.image ? [item.image] : []);
    galleryImages = images;
    galleryIndex = 0;

    const singleImg = document.getElementById('news-modal-img');
    const gallery = document.getElementById('news-modal-gallery');

    if (images.length > 1) {
        // Режим галереи
        singleImg.style.display = 'none';
        gallery.style.display = 'block';
        renderGallery(0);
    } else if (images.length === 1) {
        // Одиночное изображение
        gallery.style.display = 'none';
        singleImg.src = images[0];
        singleImg.style.display = 'block';
        singleImg.onclick = () => openLightbox(images, 0);
    } else {
        // Без изображений
        gallery.style.display = 'none';
        singleImg.style.display = 'none';
    }

    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function renderGallery(idx) {
    galleryIndex = (idx + galleryImages.length) % galleryImages.length;
    const mainImg = document.getElementById('gallery-main-img');
    const thumbsContainer = document.getElementById('gallery-thumbs');

    mainImg.src = galleryImages[galleryIndex];

    // Клик на главное фото — открыть лайтбокс
    mainImg.onclick = () => openLightbox(galleryImages, galleryIndex);

    // Миниатюры
    thumbsContainer.innerHTML = '';
    galleryImages.forEach((src, i) => {
        const thumb = document.createElement('img');
        thumb.src = src;
        thumb.className = 'gallery-thumb' + (i === galleryIndex ? ' active' : '');
        thumb.addEventListener('click', () => renderGallery(i));
        thumbsContainer.appendChild(thumb);
    });
}

// Навигация галереи
const galleryPrev = document.getElementById('gallery-prev');
const galleryNext = document.getElementById('gallery-next');
if (galleryPrev) galleryPrev.addEventListener('click', () => renderGallery(galleryIndex - 1));
if (galleryNext) galleryNext.addEventListener('click', () => renderGallery(galleryIndex + 1));

// ====================== ЛАЙТБОКС ======================
let lightboxImages = [];
let lightboxIndex = 0;

function openLightbox(images, startIndex) {
    lightboxImages = images;
    lightboxIndex = startIndex;
    renderLightbox();
    document.getElementById('lightbox').classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    document.getElementById('lightbox').classList.remove('open');
    // Если модал новости был открыт — возвращаем его скролл
    if (document.getElementById('news-modal').style.display === 'flex') {
        document.body.style.overflow = 'hidden';
    } else {
        document.body.style.overflow = '';
    }
}

function renderLightbox() {
    document.getElementById('lightbox-img').src = lightboxImages[lightboxIndex];
    const counter = document.getElementById('lightbox-counter');
    counter.textContent = lightboxImages.length > 1
        ? `${lightboxIndex + 1} / ${lightboxImages.length}`
        : '';

    // Стрелки видны только если несколько фото
    const prevBtn = document.getElementById('lightbox-prev');
    const nextBtn = document.getElementById('lightbox-next');
    const show = lightboxImages.length > 1 ? 'flex' : 'none';
    prevBtn.style.display = show;
    nextBtn.style.display = show;
}

const lightboxEl = document.getElementById('lightbox');
if (lightboxEl) {
    document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
    document.getElementById('lightbox-prev').addEventListener('click', () => {
        lightboxIndex = (lightboxIndex - 1 + lightboxImages.length) % lightboxImages.length;
        renderLightbox();
    });
    document.getElementById('lightbox-next').addEventListener('click', () => {
        lightboxIndex = (lightboxIndex + 1) % lightboxImages.length;
        renderLightbox();
    });

    // Клик на фон закрывает лайтбокс
    lightboxEl.addEventListener('click', (e) => {
        if (e.target === lightboxEl || e.target.id === 'lightbox-img') closeLightbox();
    });
}

// Клавиатура: стрелки и Escape
document.addEventListener('keydown', (e) => {
    const lb = document.getElementById('lightbox');
    if (lb && lb.classList.contains('open')) {
        if (e.key === 'ArrowLeft') { lightboxIndex = (lightboxIndex - 1 + lightboxImages.length) % lightboxImages.length; renderLightbox(); }
        if (e.key === 'ArrowRight') { lightboxIndex = (lightboxIndex + 1) % lightboxImages.length; renderLightbox(); }
        if (e.key === 'Escape') closeLightbox();
    }
});

function closeNewsModal() {
    const modal = document.getElementById('news-modal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }
}

const modalClose = document.getElementById('news-modal-close');
if (modalClose) {
    modalClose.addEventListener('click', closeNewsModal);
}

// Закрытие по клику на фон модала
const newsModal = document.getElementById('news-modal');
if (newsModal) {
    newsModal.addEventListener('click', (e) => {
        if (e.target === newsModal) closeNewsModal();
    });
}

// ====================== ОТЗЫВЫ ======================

const REVIEW_KEY = 'reviewSubmitted'; // ключ в localStorage
const REVIEW_TTL = 7 * 24 * 60 * 60 * 1000; // 7 дней

// Сохраняем факт отправки отзыва: имя, ID и время
function saveReviewSubmitted(name, id) {
    localStorage.setItem(REVIEW_KEY, JSON.stringify({
        id: id ?? null,
        name: name.trim().toLowerCase(),
        submittedAt: Date.now()
    }));
}

// Читаем сохранённое состояние (null если нет или истёк)
function getReviewSubmitted() {
    try {
        const data = JSON.parse(localStorage.getItem(REVIEW_KEY));
        if (!data) return null;
        if (Date.now() - data.submittedAt > REVIEW_TTL) {
            localStorage.removeItem(REVIEW_KEY);
            return null;
        }
        return data;
    } catch { return null; }
}

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
            const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
            div.innerHTML = `
                <div class="review-header">
                    <span class="review-name"></span>
                    <span class="review-stars">${stars}</span>
                </div>
                <p class="review-text"></p>
                <small class="review-date"></small>
            `;
            div.querySelector('.review-name').textContent = r.name;
            div.querySelector('.review-text').textContent = r.text;
            div.querySelector('.review-date').textContent = r.date;
            container.appendChild(div);
        });

        // Проверяем: был ли отзыв от этого пользователя одобрен
        checkReviewStatus(reviews);
    } catch (err) { console.error('Отзывы не загружены:', err); }
}

// Проверяем статус отзыва по данным в localStorage vs одобренные отзывы
function checkReviewStatus(approvedReviews) {
    const submitted = getReviewSubmitted();
    if (!submitted) return; // пользователь ещё не оставлял отзыв

    const reviewForm = document.getElementById('review-form');
    const reviewSuccess = document.getElementById('review-success');
    const pendingMsg = document.getElementById('review-pending-msg');
    const approvedMsg = document.getElementById('review-approved-msg');
    if (!reviewForm || !reviewSuccess) return;

    // Прячем форму, показываем блок статуса
    reviewForm.style.display = 'none';
    reviewSuccess.style.display = 'block';

    let isApproved = false;

    // Если есть сохранённый ID — проверяем по нему (надёжно для нового кода)
    if (submitted.id) {
        isApproved = approvedReviews.some(r => r.id === submitted.id);
    } else {
        // Для старых записей, где ID ещё не сохранялся, оставляем проверку по имени
        isApproved = approvedReviews.some(
            r => r.name.trim().toLowerCase() === submitted.name
        );
    }

    if (isApproved) {
        if (pendingMsg) pendingMsg.style.display = 'none';
        if (approvedMsg) approvedMsg.style.display = 'block';
        // Отзыв опубликован — через 3 дня сбросим флаг чтобы снова можно было написать
        const daysSince = (Date.now() - submitted.submittedAt) / (24 * 60 * 60 * 1000);
        if (daysSince > 3) localStorage.removeItem(REVIEW_KEY);
    } else {
        if (pendingMsg) pendingMsg.style.display = 'block';
        if (approvedMsg) approvedMsg.style.display = 'none';
    }
}

// ====================== ИНИЦИАЛИЗАЦИЯ ======================
document.addEventListener('DOMContentLoaded', () => {
    // Загружаем новости и отзывы только если есть соответствующие контейнеры
    if (document.getElementById('news-list')) loadNews();
    if (document.getElementById('reviews-list')) loadReviews();

    // Звезды в отзывах
    const stars = document.querySelectorAll('.star');
    const ratingInput = document.getElementById('review-rating');
    if (stars.length && ratingInput) {
        stars.forEach(star => {
            star.addEventListener('click', () => {
                selectedRating = +star.dataset.value;
                ratingInput.value = selectedRating;
                stars.forEach(s => {
                    s.classList.toggle('active', +s.dataset.value <= selectedRating);
                });
            });
        });
    }

    // Форма отзыва
    const reviewForm = document.getElementById('review-form');
    const reviewSuccess = document.getElementById('review-success');
    if (reviewForm) {
        reviewForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!selectedRating) { alert('Выберите оценку'); return; }
            const nameInput = document.getElementById('review-name');
            const textInput = document.getElementById('review-text');
            if (!nameInput || !textInput) return;
            const res = await fetch('/api/reviews', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: nameInput.value,
                    rating: selectedRating,
                    text: textInput.value,
                    website: document.getElementById('review-website')?.value || ''
                })
            });
            const result = await res.json();
            if (result.success) {
                // Сохраняем имя и ID отзыва в localStorage, чтобы после перезагрузки
                // можно было точно сопоставить его с одобренной записью
                saveReviewSubmitted(nameInput.value, result.id);
                reviewForm.style.display = 'none';
                if (reviewSuccess) reviewSuccess.style.display = 'block';
            } else {
                alert(result.message || 'Ошибка при отправке отзыва');
            }
        });
    }

    // Загрузка заблокированных дат и слотов (только если есть dateInput)
    if (dateInput) {
        fetch('/api/blocked-dates')
            .then(r => r.json())
            .then(dates => {
                blockedDates = dates;
                loadAvailableSlots(today);
            })
            .catch(() => loadAvailableSlots(today));
    }

    // Закрытие мобильного меню при клике на ссылку
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => {
            if (navMenu && navMenu.classList.contains('active')) {
                if (navToggle) navToggle.classList.remove('active');
                navMenu.classList.remove('active');
            }
        });
    });
});

// ====================== ПРОКРУТКА ВВЕРХ ======================
if (scrollTopBtn) {
    window.addEventListener('scroll', () => {
        scrollTopBtn.classList.toggle('visible', window.scrollY > 300);
    });
    scrollTopBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

// ====================== ГАМБУРГЕР ======================
if (navToggle && navMenu) {
    navToggle.addEventListener('click', () => {
        navToggle.classList.toggle('active');
        navMenu.classList.toggle('active');
    });
}

// ===== СМЕНА ФОНА В HERO (КАРТИНКА/ВИДЕО) =====
document.addEventListener('DOMContentLoaded', function() {
    const heroBg = document.querySelector('.hero-bg');
    const heroVideo = document.querySelector('.hero-video');
    if (!heroBg || !heroVideo) return;

    let isImageVisible = true; // сначала видна картинка
    let timeoutId;

    function switchToVideo() {
        if (!isImageVisible) return; // уже видео
        heroBg.style.opacity = '0';
        heroVideo.style.opacity = '1';
        heroVideo.play().catch(e => console.log('Автовоспроизведение заблокировано:', e));
        isImageVisible = false;
        scheduleNext(); // планируем возврат к картинке через 10 секунд
    }

    function switchToImage() {
        if (isImageVisible) return; // уже картинка
        heroBg.style.opacity = '1';
        heroVideo.style.opacity = '0';
        heroVideo.pause();
        heroVideo.currentTime = 0; // сбрасываем видео в начало
        isImageVisible = true;
        scheduleNext(); // планируем следующее видео через 2 секунды
    }

    function scheduleNext() {
        clearTimeout(timeoutId);
        const delay = isImageVisible ? 5000 : 15000; // 5 сек картинка, 15 сек видео
        timeoutId = setTimeout(isImageVisible ? switchToVideo : switchToImage, delay);
    }

    // Стартуем цикл (первая смена через 5 секунд)
    scheduleNext();

    // Если видео не может загрузиться, продолжаем показывать картинку
    heroVideo.addEventListener('error', () => {
        clearTimeout(timeoutId);
        heroBg.style.opacity = '1';
        heroVideo.style.opacity = '0';
    });
});
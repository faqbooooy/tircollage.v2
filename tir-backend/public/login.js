// ==================== УТИЛИТЫ ====================

function showError(msg) {
    const el = document.getElementById('login-error');
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
}

function formatPhone(value) {
    const digits = value.replace(/\D/g, '').slice(0, 11);
    if (!digits) return '';
    let result = '+7';
    if (digits.length > 1) result += ' (' + digits.slice(1, 4);
    if (digits.length > 4) result += ') ' + digits.slice(4, 7);
    if (digits.length > 7) result += '-' + digits.slice(7, 9);
    if (digits.length > 9) result += '-' + digits.slice(9, 11);
    return result;
}

function getRawPhone() {
    return document.getElementById('user-phone').value.replace(/\D/g, '');
}

// ==================== ТАБЫ ====================

document.querySelectorAll('.login-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.login-tab-content').forEach(c => c.style.display = 'none');
        document.getElementById('tab-' + tab.dataset.tab).style.display = 'block';
        showError('');
    });
});

// ==================== ТЕЛЕФОН — МАСКА ====================

const phoneInput = document.getElementById('user-phone');
phoneInput.addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    e.target.value = formatPhone(e.target.value);
    showError('');
});

phoneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-check-phone').click();
});

// ==================== ПИН — АВТОПЕРЕХОД МЕЖДУ ПОЛЯМИ ====================

function setupPinInputs(container) {
    const digits = container.querySelectorAll('.pin-digit');
    digits.forEach((input, i) => {
        input.addEventListener('input', () => {
            input.value = input.value.replace(/\D/g, '').slice(0, 1);
            if (input.value && i < digits.length - 1) digits[i + 1].focus();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !input.value && i > 0) digits[i - 1].focus();
        });
        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 4);
            digits.forEach((d, j) => { d.value = pasted[j] || ''; });
            if (pasted.length === 4) digits[3].focus();
        });
    });
}

function getPin(container) {
    return Array.from(container.querySelectorAll('.pin-digit')).map(d => d.value).join('');
}

function clearPin(container) {
    container.querySelectorAll('.pin-digit').forEach(d => d.value = '');
    container.querySelector('.pin-digit')?.focus();
}

setupPinInputs(document.getElementById('step-login'));
setupPinInputs(document.getElementById('step-register'));

// ==================== ШАГ 1: ПРОВЕРКА ТЕЛЕФОНА ====================

document.getElementById('btn-check-phone').addEventListener('click', async () => {
    const phone = getRawPhone();
    if (phone.length !== 11) { showError('Введите корректный номер телефона'); return; }
    showError('');

    try {
        const res = await fetch('/api/check-phone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        const data = await res.json();

        if (!res.ok) { showError(data.message || 'Ошибка'); return; }

        const display = formatPhone(phone);
        document.getElementById('step-phone').style.display = 'none';

        if (data.exists) {
            // Пин уже есть — показываем форму входа
            document.getElementById('login-phone-display').textContent = display;
            document.getElementById('step-login').style.display = 'block';
            document.querySelector('#step-login .pin-digit').focus();
        } else {
            // Новый пользователь — показываем регистрацию
            document.getElementById('register-phone-display').textContent = display;
            document.getElementById('step-register').style.display = 'block';
            document.querySelector('#pin-create-wrap .pin-digit').focus();
        }
    } catch { showError('Ошибка соединения'); }
});

// Кнопки "назад"
document.getElementById('btn-back-login').addEventListener('click', () => {
    document.getElementById('step-login').style.display = 'none';
    document.getElementById('step-phone').style.display = 'block';
    clearPin(document.getElementById('step-login'));
    showError('');
});

document.getElementById('btn-back-register').addEventListener('click', () => {
    document.getElementById('step-register').style.display = 'none';
    document.getElementById('step-phone').style.display = 'block';
    clearPin(document.getElementById('step-register'));
    // Сброс состояния регистрации
    document.getElementById('pin-confirm-wrap').style.display = 'none';
    document.getElementById('confirm-hint').style.display = 'none';
    document.getElementById('btn-register').style.display = 'none';
    showError('');
});

// ==================== ШАГ 2a: ВХОД ====================

document.getElementById('btn-login').addEventListener('click', async () => {
    const phone = getRawPhone();
    const pin = getPin(document.getElementById('step-login'));
    if (pin.length !== 4) { showError('Введите 4-значный пин'); return; }

    try {
        const res = await fetch('/api/user/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, pin })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            localStorage.setItem('userToken', data.token);
            window.location.replace('/cabinet');
        } else {
            showError(data.message || 'Неверный пин');
            clearPin(document.getElementById('step-login'));
        }
    } catch { showError('Ошибка соединения'); }
});

// ==================== ШАГ 2b: РЕГИСТРАЦИЯ ====================

// После ввода первого пина — показываем подтверждение
const pinCreateWrap = document.getElementById('pin-create-wrap');
pinCreateWrap.querySelectorAll('.pin-digit').forEach((input, i, arr) => {
    if (i === arr.length - 1) {
        input.addEventListener('input', () => {
            if (getPin(pinCreateWrap).length === 4) {
                document.getElementById('confirm-hint').style.display = 'block';
                document.getElementById('pin-confirm-wrap').style.display = 'flex';
                document.getElementById('btn-register').style.display = 'block';
                document.querySelector('#pin-confirm-wrap .pin-digit').focus();
            }
        });
    }
});

document.getElementById('btn-register').addEventListener('click', async () => {
    const phone = getRawPhone();
    const pin1 = getPin(pinCreateWrap);
    const pin2 = getPin(document.getElementById('pin-confirm-wrap'));

    if (pin1.length !== 4 || pin2.length !== 4) { showError('Введите пин в оба поля'); return; }
    if (pin1 !== pin2) {
        showError('Пины не совпадают');
        clearPin(document.getElementById('pin-confirm-wrap'));
        document.querySelector('#pin-confirm-wrap .pin-digit').focus();
        return;
    }

    try {
        const res = await fetch('/api/user/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, pin: pin1 })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            localStorage.setItem('userToken', data.token);
            window.location.replace('/cabinet');
        } else {
            showError(data.message || 'Ошибка регистрации');
        }
    } catch { showError('Ошибка соединения'); }
});

// ==================== ВХОД АДМИНИСТРАТОРА ====================

document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const remember = document.getElementById('remember-me').checked;

    try {
        const res = await fetch('/api/admin-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, remember })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            localStorage.setItem('adminToken', data.token);
            window.location.assign('/admin');
        } else {
            showError(data.message || 'Неверный логин или пароль');
        }
    } catch { showError('Ошибка соединения'); }
});

// ==================== АВТОВХОД ADMIN ПО COOKIE ====================
// При загрузке страницы всегда пробуем обновить токен по cookie.
// Если cookie есть и валидна — редиректим в /admin.
// Если нет — просто показываем форму (без ошибок в консоли).
(async () => {
    // Переключаем на таб "Персонал" если пришли из /admin (после logout)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('tab') === 'admin') {
        document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.login-tab-content').forEach(c => c.style.display = 'none');
        document.querySelector('[data-tab="admin"]')?.classList.add('active');
        document.getElementById('tab-admin').style.display = 'block';
    }

    // Пробуем автовход по cookie — всегда, независимо от активного таба
    try {
        const res = await fetch('/api/refresh-token', { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            if (data.success && data.token) {
                localStorage.setItem('adminToken', data.token);
                window.location.replace('/admin');
            }
        }
        // 401 — нет cookie или истекла, просто показываем форму (это норма, не ошибка)
    } catch { /* нет связи — показываем форму */ }
})();
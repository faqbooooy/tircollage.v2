// ================= МОДАЛЬНОЕ ОКНО =================

function showMessage(message) {
    const modal = document.getElementById('modal');
    const modalMessage = document.getElementById('modal-message');
    const cancelBtn = document.getElementById('modal-cancel');

    modalMessage.textContent = message;
    modal.style.display = 'flex';

    return new Promise((resolve) => {
        cancelBtn.onclick = () => {
            modal.style.display = 'none';
            resolve();
        };
    });
}

// ================= АВТОВХОД ПО COOKIE =================
// Если у пользователя есть remember-cookie — сразу получаем свежий токен
// и перенаправляем в админку без ввода пароля
(async () => {
    try {
        const res = await fetch('/api/refresh-token', { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            if (data.success && data.token) {
                localStorage.setItem('adminToken', data.token);
                window.location.replace('/admin');
            }
        }
    } catch {
        // Cookie нет или истёк — просто показываем форму входа
    }
})();

// ================= ФОРМА ВХОДА =================

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const remember = document.getElementById('remember-me').checked;

    try {
        const response = await fetch('/api/admin-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, remember })
        });

        if (!response.ok) {
            throw new Error(`HTTP ошибка: ${response.status}`);
        }

        const result = await response.json();

        if (result.success) {
            localStorage.setItem('adminToken', result.token);
            window.location.assign('/admin');
        } else {
            await showMessage('Неверный логин или пароль');
        }
    } catch (error) {
        await showMessage('Ошибка при входе: ' + error.message);
    }
});
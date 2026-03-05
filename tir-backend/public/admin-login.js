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

// ================= ФОРМА ВХОДА =================

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    try {
        const response = await fetch('/api/admin-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
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

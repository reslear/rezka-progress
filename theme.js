const themes = ['auto', 'light', 'dark'];
const themeLabels = { auto: 'Автоматически', light: 'Светлая', dark: 'Тёмная' };
const themeIcons = { auto: '◐', light: '☀', dark: '☾' };
let theme = localStorage.getItem('theme') || 'auto';
if (theme !== 'auto') document.documentElement.dataset.theme = theme;

document.addEventListener('DOMContentLoaded', () => {
  const button = document.querySelector('#theme');
  function renderTheme() {
    button.textContent = `${themeIcons[theme]} ${themeLabels[theme]}`;
    button.title = `Тема: ${themeLabels[theme]}. Нажми, чтобы переключить`;
    button.setAttribute('aria-label', button.title);
  }
  button.onclick = async () => {
    theme = themes[(themes.indexOf(theme) + 1) % themes.length];
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
    await chrome.storage.local.set({ theme });
    renderTheme();
  };
  function applyTheme(value) {
    theme = value;
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
    renderTheme();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.theme) applyTheme(changes.theme.newValue || 'auto');
  });
  void chrome.storage.local.get('theme').then(stored => {
    if (stored.theme) applyTheme(stored.theme);
    else return chrome.storage.local.set({ theme });
  });
  renderTheme();
});

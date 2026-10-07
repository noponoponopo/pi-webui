import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

const theme = localStorage.getItem('pi-webui-theme') || 'system';
document.documentElement.dataset.theme =
  theme === 'system'
    ? matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    : theme;
createRoot(document.getElementById('root')!).render(<App />);

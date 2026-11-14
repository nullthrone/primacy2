import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import '@fontsource/share-tech-mono/400.css';
import { render } from 'preact';
import { App } from './App.tsx';
import './audition.css';
import { setLang, lang } from './strings.ts';

setLang(lang.value);
const root = document.getElementById('audition');
if (root) render(<App />, root);

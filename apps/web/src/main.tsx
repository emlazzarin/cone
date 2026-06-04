import { render } from 'preact';

import { App } from './app';
import './style.css';

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js');
}

render(<App />, document.getElementById('app')!);

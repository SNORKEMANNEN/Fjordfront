import '@fontsource/barlow-condensed/400.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import './ui/styles.css';
import { Game } from './game/Game';
import { Settings } from './game/Settings';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLDivElement;
const game = new Game(canvas, ui);
(window as any).game = game;
(window as any).Settings = Settings;
game.boot().catch((e) => {
  console.error(e);
  ui.innerHTML = `<div class="fatal"><h1>Failed to start</h1><pre>${String(e?.stack ?? e)}</pre></div>`;
});

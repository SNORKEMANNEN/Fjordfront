export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface SettingsData {
  sensitivity: number; // degrees per 1000 px-ish multiplier
  adsSensitivity: number;
  /** sensitivity multiplier while looking through the sniper scope */
  scopeSensitivity: number;
  invertY: boolean;
  fov: number;
  /** viewmodel (weapon) field of view, vertical degrees */
  weaponFov: number;
  /** arms field of view, vertical degrees (forearms/elbows; the hands stay on the weapon) */
  armsFov: number;
  /** 'affected': ADS zoom scales with your FOV; 'independent': ADS always uses the default 80° base */
  adsFov: 'affected' | 'independent';
  toggleCrouch: boolean;
  toggleAds: boolean;
  quality: Quality;
  renderScale: number;
  /** lower the render resolution automatically when the frame rate drops */
  dynamicRes: boolean;
  /** render at the display's full device-pixel ratio (sharper on HiDPI screens, much slower) */
  hiDpi: boolean;
  /** F3 performance overlay */
  perfOverlay: boolean;
  targetFps: number;
  shadows: boolean;
  shadowRes: number;
  ao: boolean;
  bloom: boolean;
  antialias: boolean;
  motionBlur: boolean;
  dof: boolean;
  grassDensity: number;
  weather: 'auto' | 'clear' | 'overcast' | 'rain' | 'snow';
  /** map variant: autumn, winter (snow-covered), or random per match */
  mapVariant: 'autumn' | 'winter' | 'random';
  timeOfDay: 'dynamic' | 'dawn' | 'day' | 'golden' | 'night';
  godRays: boolean;
  masterVolume: number;
  sfxVolume: number;
  ambienceVolume: number;
  musicVolume: number;
  showFps: boolean;
  botDifficulty: 'recruit' | 'regular' | 'veteran';
}

const PRESETS: Record<Quality, Partial<SettingsData>> = {
  low: { renderScale: 0.75, shadows: true, shadowRes: 1024, ao: false, bloom: false, antialias: false, grassDensity: 0.3 },
  medium: { renderScale: 0.9, shadows: true, shadowRes: 2048, ao: true, bloom: true, antialias: false, grassDensity: 0.6 },
  high: { renderScale: 1, shadows: true, shadowRes: 2048, ao: true, bloom: true, antialias: true, grassDensity: 1 },
  ultra: { renderScale: 1, shadows: true, shadowRes: 4096, ao: true, bloom: true, antialias: true, grassDensity: 1.5 },
};

const DEFAULTS: SettingsData = {
  sensitivity: 1.0,
  adsSensitivity: 0.85,
  scopeSensitivity: 0.2,
  invertY: false,
  fov: 80,
  weaponFov: 48,
  armsFov: 48,
  adsFov: 'affected',
  toggleCrouch: true,
  toggleAds: false,
  quality: 'high',
  renderScale: 1,
  dynamicRes: true,
  hiDpi: false,
  perfOverlay: false,
  targetFps: 60,
  shadows: true,
  shadowRes: 2048,
  ao: true,
  bloom: true,
  antialias: true,
  motionBlur: false,
  dof: true,
  grassDensity: 1,
  weather: 'auto',
  mapVariant: 'random',
  timeOfDay: 'dynamic',
  godRays: true,
  masterVolume: 0.8,
  sfxVolume: 1,
  ambienceVolume: 0.7,
  musicVolume: 0.6,
  showFps: false,
  botDifficulty: 'regular',
};

type Listener = (d: SettingsData) => void;

class SettingsStore {
  data: SettingsData = { ...DEFAULTS };
  private listeners: Listener[] = [];
  constructor() {
    try {
      const raw = localStorage.getItem('fjordfront.settings');
      if (raw) this.data = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      /* storage unavailable */
    }
    const q = new URLSearchParams(location.search).get('quality') as Quality | null;
    if (q && PRESETS[q]) this.applyPreset(q, false);
    const w = new URLSearchParams(location.search).get('weather') as SettingsData['weather'] | null;
    if (w) this.data.weather = w;
    const mv = new URLSearchParams(location.search).get('map') as SettingsData['mapVariant'] | null;
    if (mv) this.data.mapVariant = mv;
    const tod = new URLSearchParams(location.search).get('time') as SettingsData['timeOfDay'] | null;
    if (tod) this.data.timeOfDay = tod;
  }
  applyPreset(q: Quality, save = true) {
    this.data = { ...this.data, ...PRESETS[q], quality: q };
    if (save) this.save();
  }
  set<K extends keyof SettingsData>(k: K, v: SettingsData[K]) {
    this.data[k] = v;
    this.save();
  }
  save() {
    try {
      localStorage.setItem('fjordfront.settings', JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l(this.data);
  }
  onChange(l: Listener) {
    this.listeners.push(l);
  }
  reset() {
    this.data = { ...DEFAULTS };
    this.save();
  }
}

export const Settings = new SettingsStore();

import type { Quality } from '../game/Settings';

/**
 * What the machine is, as far as a web page can tell: the GPU's name (WEBGL_debug_renderer_info,
 * exposed by Chrome / Edge / Safari; Firefox reports a generic but still classifiable name), CPU
 * threads and device memory. Used once to pick a sensible starting preset — the frame-time governor
 * (PerfGovernor) then keeps the frame rate on the actual hardware.
 */
export interface HardwareInfo {
  gpu: string;
  /** 0 software / weak integrated, 1 good integrated, 2 entry discrete / Apple silicon, 3 strong discrete */
  tier: 0 | 1 | 2 | 3;
  integrated: boolean;
  cores: number;
  memoryGB: number;
  /** KHR_parallel_shader_compile: shaders compile on driver threads instead of stalling the page */
  parallelCompile: boolean;
  /** float colour targets (used by the texture baker for exact height fields) */
  floatTargets: boolean;
}

export function detectHardware(gl: WebGL2RenderingContext): HardwareInfo {
  let gpu = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    gpu = '';
  }
  const g = gpu.toLowerCase();
  const cores = navigator.hardwareConcurrency || 4;
  const memoryGB = (navigator as any).deviceMemory || 8;
  let tier: HardwareInfo['tier'] = 2;
  let integrated = false;
  const has = (...k: string[]) => k.some((s) => g.includes(s));
  if (has('swiftshader', 'llvmpipe', 'software', 'basic render', 'softpipe')) tier = 0;
  else if (has('mali', 'adreno', 'powervr', 'videocore')) (tier = 0), (integrated = true);
  else if (has('nvidia', 'geforce', 'quadro', 'rtx', 'gtx')) {
    if (/rtx\s*a?\d|rtx\s*[2-9]\d{3}/.test(g)) tier = 3;
    else if (/gtx\s*(9[6-9]0|10[5-8]0|16[5-6]0)|titan/.test(g)) tier = 2;
    else if (/\bmx\s*\d|gt\s*\d|gtx\s*(7|8|9[0-5])/.test(g)) tier = 1;
    else tier = 2;
  } else if (has('intel')) {
    integrated = !has('arc');
    tier = has('arc') ? 2 : has('iris', 'xe') ? 1 : 0;
  } else if (has('amd', 'radeon', 'ati ')) {
    // Ryzen APUs report "AMD Radeon(TM) Graphics" / "Radeon Vega 8"; discrete cards carry an RX model
    if (/\brx\s*\d|radeon\s*(pro|vii)/.test(g)) tier = /rx\s*(5[5-9]|6\d|7\d)\d\d|rx\s*[67]\d\d\d/.test(g) ? 3 : 2;
    else (integrated = true), (tier = has('780m', '760m', '890m', '880m', '680m') ? 2 : 1);
  } else if (has('apple')) {
    // Apple silicon (M-series) is a capable integrated GPU; "Apple GPU" alone is iOS / iPadOS
    tier = /apple m\d/.test(g) ? 2 : 1;
    integrated = true;
  }
  // a weak CPU caps the preset as well: 24 soldiers' AI and animation run on it
  if (cores <= 2 || memoryGB <= 2) tier = 0;
  else if ((cores <= 4 || memoryGB <= 4) && tier > 1) tier = 1;
  return {
    gpu,
    tier,
    integrated,
    cores,
    memoryGB,
    parallelCompile: !!gl.getExtension('KHR_parallel_shader_compile'),
    floatTargets: !!gl.getExtension('EXT_color_buffer_float'),
  };
}

export function presetForTier(tier: HardwareInfo['tier']): Quality {
  return tier === 0 ? 'low' : tier === 1 ? 'medium' : 'high';
}

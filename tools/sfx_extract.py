import subprocess, sys, json, numpy as np, os
SR = 48000
def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()
def env(x, win=0.004):
    m = np.abs(x).max(axis=1)
    n = int(win * SR)
    k = np.ones(n) / n
    return np.convolve(m, k, mode='same')
def events(x, rel_db=-28, gap=0.18, minlen=0.02):
    e = env(x)
    peak = e.max() + 1e-12
    th = peak * 10 ** (rel_db / 20)
    on = e > th
    ev = []
    i = 0
    N = len(e)
    while i < N:
        if on[i]:
            j = i
            last = i
            while j < N and (on[j] or (j - last) < gap * SR):
                if on[j]: last = j
                j += 1
            if (last - i) / SR >= minlen:
                ev.append((i, last, float(e[i:last + 1].max())))
            i = j
        else:
            i += 1
    return ev, e, peak
def cut(x, e, s, maxlen, tail_db=-55, pre=0.004, nxt=None):
    a = max(0, s - int(pre * SR))
    pk = e[s:s + int(0.05 * SR)].max()
    th = pk * 10 ** (tail_db / 20)
    end = min(len(x), s + int(maxlen * SR))
    if nxt is not None: end = min(end, nxt - int(0.01 * SR))
    # walk back from end to last sample above threshold
    seg_e = e[s:end]
    above = np.nonzero(seg_e > th)[0]
    stop = s + (above[-1] if len(above) else int(0.05 * SR)) + int(0.03 * SR)
    stop = min(stop, end)
    y = x[a:stop].copy()
    f = min(len(y) // 3, int(0.06 * SR))
    if f > 8:
        y[-f:] *= np.linspace(1, 0, f)[:, None] ** 2
    fi = min(int(0.002 * SR), len(y) // 4)
    if fi > 1: y[:fi] *= np.linspace(0, 1, fi)[:, None]
    return y
def save(y, out, peak_db=-1.0, mono=False):
    p = np.abs(y).max() + 1e-12
    y = y * (10 ** (peak_db / 20) / p)
    if mono: y = y.mean(axis=1, keepdims=True)
    ch = y.shape[1]
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', str(ch), '-i', '-', '-c:a', 'libvorbis', '-q:a', '6', out], input=y.astype(np.float32).tobytes(), check=True)
if __name__ == '__main__':
    for path in sys.argv[1:]:
        x = load(path)
        ev, e, pk = events(x)
        print(f'{os.path.basename(path)}: {len(x)/SR:.2f}s peak {20*np.log10(pk):.1f}dB events {len(ev)}: ' + ' '.join(f'{s/SR:.2f}-{t/SR:.2f}({20*np.log10(p):.0f})' for s, t, p in ev[:12]))

#!/usr/bin/env python3
"""
Update 45 ("Nordlys") audio: a new score and the cinematic interface stingers.

  python3 tools/audio45_build.py generate   # calls the APIs (Stable Audio 2.5, ElevenLabs sound generation)
  python3 tools/audio45_build.py master     # trim / loop-crossfade / loudness-normalise into public/assets

Music: Stable Audio 2.5 (Stability AI, text-to-audio). Stingers: ElevenLabs sound generation.
Keys are injected by a proxy (or set STABILITY_KEY / ELEVEN_API_KEY). Every prompt is an original
description; no reference to existing scores, artists or games.
"""
import json, os, subprocess, sys, urllib.request, wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'tools', 'audio45_raw')
MUSIC = os.path.join(ROOT, 'public', 'assets', 'music')
UI = os.path.join(ROOT, 'public', 'assets', 'sounds', 'ui')

STYLE = 'modern hybrid orchestral and electronic production, crisp, wide stereo, polished premium game soundtrack'
STABLE = {
    # (seconds, prompt, loop?)
    'menu_theme': (150, 'Original cinematic main menu theme for a tactical shooter set on the Arctic coast of Norway under the northern lights. 88 BPM, D minor. Opens with shimmering icy glass-like synth arpeggios and a deep breathing sub-bass pulse, a haunting wordless female vocal calling across a fjord, slow wide string pads. Builds with heavy frame drums and low taiko, driving staccato cellos and a bold low brass motif, reaching a soaring emotional climax with full strings and wordless choir, then falls back to the icy arpeggio and pulse for a seamless loop. ' + STYLE, True),
    'match_open': (96, 'Original tense atmospheric underscore for the start of a tactical military battle on a cold Norwegian coast, 88 BPM, D minor. Steady ticking synth pulse, muted low drums, deep sub bass, cold airy pads, sparse distant metallic percussion, occasional low string swells, restrained and driving, no melody, constant intensity, leaves room for sound effects, seamless loop. ' + STYLE, True),
    'tension': (64, 'Urgent tense underscore loop for the final minute of a close tactical battle, 120 BPM, D minor. Driving ticking pulse, pounding low toms and a heartbeat kick, ostinato staccato strings, rising tremolo, gritty synth bass, metallic hits, constant high intensity, no melody, steady level from start to end, seamless loop. ' + STYLE, True),
    'victory': (16, 'Short triumphant victory sting for a tactical shooter, 16 seconds. Bold low brass and full strings in D major over powerful frame drums and taiko, shimmering icy synth arpeggio on top, a soaring wordless female vocal phrase, ends on a sustained bright resolved chord ringing out. ' + STYLE, False),
    'defeat': (14, 'Short somber defeat sting for a tactical shooter, 14 seconds. Lonely wordless female vocal and low cello over a soft cold synth pad and a distant timpani roll in D minor, one heavy low drum hit, ends on a dark unresolved sustained chord that fades out. Cinematic and restrained, ' + STYLE, False),
}
ELEVEN = {
    'deploy': (3.2, 'Cinematic deploy sting for a military game: a fast rising airy whoosh and synth riser that slams into a huge deep sub boom impact with a metallic shimmer tail, clean, powerful, no voice'),
    'match_found': (2.4, 'Game menu notification for a match being found: a deep warm synth swell with a bright crystalline bell chime on top, modern, clean, uplifting, short'),
    'whoosh': (0.8, 'Short soft airy whoosh of a menu panel sliding into view, clean modern interface sound, smooth, no impact'),
    'round_start': (2.0, 'Tactical shooter round start: a short tense metallic hit with a deep sub drop and a quick reversed swell, cinematic, punchy'),
}


def generate():
    os.makedirs(RAW, exist_ok=True)
    for name, (dur, prompt) in ELEVEN.items():
        dst = os.path.join(RAW, name + '.mp3')
        if os.path.exists(dst):
            continue
        req = urllib.request.Request('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', method='POST',
                                     data=json.dumps({'text': prompt, 'duration_seconds': dur, 'prompt_influence': 0.6}).encode(),
                                     headers={'xi-api-key': os.environ.get('ELEVEN_API_KEY', 'proxy-injected'), 'Content-Type': 'application/json'})
        open(dst, 'wb').write(urllib.request.urlopen(req, timeout=180).read())
        print('eleven', name, flush=True)
    for name, (dur, prompt, _loop) in STABLE.items():
        dst = os.path.join(RAW, name + '.mp3')
        if os.path.exists(dst):
            continue
        r = subprocess.run(['curl', '-sS', '-o', dst, '-w', '%{http_code}', '-X', 'POST', 'https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio',
                            '-H', 'Authorization: Bearer ' + os.environ.get('STABILITY_KEY', 'proxy-injected'), '-H', 'Accept: audio/*',
                            '-F', 'model=stable-audio-2.5', '-F', 'output_format=mp3', '-F', f'duration={dur}', '-F', 'steps=8', '-F', 'cfg_scale=1',
                            '--form-string', 'prompt=' + prompt], capture_output=True, text=True)
        print('stable', name, r.stdout, r.stderr[-300:], flush=True)
        if r.stdout.strip() != '200' and os.path.exists(dst):
            print(open(dst, 'rb').read()[:400], flush=True)
            os.remove(dst)


def decode(src, ch=2):
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', src, '-f', 's16le', '-ac', str(ch), '-ar', '44100', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32).reshape(-1, ch) / 32768


def encode(x, dst, ch=2, q=5):
    tmp = dst + '.wav'
    with wave.open(tmp, 'wb') as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', tmp, '-c:a', 'libvorbis', '-q:a', str(q), dst], check=True)
    os.remove(tmp)


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)


def normalise(x, target_db, peak=0.95):
    x = x * (10 ** ((target_db - rms_db(x)) / 20))
    p = np.max(np.abs(x))
    if p > peak:  # soft limit the few peaks above the ceiling
        x = np.tanh(x / peak * 1.2) * peak / np.tanh(1.2)
    return x


def trim(x, thr=0.003):
    a = np.max(np.abs(x), axis=1)
    idx = np.where(a > thr)[0]
    if not len(idx):
        return x
    return x[max(0, idx[0] - 200): idx[-1] + 4410]


def loop_xfade(x, xf=2.0):
    """make a seamless loop: the tail is crossfaded (equal power) into the head"""
    n = int(xf * 44100)
    if len(x) < n * 3:
        return x
    head, body, tail = x[:n], x[n:-n], x[-n:]
    t = np.linspace(0, np.pi / 2, n)[:, None]
    blend = tail * np.cos(t) + head * np.sin(t)
    return np.concatenate([body, blend])


def fade(x, fin=0.01, fout=0.5):
    a, b = int(fin * 44100), int(fout * 44100)
    if a:
        x[:a] *= np.linspace(0, 1, a)[:, None]
    if b:
        x[-b:] *= np.linspace(1, 0, b)[:, None] ** 2
    return x


def master():
    os.makedirs(MUSIC, exist_ok=True)
    for name, (_d, _p, loop) in STABLE.items():
        src = os.path.join(RAW, name + '.mp3')
        if not os.path.exists(src):
            print('missing', name)
            continue
        x = decode(src)
        if loop:
            x = loop_xfade(trim(x, 0.0005), 2.5)
            x = normalise(x, -17 if name != 'match_open' else -19)
        else:
            x = fade(trim(x), 0.005, 1.2)
            x = normalise(x, -16)
        encode(x, os.path.join(MUSIC, name + '.ogg'), q=4)
        print('music', name, f'{len(x) / 44100:.1f}s')
    for name in ELEVEN:
        src = os.path.join(RAW, name + '.mp3')
        if not os.path.exists(src):
            print('missing', name)
            continue
        x = fade(trim(decode(src)), 0.002, 0.25)
        x = normalise(x, -16 if name != 'whoosh' else -20)
        encode(x, os.path.join(UI, name + '.ogg'), q=5)
        print('ui', name, f'{len(x) / 44100:.2f}s')


if __name__ == '__main__':
    {'generate': generate, 'master': master}[sys.argv[1]]()

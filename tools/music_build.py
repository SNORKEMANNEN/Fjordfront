#!/usr/bin/env python3
"""
Generate and master the music + a few designed effects.

  python3 tools/music_build.py generate   # calls the APIs (Stable Audio 2.5, ElevenLabs sound generation)
  python3 tools/music_build.py master     # loop-crossfade / normalise into public/assets/music + sounds

Music: Stable Audio 2.5 (Stability AI API, text-to-audio): menu theme, victory sting, tension loop.
Defeat sting + NVG / glass effects: ElevenLabs sound-generation API. Keys are injected by a proxy
(or set STABILITY_KEY / ELEVEN_API_KEY). Every prompt is an original description; no reference
to existing scores or games.
"""
import json, os, subprocess, sys, urllib.request, wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'tools', 'music_raw')
MUSIC = os.path.join(ROOT, 'public', 'assets', 'music')
SFX = os.path.join(ROOT, 'public', 'assets', 'sounds', 'designed')

STABLE = {
    'menu_theme': (120, 'Original cinematic military main menu theme for a modern tactical shooter set in winter Norway. Slow building orchestral hybrid score, 92 BPM, D minor. Deep pulsing synth bass ostinato, taiko and low toms, staccato low strings, sparse Hardanger fiddle-like solo violin melody over cold atmospheric pads, distant brass swells, subtle electronic percussion, heroic yet somber, wide stereo, polished film trailer production, builds to a powerful climax and settles back down, seamless loopable ending'),
    'victory': (14, 'Short triumphant orchestral victory sting for a military shooter match win, 14 seconds. Big brass fanfare in D major, taiko hits, rising strings, cymbal swell, heroic Nordic flavour with solo fiddle flourish, ends on a sustained resolved chord that rings out. Polished film score production.'),
    'tension': (64, 'Subtle tense atmospheric underscore loop for the final moments of a tactical military match, 64 seconds, 120 BPM, D minor. Ticking clock-like pulse, low pulsing synth bass, muted heartbeat kick, tremolo low strings, quiet rising dissonant pads, sparse metallic hits, no melody, steady unchanging intensity throughout, minimal and suspenseful, constant level, seamless loop, polished film score production.'),
}
# death cries: varied so twelve-a-side firefights never repeat the same one back to back
SCREAMS = [
    (1.4, 'Adult man shot in a battle, short sharp agonised scream that is cut off, gritty, no music'),
    (1.6, 'Soldier hit by gunfire, loud pained yell then a choked gasp as he falls, realistic, dry'),
    (1.2, 'Man grunting in shock and pain as a bullet hits, short guttural cry, battlefield'),
    (1.8, 'Dying man screaming in agony, ragged breathy scream fading into a groan'),
    (1.3, 'Male soldier death cry, strained "argh" shout, abrupt end, close microphone'),
    (1.5, 'Man hit in the chest, winded cry and wheezing collapse, realistic voice'),
    (1.6, 'Soldier killed, high pitched panicked scream breaking off, war film foley'),
    (1.4, 'Deep voiced man roaring in pain as he is shot, short and harsh'),
    (1.7, 'Wounded soldier moaning and crying out as he falls to the ground, gasping'),
    (1.2, 'Short startled pained yelp of a man hit by a bullet, then silence'),
]

ELEVEN = {
    'door_breach0': (1.6, 'Heavy wooden door violently kicked in, huge boot impact, wood cracking and splintering, door frame snapping, door slamming into the wall, close and loud, realistic'),
    'door_breach1': (1.5, 'Police breach kick on a wooden front door, deep thud, splintering crack and the door banging open against an interior wall'),
    'door_breach2': (1.4, 'Powerful kick bursting a locked door open, sharp wood splinter crack, latch breaking, heavy slam'),
    'defeat': (12, 'Somber orchestral defeat sting for a military game match loss: low mournful French horn and cello phrase in D minor over a soft timpani roll, fading distant drum, ends on an unresolved dark sustained chord, cinematic film score'),
    'nvg_on': (2.5, 'Night vision goggles activation: soft mechanical click of the mount flipping down, then a rising high-pitched electronic capacitor charging whine that settles into a faint steady hum, military tactical'),
    'nvg_off': (1.5, 'Night vision goggles switching off: plastic mount flip up click and a descending electronic whine powering down'),
    'glass_crack': (1, 'Single bullet hitting a window pane, sharp glass crack and spider-web fracture tick, no shattering'),
    'glass_shatter': (2.5, 'Window pane shattering from gunfire, glass breaking and shards falling and tinkling on the floor'),
}


def generate():
    os.makedirs(RAW, exist_ok=True)
    for name, (dur, prompt) in STABLE.items():
        dst = os.path.join(RAW, name + '.mp3')
        if os.path.exists(dst):
            continue
        subprocess.run(['curl', '-sS', '-o', dst, '-X', 'POST', 'https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio',
                        '-H', 'Authorization: Bearer ' + os.environ.get('STABILITY_KEY', 'proxy-injected'), '-H', 'Accept: audio/*',
                        '-F', 'model=stable-audio-2.5', '-F', 'output_format=mp3', '-F', f'duration={dur}', '-F', 'steps=8', '-F', 'cfg_scale=1',
                        '-F', 'prompt=' + prompt], check=True)
    jobs = list(ELEVEN.items()) + [(f'scream{i}', v) for i, v in enumerate(SCREAMS)]
    for name, (dur, prompt) in jobs:
        dst = os.path.join(RAW, name + '.mp3')
        if os.path.exists(dst):
            continue
        req = urllib.request.Request('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', method='POST',
                                     data=json.dumps({'text': prompt, 'duration_seconds': dur, 'prompt_influence': 0.55}).encode(),
                                     headers={'xi-api-key': os.environ.get('ELEVEN_API_KEY', 'proxy-injected'), 'Content-Type': 'application/json'})
        open(dst, 'wb').write(urllib.request.urlopen(req, timeout=120).read())


def decode(src, ch=2):
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', src, '-f', 's16le', '-ac', str(ch), '-ar', '44100', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32).reshape(-1, ch) / 32768


def encode(x, dst, ch=2, q=5, lufs=None):
    tmp = dst + '.wav'
    with wave.open(tmp, 'wb') as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(44100)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    af = ['-af', f'loudnorm=I={lufs}:TP=-1.5:LRA=11'] if lufs else []
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp, *af, '-ar', '44100', '-c:a', 'libvorbis', '-q:a', str(q), dst], check=True)
    os.remove(tmp)


def loopify(x, xf):
    """Seamless loop: fold the last `xf` seconds over the first with an equal-power crossfade."""
    n = int(xf * 44100)
    head, tail = x[:n], x[-n:]
    t = np.linspace(0, 1, n)[:, None]
    mixed = head * np.sin(t * np.pi / 2) + tail * np.cos(t * np.pi / 2)
    return np.concatenate([mixed, x[n:-n]])


def master():
    os.makedirs(MUSIC, exist_ok=True)
    os.makedirs(SFX, exist_ok=True)
    r = lambda n: os.path.join(RAW, n + '.mp3')
    encode(loopify(decode(r('menu_theme')), 4.0), os.path.join(MUSIC, 'menu_theme.ogg'), lufs=-16)
    encode(loopify(decode(r('tension')), 3.0), os.path.join(MUSIC, 'tension.ogg'), lufs=-18)
    for n in ('victory', 'defeat'):
        x = decode(r(n))
        f = int(0.6 * 44100)
        x[-f:] *= np.linspace(1, 0, f)[:, None]
        encode(x, os.path.join(MUSIC, n + '.ogg'), lufs=-15)
    for n in ['nvg_on', 'nvg_off', 'glass_crack', 'glass_shatter', 'door_breach0', 'door_breach1', 'door_breach2'] + [f'scream{i}' for i in range(len(SCREAMS)) if os.path.exists(r(f'scream{i}'))]:
        x = decode(r(n), 1)
        # trim leading silence
        idx = np.argmax(np.abs(x[:, 0]) > 0.01)
        x = x[max(0, idx - 200):]
        f = int(0.08 * 44100)
        x[-f:] *= np.linspace(1, 0, f)[:, None]
        encode(x, os.path.join(SFX, n + '.ogg'), ch=1, q=6, lufs=-14)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'master'
    if cmd == 'generate':
        generate()
    master()

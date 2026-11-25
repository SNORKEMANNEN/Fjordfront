#!/usr/bin/env python3
"""
Update 47 field sounds: plates, casualties, climbing gear, the new grenades and field upgrades.

  python3 tools/audio47_build.py generate   # ElevenLabs sound generation (key injected by the proxy, or ELEVEN_API_KEY)
  python3 tools/audio47_build.py master     # trim, fade, loudness-normalise into public/assets/sounds/designed

Every prompt is an original description of a sound; no reference to existing games or media.
"""
import json, os, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'tools', 'audio47_raw')
OUT = os.path.join(ROOT, 'public', 'assets', 'sounds', 'designed')

# name: (seconds, prompt, loudness LUFS, loop?)
SFX = {
    'plate_hit': (0.6, 'A rifle bullet striking a ceramic body armour plate inside a nylon vest: a sharp dull crack with a gritty crunch, close, punchy, no reverb', -14, False),
    'plate_break': (1.0, 'A ceramic armour plate shattering from a bullet impact inside a tactical vest: a loud brittle crack, crunching ceramic shards and grit pouring, close up', -13, False),
    'plate_slide': (0.9, 'Sliding a heavy ceramic armour plate into a nylon plate carrier pocket: a firm fabric scrape and a solid seat, then a hand slapping it, foley close up', -16, False),
    'velcro': (0.7, 'A strip of heavy velcro on a military vest ripped open and pressed shut, quick, close foley', -17, False),
    'bodyfall': (0.9, 'A soldier in body armour collapsing onto hard ground: heavy body thump, gear and magazines rattling, a grunt-free foley impact', -15, False),
    'cough': (1.4, 'A man coughing hard and choking in tear gas, rough harsh coughs and a ragged breath, close', -16, False),
    'grapple_fire': (1.0, 'A compressed-gas grappling hook launcher firing: a sharp pneumatic thump and the hiss of a line paying out fast from a spool', -14, False),
    'grapple_reel': (1.4, 'A motorised winch reeling in a taut rope at speed, whirring motor and the line creaking, mechanical', -18, False),
    'wood_break': (1.6, 'A wooden house wall blown apart by a breaching charge: planks splintering and cracking, debris clattering down, dust, heavy and close', -12, False),
    'thermite': (3.0, 'A thermite grenade burning: an intense roaring white-hot hiss with crackling sparks and sputtering molten metal, steady, loopable', -18, True),
    'gas_hiss': (2.5, 'A tear gas canister spewing gas: a strong steady pressurised hiss with a little sputtering, loopable', -20, True),
    'glow_crack': (0.5, 'Snapping a plastic chemical light stick and shaking it, a soft plastic crack and liquid slosh, close', -18, False),
    'sensor_ping': (0.5, 'A small electronic motion sensor detecting movement: a short clean two-tone electronic ping, tactical, not musical', -20, False),
    'door_rattle': (0.8, 'A wooden door wedged shut being shoved hard: the door rattles in its frame and bangs against a metal wedge, close', -16, False),
    'breach_beep': (1.0, 'An explosive breaching charge arming: three short rising electronic beeps, tense, clean, quiet', -20, False),
    'crate_open': (1.0, 'A heavy steel ammunition crate set down on the ground and its metal latches flipped, lid swung open, magazines shifting inside', -16, False),
    'beacon_on': (1.2, 'A tactical radio beacon powering up on a tripod: a short electronic chirp, a low hum rising and a soft beep', -19, False),
    'radar_sweep': (2.2, 'A powerful radar pulse sweeping outward: a deep sub bass whoomp followed by a glassy rising sonar ping that rings and fades, cinematic, clean', -15, False),
    'rappel_zip': (1.2, 'A rope zipping fast through a metal rappel descender, a friction whine and the rope hissing, short', -17, False),
    'ledge_grab': (0.6, 'Gloved hands slamming onto and gripping a concrete ledge, a grunt-free impact with gear rattle', -17, False),
}


def generate():
    os.makedirs(RAW, exist_ok=True)
    for name, (dur, prompt, _l, loop) in SFX.items():
        dst = os.path.join(RAW, name + '.mp3')
        if os.path.exists(dst):
            continue
        body = {'text': prompt, 'duration_seconds': max(0.5, dur), 'prompt_influence': 0.55}
        if loop:
            body['loop'] = True
        req = urllib.request.Request('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', method='POST', data=json.dumps(body).encode(),
                                     headers={'xi-api-key': os.environ.get('ELEVEN_API_KEY', 'proxy-injected'), 'Content-Type': 'application/json'})
        try:
            open(dst, 'wb').write(urllib.request.urlopen(req, timeout=180).read())
            print('eleven', name, flush=True)
        except urllib.error.HTTPError as e:
            print('fail', name, e.code, e.read()[:300], flush=True)


def master():
    os.makedirs(OUT, exist_ok=True)
    for name, (_d, _p, lufs, loop) in SFX.items():
        src = os.path.join(RAW, name + '.mp3')
        if not os.path.exists(src):
            continue
        dst = os.path.join(OUT, name + '.ogg')
        flt = f'loudnorm=I={lufs}:TP=-1.5:LRA=9'
        if not loop:
            flt = 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-55dB,afade=t=in:d=0.02,areverse,' + flt
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-af', flt, '-ar', '44100', '-c:a', 'libvorbis', '-q:a', '5', dst], check=True)
        print('master', name, flush=True)


if __name__ == '__main__':
    {'generate': generate, 'master': master}[sys.argv[1] if len(sys.argv) > 1 else 'generate']()

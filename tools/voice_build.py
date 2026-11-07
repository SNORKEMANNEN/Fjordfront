#!/usr/bin/env python3
"""
Generate the voice callouts with the ElevenLabs text-to-speech API.

  ELEVEN_API_KEY=... python3 tools/voice_build.py            # (or a proxy that injects xi-api-key)

Writes public/assets/sounds/voice/<speaker>_<line>.ogg and manifest.json:
  { "bot0a": { "reload": ["bot0a_reload.ogg", ...], ... }, "ann": {...} }

Speakers: two soldier voices per team for bot chatter, the player, one radio announcer (HQ) for
flag / match status, the attack helicopter pilot and the recon / fire-support operator. Lines already present on disk are skipped, so re-running only fills gaps (and spends no
characters twice). Audio is trimmed of silence and loudness-normalised with ffmpeg.

Voices generated with ElevenLabs (https://elevenlabs.io). On the free tier ElevenLabs requires
attribution and non-commercial use; see README.
"""
import json, os, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'assets', 'sounds', 'voice')
KEY = os.environ.get('ELEVEN_API_KEY', 'proxy-injected')

SPEAKERS = {
    # team 0 (Kystjegerne, the player's team). Premade voices only: the free tier cannot use
    # community-library voices through the API.
    'bot0a': 'IKne3meq5aSn9XLyUdCD',  # Charlie - deep, energetic
    'bot0b': 'N2lVS1w4EtoT3dr4eOWO',  # Callum - husky
    # team 1 (Nordfront)
    'bot1a': 'SOYHLrjzK2X1ezoPC6cr',  # Harry - fierce
    'bot1b': 'pNInz6obpgDQGcFmaJgB',  # Adam - firm
    # the player's own callouts (a voice no bot uses)
    'player': 'iP95p4xoKVk53GoZ742B',  # Chris - down-to-earth
    # radio announcer for the player's team
    'ann': 'onwK4e9ZLuTAKqWW03F9',    # Daniel - steady broadcaster
    # killstreak crews: the attack helicopter pilot and the recon / fire-support operator
    'pilot': 'pqHfZKP75CvOlQylNhV4',  # Bill - crisp
    'ops': 'Xb7hH8MSUJpSbSDYk0k2',    # Alice - clear, professional
}

BOT_LINES = {
    'reload': ['Reloading!', 'Changing mags, cover me!'],
    'frag': ['Frag out!', 'Grenade out!'],
    'grenade': ['Grenade! Get down!', 'Grenade!'],
    'flash': ['Flashbang out!'],
    'smoke': ['Smoke out!'],
    'stun': ['Stun out!'],
    'contact': ['Contact! Enemy spotted!', 'Contact front!'],
    'taking': ['Taking fire!'],
    'mandown': ['Man down!'],
    'kill': ['Got one!', 'Enemy down!'],
    'hurt': ["I'm hit!"],
    'capA': ['Capturing Alpha!'],
    'capB': ['Capturing Bravo!'],
    'capC': ['Capturing Charlie!'],
    'breach': ['Breaching!'],
    'clear': ['Clear!'],
    'blind': ["I'm blind!"],
}

PLAYER_LINES = {
    'reload': ['Reloading!', 'Swapping mags!'],
    'frag': ['Frag out!', 'Frag, frag!'],
    'flash': ['Flashbang!'],
    'smoke': ['Popping smoke!'],
    'stun': ['Stun out!'],
    'stim': ['Stimming up.'],
    'kill': ['Got him!', 'Tango down.', "He's down."],
    'multi': ['Two down!'],
    'headshot': ['Headshot!'],
    'uav': ['UAV up. Eyes in the sky.'],
    'mortar': ['Mortars on my mark!'],
    'heli': ["Bird's in the air!"],
    'capture': ['Taking the flag!'],
    'hurt': ["I'm hit!"],
    'lowAmmo': ['Running low!'],
    'breach': ['Breaching!'],
    'supply': ['Grabbing supplies.'],
    'nvg': ['Goggles on.', 'Going dark.'],
    # pings: an enemy under the crosshair, or a spot in the world
    'pingEnemy': ['Enemy spotted!', 'Contact, right there!', "Enemy, there! I've got eyes on him."],
    'pingSpot': ['Over here.', 'Check that spot.', 'Look there.'],
    'knifeKill': ['Quiet.', 'Shh.'],
}

ANN_LINES = {
    'start': ['Domination. Capture and hold the flags.'],
    'secA': ['Alpha secured.'], 'secB': ['Bravo secured.'], 'secC': ['Charlie secured.'],
    'lostA': ["We've lost Alpha."], 'lostB': ["We've lost Bravo."], 'lostC': ["We've lost Charlie."],
    'losingA': ["We're losing Alpha!"], 'losingB': ["We're losing Bravo!"], 'losingC': ["We're losing Charlie!"],
    'uav': ['UAV online.'], 'uavEnemy': ['Enemy UAV spotted.'],
    'mortar': ['Mortar strike inbound.'], 'mortarEnemy': ['Enemy mortar inbound! Take cover!'],
    'heli': ['Friendly attack helicopter inbound.'], 'heliEnemy': ['Enemy attack helicopter inbound!'],
    'heliDown': ['Enemy helicopter down.'], 'heliLost': ['Our helicopter is down.'],
    'minute': ['One minute remaining.'],
    'win': ['Mission accomplished. Well done.'], 'lose': ['Mission failed. We will regroup.'],
    # context-aware HQ
    'closeWin': ["We're close to winning. Keep pushing!", 'Victory is within reach. Hold those flags!'],
    'closeLose': ["We're about to lose this. Get on those flags, now!", "The enemy is close to winning. Take back the flags!"],
    'contestA': ['Alpha is contested!'], 'contestB': ['Bravo is contested!'], 'contestC': ['Charlie is contested!'],
    'comeback': ["We're making a comeback. Keep it up!", "We're closing the gap. Don't let up!"],
    'leadTaken': ["We've taken the lead."], 'leadLost': ["We've lost the lead."],
    'allFlags': ['We control all three flags. Hold them!'], 'enemyAll': ['The enemy holds every flag. We need to break through!'],
    'tied': ['Scores are tied. Every flag counts.'],
    'thirty': ['Thirty seconds remaining!'],
    'nightOps': ["It's pitch black out there. Get your night vision goggles on.", 'Night operation. Goggles down and stay sharp.'],
    'nodsReminder': ['Use your night vision. You are blind out there.'],
    # mid-match weather
    'fogIn': ["Heads up, fog is rolling in off the fjord. Visibility is dropping fast.", 'Fog bank moving in. Expect close contacts.'],
    'snowIn': ['Snowstorm moving in. Whiteout conditions in one minute.', "Storm's hitting the valley. You won't see far, use your ears."],
    'weatherClear': ['Weather is clearing. Long sightlines are back, watch the ridges.'],
}

PILOT_LINES = {
    'heliIn': ['Valkyrie one-one on station. Marking targets.', "Gunship on station. I'm overhead, call it."],
    'engage': ['Engaging! Rounds on target.', 'Eyes on hostiles. Engaging.', 'Tally on the enemy. Cleared hot.'],
    'kill': ['Target down. Good effect on target.', 'Splash one. Moving to the next target.'],
    'hit': ["Taking fire! We're hit!", 'Ground fire! Breaking left!'],
    'down': ["Mayday, mayday! Valkyrie is going down!"],
    'leave': ['Bingo fuel. Valkyrie is heading home.', 'Winchester on ammo. Returning to base.'],
}

OPS_LINES = {
    'uavUp': ['UAV is online. Enemy positions coming to you now.', "Recon drone overhead. You've got eyes on the enemy."],
    'uavEnd': ['UAV is going offline.'],
    'uavEnemy': ['Heads up, enemy drone overhead. They can see you.'],
    'mortarCall': ['Fire mission received. Standing by for your mark.'],
    'mortarShot': ['Shot, over. Rounds inbound, keep your heads down.'],
    'mortarDone': ['Fire mission complete.'],
}


RADIO = ('ann', 'pilot', 'ops')


def lines_for(spk):
    return {'ann': ANN_LINES, 'player': PLAYER_LINES, 'pilot': PILOT_LINES, 'ops': OPS_LINES}.get(spk, BOT_LINES)


def tts(voice: str, text: str, announcer: bool) -> bytes:
    body = {
        'text': text,
        'model_id': 'eleven_multilingual_v2',
        'voice_settings': {'stability': 0.55 if announcer else 0.3, 'similarity_boost': 0.8, 'style': 0.15 if announcer else 0.55, 'use_speaker_boost': True},
    }
    req = urllib.request.Request(
        f'https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128',
        data=json.dumps(body).encode(), method='POST',
        headers={'xi-api-key': KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors='replace')[:300]
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(2 ** (attempt + 1))
                continue
            raise RuntimeError(f'{e.code} {msg}')
    raise RuntimeError('unreachable')


def to_ogg(mp3: bytes, dst: str, spk: str):
    # trim leading/trailing silence, normalise loudness; radio voices get a band-pass (the pilot a
    # narrower, crunchier helmet-mic band with a touch of clipping)
    flt = 'silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.15,loudnorm=I=-16:TP=-1.5:LRA=7'
    if spk == 'pilot':
        flt = 'highpass=f=420,lowpass=f=3300,acompressor=threshold=-22dB:ratio=6,volume=3,alimiter=limit=0.6,' + flt
    elif spk in RADIO:
        flt = 'highpass=f=280,lowpass=f=4200,acompressor=threshold=-18dB:ratio=4,' + flt
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', 'pipe:0', '-af', flt, '-ac', '1', '-ar', '44100', '-c:a', 'libvorbis', '-q:a', '5', dst], input=mp3, check=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    man_path = os.path.join(OUT, 'manifest.json')
    manifest = json.load(open(man_path)) if os.path.exists(man_path) else {}
    chars = 0
    for spk, voice in SPEAKERS.items():
        lines = lines_for(spk)
        for key, texts in lines.items():
            for i, text in enumerate(texts):
                name = f'{spk}_{key}{i}.ogg'
                dst = os.path.join(OUT, name)
                lst = manifest.setdefault(spk, {}).setdefault(key, [])
                if os.path.exists(dst):
                    if name not in lst:
                        lst.append(name)
                    continue
                print(f'{spk:6} {key:10} {text}', flush=True)
                to_ogg(tts(voice, text, spk in RADIO), dst, spk)
                chars += len(text)
                if name not in lst:
                    lst.append(name)
                json.dump(manifest, open(man_path, 'w'), indent=1)
    json.dump(manifest, open(man_path, 'w'), indent=1)
    # the spoken text for every file, for subtitles
    texts = {}
    for spk in SPEAKERS:
        for key, tl in lines_for(spk).items():
            for i, t in enumerate(tl):
                texts[f'{spk}_{key}{i}.ogg'] = t
    json.dump(texts, open(os.path.join(OUT, 'lines.json'), 'w'), indent=1)
    print('characters used this run:', chars)


if __name__ == '__main__':
    sys.exit(main())

"""
Equipment sound bank (Update 31): every grenade, explosive, gadget and stim sound is cut from real
recordings (CC0 / CC BY, see README "Assets and licensing"), layered, filtered and normalised here.

  python3 -I tools/eq_sfx_build.py <raw dir>    ->  public/assets/sounds/equipment/*.ogg + manifest.json

<raw dir> holds the downloaded source files under their original names (sources and licences are
listed in SOURCES below and in the README). Each bank key gets one or more variants; each variant is
a list of layers: (file, start s, length s, ffmpeg filter chain, gain dB, offset s).
"""
import json, os, subprocess, sys
import numpy as np

SR = 48000
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'sounds', 'equipment')

# key -> (variants, options)   variant = [layer...]; layer = (file, start, length, af, gain_db, at)
L = lambda f, s=0.0, n=None, af='', g=0.0, at=0.0: (f, s, n, af, g, at)
CGEFFEX = 'grenade-pin.ogg'
BANK = {
    # ---- grenade handling ----
    'pin': ([
        [L(CGEFFEX, 0.30, 0.50, 'highpass=f=250'), L('OBJKey_KeyDrop_OS_01.ogg', 0, 0.22, 'highpass=f=2500', -17, 0.13)],
        [L(CGEFFEX, 1.36, 0.58, 'highpass=f=250'), L('OBJKey_KeyDrop_OS_01.ogg', 0.02, 0.2, 'highpass=f=2500', -19, 0.12)],
    ], {}),
    'spoon': ([
        [L('FOODTware_SpoonDrop_OS_01.ogg', 0, 0.42, 'highpass=f=600'), L('67605__qubodup__metal_click_17.flac', 0, 0.18, 'highpass=f=900', -7)],
        [L('FOODTware_SpoonDrop_OS_01.ogg', 0, 0.42, 'highpass=f=600,asetrate=53760,aresample=48000'), L('67597__qubodup__metal_click_1.flac', 0, 0.08, '', -5)],
    ], {}),
    'swish': ([
        [L('SWSH_Swoosh_OS_03.ogg', 0.03, 0.4, 'highpass=f=180')],
        [L('SWSH_Swoosh_OS_05.ogg', 0.03, 0.42, 'highpass=f=180')],
        [L('melee-whoosh-1.ogg', 0, 0.42, 'highpass=f=220')],
    ], {}),
    'swishLight': ([
        [L('SWSH_Swoosh_OS_01.ogg', 0.0, 0.32, 'highpass=f=300')],
        [L('WHSH_WhooshMedium_OS_01.ogg', 0.0, 0.22, 'highpass=f=300,asetrate=52800,aresample=48000')],
    ], {}),
    'effort': ([
        [L('VOXEfrt_Male01Effort_OS_01.ogg', 0, 0.3)],
        [L('VOXEfrt_Male02Effort_OS_01.ogg', 0, 0.22)],
    ], {'peak': -4}),
    # a burning fuse (sparkler): loops while a grenade cooks; the game raises its rate and level
    'fuse': ([[L('tnt_ignite.ogg', 0.8, 2.2, 'highpass=f=500')]], {'loop': 0.25}),
    'fuseLight': ([[L('tnt_ignite.ogg', 0.0, 0.7, 'highpass=f=300')]], {}),
    # ---- bounces by surface ----
    'bounce_hard': ([
        [L('bfh1_metal_hit_04.ogg', 0, 0.2, 'lowpass=f=9000')],
        [L('bfh1_metal_hit_05.ogg', 0, 0.22, 'lowpass=f=9000')],
        [L('bfh1_metal_hit_06.ogg', 0, 0.2, 'lowpass=f=9000')],
    ], {}),
    'bounce_metal': ([
        [L('METLImpt_MetalHitSurface_OS_01.ogg', 0, 0.42)],
        [L('METLImpt_MetalObjDrop_OS_01.ogg', 0, 0.34)],
        [L('METLImpt_MetalHitSurface_OS_03.ogg', 0, 0.5)],
    ], {}),
    'bounce_wood': ([
        [L('sfx100v2_wood_hit_01.ogg', 0, 0.2), L('bfh1_metal_hit_05.ogg', 0, 0.14, 'lowpass=f=5000', -11)],
        [L('sfx100v2_wood_hit_02.ogg', 0, 0.2), L('bfh1_metal_hit_04.ogg', 0, 0.14, 'lowpass=f=5000', -11)],
    ], {}),
    'bounce_soft': ([
        [L('Footsteps_Snow_Jump_Land_01.wav', 0, 0.24), L('bfh1_metal_hit_05.ogg', 0, 0.12, 'lowpass=f=2500', -13)],
        [L('Footsteps_Grass_Jump_Land_02.wav', 0, 0.22), L('bfh1_metal_hit_04.ogg', 0, 0.12, 'lowpass=f=2500', -13)],
    ], {}),
    'bounce_gravel': ([
        [L('Footsteps_Jump_Land_01.wav', 0, 0.3), L('bfh1_metal_hit_06.ogg', 0, 0.12, 'lowpass=f=6000', -9)],
    ], {}),
    'bounce_mud': ([
        [L('Footsteps_Mud_Jump_Land_01.wav', 0, 0.26, 'lowpass=f=3000')],
        [L('Footsteps_DirtyGround_Jump_Land_02.wav', 0, 0.18, 'lowpass=f=3000')],
    ], {}),
    'bounce_can': ([
        [L('METLImpt_CanDrop_OS_01.ogg', 0, 0.3)],
        [L('PLASImpt_PlasticObjDrop_OS_01.ogg', 0, 0.26), L('METLImpt_CanDrop_OS_01.ogg', 0, 0.12, '', -8)],
    ], {}),
    'roll': ([[L('METLImpt_CanDrop_OS_01.ogg', 0.12, 0.9, 'lowpass=f=5000')]], {}),
    'splash': ([
        [L('splash_02.ogg', 0, 0.5)],
        [L('splash_03.ogg', 0, 0.4)],
        [L('splash_06.ogg', 0, 0.36)],
    ], {}),
    # ---- explosions ----
    # near: real explosion takes, each with a sub-bass shockwave layer under it
    'explosion': ([
        [L('exp_near.ogg', 0.0, 2.8, 'highpass=f=30'), L('shockwave.ogg', 0.07, 1.3, 'lowpass=f=150', -9)],
        [L('exp_near.ogg', 3.44, 1.95, 'highpass=f=30'), L('shockwave.ogg', 0.07, 1.3, 'lowpass=f=150', -8)],
        [L('exp_near.ogg', 6.55, 1.85, 'highpass=f=30'), L('shockwave.ogg', 0.07, 1.3, 'lowpass=f=150', -8)],
        [L('855893__qubodup__blast.flac', 0.0, 1.75, 'highpass=f=30'), L('shockwave.ogg', 0.07, 1.3, 'lowpass=f=150', -10)],
        [L('explosion-big.ogg', 0.0, 2.3, 'highpass=f=30')],
    ], {'peak': -0.5}),
    # the sharp crack you hear on top when it goes off close by
    'explosionCrack': ([
        [L('855893__qubodup__blast.flac', 0.0, 0.3, 'highpass=f=900')],
        [L('exp_near.ogg', 0.0, 0.3, 'highpass=f=900')],
    ], {'peak': -1}),
    # far: a distant rumble and roll
    'explosionFar': ([
        [L('exp_far.ogg', 0.0, 2.4, 'lowpass=f=2200')],
        [L('exp_far.ogg', 5.56, 2.8, 'lowpass=f=2200')],
        [L('explosion_huge_1.ogg', 0.15, 4.2, 'lowpass=f=1300')],
    ], {'peak': -1.5}),
    'explosionWater': ([
        [L('water_mine_explosion.ogg', 0, 1.1), L('splash_04.ogg', 0, 0.8, '', -6, 0.55)],
    ], {'peak': -0.8}),
    'debris': ([
        [L('bfh1_rock_falling_01.ogg', 0, 0.9), L('bfh1_rock_falling_07.ogg', 0, 0.35, '', -3, 0.18), L('collapse_1.ogg', 0.3, 1.5, 'lowpass=f=5000', -10, 0.25)],
        [L('bfh1_rock_falling_03.ogg', 0.05, 0.8), L('bfh1_rock_falling_08.ogg', 0, 0.38, '', -3, 0.22), L('collapse_0.ogg', 0.8, 1.5, 'lowpass=f=5000', -10, 0.3)],
        [L('bfh1_wood_hit_02.ogg', 0, 0.25), L('bfh1_rock_falling_05.ogg', 0, 0.5, '', -2, 0.1), L('bfh1_wood_hit_03.ogg', 0, 0.3, '', -4, 0.33)],
    ], {}),
    # ---- tacticals ----
    'flashBang': ([
        [L('grenade-flashbang.ogg', 0, 1.0), L('855893__qubodup__blast.flac', 0, 0.5, 'highpass=f=1500', -9)],
        [L('grenade-flashbang.ogg', 0, 1.0, 'asetrate=45600,aresample=48000'), L('exp_near.ogg', 0, 0.4, 'highpass=f=1500', -10)],
    ], {'peak': -0.5}),
    'stunBang': ([
        [L('mine_explosion.ogg', 0, 1.15, 'lowpass=f=2400'), L('shockwave.ogg', 0.07, 1.2, 'lowpass=f=300', -5)],
        [L('855893__qubodup__blast.flac', 0, 1.5, 'lowpass=f=1800'), L('shockwave.ogg', 0.07, 1.2, 'lowpass=f=300', -5)],
    ], {'peak': -0.8}),
    'smokePop': ([
        [L('METLImpt_CanDrop_OS_01.ogg', 0, 0.14), L('Nasal_Spray.wav', 0.02, 0.3, 'highpass=f=600', -2, 0.03)],
    ], {'peak': -3}),
    # long steam/flare hiss, looped by the game and faded over the cloud's life
    'smokeHiss': ([[L('grenade-smoke.ogg', 0.6, 1.8, 'highpass=f=250'), L('tnt_gunpowder_burning.ogg', 0, 1.0, 'highpass=f=400', -6)]], {'loop': 0.35}),
    'gasHiss': ([[L('grenade-gas.ogg', 1.0, 3.0)]], {'loop': 0.4}),
    'twist': ([
        [L('MECHLvr_LeverPull_OS_03.ogg', 0.0, 0.6, 'highpass=f=400,asetrate=57600,aresample=48000')],
        [L('MECHLvr_LeverPull_OS_01.ogg', 0.14, 0.7, 'highpass=f=400,asetrate=55200,aresample=48000')],
    ], {}),
    'snapPulse': ([[L('shockwave.ogg', 0.05, 1.2, 'highpass=f=180,asetrate=62400,aresample=48000'), L('67619__qubodup__radio_beep_1.flac', 0, 0.12, '', -8)]], {}),
    # ---- stim ----
    'stimCap': ([[L('MECHSwtch_SwitchSmallOff_OS_01.ogg', 0, 0.2), L('PLASImpt_PlasticObjDrop_OS_01.ogg', 0, 0.06, 'highpass=f=1200,asetrate=67200,aresample=48000', -4)]], {}),
    'stimInject': ([[L('Nasal_Spray.wav', 0.02, 0.12, 'highpass=f=800', -2), L('Footsteps_DirtyGround_Jump_Land_02.wav', 0, 0.1, 'lowpass=f=1500', -6)]], {}),
    'stimHiss': ([[L('MACHInd_Hydraulic_OS_01.ogg', 2.86, 1.0, 'highpass=f=350'), L('Nasal_Spray.wav', 0.03, 0.3, 'highpass=f=1500', -7)]], {}),
    'injectorToss': ([[L('PLASImpt_PlasticBottleDrop_OS_01.ogg', 0, 0.6)]], {}),
    'heartbeat': ([[L('heartbeat.ogg', 0, 0.62, 'lowpass=f=2000')]], {}),
    # flash / stun ear ring: the pure tone isolated from the recording, looped while it fades out
    'tinnitus': ([[L('RingingEars.wav', 2.0, 4.0, 'highpass=f=1500,lowpass=f=6000')]], {'loop': 0.6, 'peak': -6}),
    'panicBreath': ([[L('HMNBrth_MaleBreathing_OS_01.ogg', 0.0, 1.6)]], {}),
    # ---- C4 / sticky / claymore ----
    'stick': ([
        [L('Footsteps_Mud_Jump_Land_01.wav', 0, 0.24, 'highpass=f=150'), L('67608__qubodup__metal_click_4.flac', 0, 0.05, '', -7, 0.01)],
        [L('Footsteps_DirtyGround_Jump_Land_02.wav', 0, 0.18, 'highpass=f=150'), L('67597__qubodup__metal_click_1.flac', 0, 0.06, '', -8, 0.01)],
    ], {}),
    'peel': ([
        [L('Velcro_02.wav', 0.07, 0.5, 'highpass=f=300')],
        [L('Velcro_03.wav', 0.1, 0.42, 'highpass=f=300')],
    ], {}),
    'clack': ([[L('MECHSwtch_SwitchSmallOn_OS_01.ogg', 0, 0.16), L('67620__qubodup__radio_click_1.flac', 0, 0.12, '', -6)]], {}),
    'coverFlip': ([[L('MECHSwtch_SwitchSmallOff_OS_01.ogg', 0, 0.22, 'asetrate=55200,aresample=48000'), L('67608__qubodup__metal_click_4.flac', 0, 0.05, '', -10)]], {}),
    'beep': ([[L('beep_matrixxx.ogg', 0, 0.08)], [L('67619__qubodup__radio_beep_1.flac', 0, 0.11)]], {'peak': -4}),
    'beepLow': ([[L('beep_matrixxx.ogg', 0, 0.08, 'asetrate=28800,aresample=48000')]], {'peak': -4}),
    'armChirp': ([[L('67619__qubodup__radio_beep_1.flac', 0, 0.11), L('67619__qubodup__radio_beep_1.flac', 0, 0.11, 'asetrate=64000,aresample=48000', -2, 0.13)]], {'peak': -4}),
    'claymoreClick': ([[L('67605__qubodup__metal_click_17.flac', 0, 0.19), L('67597__qubodup__metal_click_1.flac', 0, 0.08, '', -3, 0.08)]], {}),
    'legs': ([[L('67608__qubodup__metal_click_4.flac', 0, 0.05), L('67597__qubodup__metal_click_1.flac', 0, 0.08, '', -2, 0.05)]], {}),
    'place': ([
        [L('CLOTHMvmt_MovementWithGear_OS_01.ogg', 0.03, 0.75)],
        [L('CLOTHMvmt_MovementWithGear_OS_02.ogg', 0.05, 0.45)],
    ], {'peak': -4}),
    # ---- trophy ----
    'zap': ([[L('67617__qubodup__metal-crash-collision.flac', 0, 0.45, 'highpass=f=1200'), L('67620__qubodup__radio_click_1.flac', 0, 0.15, 'highpass=f=2000', -4), L('855893__qubodup__blast.flac', 0, 0.12, 'highpass=f=3000', -9)]], {}),
    'servo': ([[L('MACHInd_Hydraulic_OS_01.ogg', 0.0, 1.05, 'highpass=f=200')]], {}),
    'trophyDeploy': ([[L('67617__qubodup__metal-crash-collision.flac', 0, 0.5, 'lowpass=f=2500'), L('CLOTHMvmt_MovementWithGear_OS_02.ogg', 0.05, 0.4, '', -6), L('67605__qubodup__metal_click_17.flac', 0, 0.19, '', -4, 0.16)]], {}),
    # ---- fire ----
    'fireIgnite': ([[L('tnt_ignite.ogg', 0.0, 0.9), L('tnt_gunpowder_burning.ogg', 0, 1.0, 'lowpass=f=3000', -4, 0.1)]], {}),
    # ---- throwing knife ----
    'knifeDraw': ([[L('WEAPKnif_KnifeScrape_OS_01.ogg', 0.03, 0.46, 'highpass=f=500')]], {'peak': -3}),
    'knifeThrow': ([
        [L('melee-whoosh-2.ogg', 0.2, 0.36, 'highpass=f=400,asetrate=57600,aresample=48000')],
        [L('SWSH_Swoosh_OS_05.ogg', 0.04, 0.3, 'highpass=f=400,asetrate=62400,aresample=48000')],
    ], {}),
    'knifeCatch': ([[L('sfx100v2_hit_03.ogg', 0, 0.1, 'highpass=f=300', -2), L('CLOTHMvmt_MovementWithGear_OS_02.ogg', 0.05, 0.16, '', -8)]], {'peak': -6}),
    'knifePickup': ([[L('CLOTHMvmt_MovementWithGear_OS_01.ogg', 0.03, 0.45), L('WEAPKnif_KnifeScrape_OS_01.ogg', 0.05, 0.3, 'highpass=f=600', -5, 0.28)]], {'peak': -3}),
}


def load(path, start, length, af):
    # seek after -i (input seeking returns nothing for some short FLACs); resample first so the
    # asetrate pitch shifts in the chains are relative to 48 kHz
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-ss', f'{start:.4f}']
    if length: cmd += ['-t', f'{length:.4f}']
    cmd += ['-ac', '1', '-af', 'aresample=48000' + (',' + af if af else ''), '-ar', str(SR)]
    cmd += ['-f', 'f32le', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def fade(y, a=0.002, b=0.04):
    na, nb = min(len(y) // 4, int(a * SR)), min(len(y) // 3, int(b * SR))
    if na > 1: y[:na] *= np.linspace(0, 1, na)
    if nb > 1: y[-nb:] *= np.linspace(1, 0, nb) ** 2
    return y


def render(layers, raw):
    parts = []
    for f, s, n, af, g, at in layers:
        y = fade(load(os.path.join(raw, f), s, n, af))
        y /= np.abs(y).max() + 1e-9  # each layer normalised, then set by its gain
        parts.append((int(at * SR), y * 10 ** (g / 20)))
    n = max(o + len(y) for o, y in parts)
    out = np.zeros(n, np.float32)
    for o, y in parts: out[o:o + len(y)] += y
    return out


def make_loop(y, xf):
    """seamless loop: crossfade the last xf seconds into the start"""
    n = int(xf * SR)
    if len(y) < 3 * n: return y
    head, tail = y[:n].copy(), y[-n:].copy()
    w = np.linspace(0, 1, n)
    body = y[n:-n].copy()
    joint = tail * np.cos(w * np.pi / 2) + head * np.sin(w * np.pi / 2)
    return np.concatenate([body, joint]).astype(np.float32)


def save(y, out, peak_db):
    y = y * (10 ** (peak_db / 20) / (np.abs(y).max() + 1e-9))
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-c:a', 'libvorbis', '-q:a', '5', out], input=y.astype(np.float32).tobytes(), check=True)


def main(raw):
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith('.ogg'): os.remove(os.path.join(OUT, f))
    man = {}
    for key, (variants, opt) in BANK.items():
        for i, layers in enumerate(variants):
            y = render(layers, raw)
            if opt.get('loop'): y = make_loop(y, opt['loop'])
            else: y = fade(y, 0.001, 0.03)
            name = f'{key}_{i}.ogg'
            save(y, os.path.join(OUT, name), opt.get('peak', -1.0))
            man.setdefault(key, []).append({'file': name, 'loop': bool(opt.get('loop'))})
            print(f'{name}: {len(y) / SR:.2f}s')
    with open(os.path.join(OUT, 'manifest.json'), 'w') as fh:
        json.dump(man, fh, indent=1)
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f'{sum(len(v) for v in man.values())} files, {total / 1024:.0f} KB')


if __name__ == '__main__':
    main(sys.argv[1])

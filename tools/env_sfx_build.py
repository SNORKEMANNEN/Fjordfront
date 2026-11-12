"""
Brosund ambience bank (Update 34): waterfalls, streams, tunnel drips, the pump room and the tunnel
fans, cut from real CC0 recordings (rubberduck "40 CC0 water / splash / slime SFX" and "100 CC0
SFX #2", OpenGameArt — see README "Assets and licensing").

  python3 -I tools/env_sfx_build.py <raw dir>   ->  public/assets/sounds/ambience/*.ogg + manifest.json

<raw dir> holds the source files under their original names. Uses the same layer renderer as
tools/eq_sfx_build.py: (file, start s, length s, ffmpeg filter chain, gain dB, offset s).
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eq_sfx_build as E

E.OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'sounds', 'ambience')
L = E.L
W1, W2, W3 = 'sfx100v2_loop_water_01.ogg', 'sfx100v2_loop_water_02.ogg', 'loop_water_02.ogg'
E.BANK = {
    # a big fall: the steady water loops layered with a slowed, low-passed copy for the body of the roar
    'wf_big': ([
        [L(W1, 0, 6.2, ''), L(W3, 0, 6.2, 'highpass=f=300', -3), L(W1, 0, 6.2, 'asetrate=28800,aresample=48000,lowpass=f=900', -1)],
    ], {'loop': 0.8, 'peak': -2.0}),
    # a stream down a cliff: brighter, thinner
    'wf_stream': ([
        [L(W3, 0, 6.8, 'highpass=f=500'), L(W2, 0, 6.8, 'highpass=f=700', -6)],
    ], {'loop': 0.7, 'peak': -3.0}),
    # water dripping from the tunnel roof into puddles: short bubble plinks, pitched up
    'drip': ([
        [L('bubble_03.ogg', 0.0, 0.22, 'highpass=f=900')],
        [L('bubble_01.ogg', 0.0, 0.25, 'asetrate=67200,aresample=48000,highpass=f=1200')],
        [L('bubble_02.ogg', 0.0, 0.2, 'asetrate=86400,aresample=48000,highpass=f=1500')],
        [L('bubble_03.ogg', 0.05, 0.18, 'asetrate=57600,aresample=48000,highpass=f=1000')],
    ], {'peak': -4.0}),
    # the pump room: a machine loop, slowed into a hum
    'pump': ([
        [L('sfx100v2_loop_machine_01.ogg', 0, 7.4, 'asetrate=36000,aresample=48000,lowpass=f=1800')],
    ], {'loop': 0.6, 'peak': -4.0}),
    # jet fans in the crown: a low ambient rumble
    'tfan': ([
        [L('sfx100v2_loop_ambient_03.ogg', 0, 3.4, 'lowpass=f=900'), L('sfx100v2_loop_machine_04.ogg', 0, 3.4, 'asetrate=24000,aresample=48000,lowpass=f=500', -9)],
    ], {'loop': 0.5, 'peak': -4.0}),
}

if __name__ == '__main__':
    E.main(sys.argv[1])

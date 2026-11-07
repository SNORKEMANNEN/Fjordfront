import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from sfx_extract import load, events, cut, save, SR
LIB = '/home/user/buddingmonkey/freefirearmssfxlibrary'
OUT = '/home/user/fjordfront/public/assets/sounds/firearms'
os.makedirs(OUT, exist_ok=True)
P = lambda g, f: f'{LIB}/Prepared SFX/{g}/{f}.wav'
M = lambda g, f: f'{LIB}/Master Tracks/{g}/{f}.wav'
# key -> (source, kind, max takes, max length, tail dB, peak dB)
jobs = {
  'shot@k416':  (P('AR-15', 'D_32P'), 'shot', 3, 1.5, -48, -5),
  'far@k416':   (P('AR-15', 'D_24P'), 'shot', 2, 2.2, -45, -5),
  'shot@mp7':   (P('Carl Gustav M45', 'G_31P'), 'shot', 3, 1.2, -48, -5),
  'far@mp7':    (P('Carl Gustav M45', 'G_20P'), 'shot', 2, 2.0, -45, -5),
  'shot@pump12':(P('Nova', 'O_21P'), 'shot', 2, 1.8, -48, -5),
  'far@pump12': (P('Nova', 'O_17P'), 'shot', 2, 2.4, -45, -5),
  'shot@skv338':(P('Tikka', 'W_29P'), 'shot', 2, 2.2, -48, -5),
  'far@skv338': (P('Tikka', 'W_24P'), 'shot', 2, 2.8, -45, -5),
  'shot@p80':   (P('Walther PPQ', 'X_39P'), 'shot', 3, 1.2, -48, -5),
  'far@p80':    (P('Walther PPQ', 'X_31P'), 'shot', 2, 2.0, -45, -5),
  # handling
  'magOut@k416': (M('AR-15', 'D_5'), 'mech', 1, 0.6, -46, -4),
  'magIn@k416':  (M('AR-15', 'D_4'), 'mech', 1, 0.6, -46, -4),
  'boltRelease@k416': (M('AR-15', 'D_13'), 'mech', 1, 0.5, -46, -4),
  'boltBack@k416': (M('AR-15', 'D_9'), 'mech', 1, 0.6, -46, -4),
  'dry@k416':    (M('AR-15', 'D_16'), 'mech', 1, 0.35, -46, -5),
  'magOut@mp7':  (M('Carl Gustav M45_Swedish K', 'G_9'), 'mech', 1, 0.6, -46, -4),
  'magIn@mp7':   (M('Carl Gustav M45_Swedish K', 'G_8'), 'mech', 1, 0.6, -46, -4),
  'boltRelease@mp7': (M('Carl Gustav M45_Swedish K', 'G_10'), 'mech', 1, 0.5, -46, -4),
  'dry@mp7':     (M('Carl Gustav M45_Swedish K', 'G_3'), 'mech', 1, 0.35, -46, -5),
  'pumpBack@pump12': (M('Nova', 'O_4'), 'mech', 1, 0.45, -46, -4),
  'pumpForward@pump12': (M('Nova', 'O_5'), 'mech', 1, 0.45, -46, -4),
  'shellIn@pump12': (M('Nova', 'O_7'), 'mech', 2, 0.45, -46, -4),
  'dry@pump12':  (M('Nova', 'O_8'), 'mech', 1, 0.35, -46, -5),
  'boltOpen@skv338': (M('Tikka', 'W_6'), 'mech', 1, 0.4, -46, -4),
  'boltBack@skv338': (M('Tikka', 'W_9'), 'mech', 1, 0.5, -46, -4),
  'boltClose@skv338': (M('Tikka', 'W_12'), 'mech', 1, 0.5, -46, -4),
  'magOut@skv338': (M('Tikka', 'W_5'), 'mech', 1, 0.5, -46, -4),
  'magIn@skv338':  (M('Tikka', 'W_4'), 'mech', 1, 0.5, -46, -4),
  'dry@skv338':  (M('Tikka', 'W_13'), 'mech', 1, 0.35, -46, -5),
  'magOut@p80':  (M('Walther PPQ', 'X_5'), 'mech', 1, 0.5, -46, -4),
  'magIn@p80':   (M('Walther PPQ', 'X_4'), 'mech', 1, 0.5, -46, -4),
  'slideBack@p80': (M('Walther PPQ', 'X_7'), 'mech', 1, 0.45, -46, -4),
  'slideRelease@p80': (M('Walther PPQ', 'X_17'), 'mech', 1, 0.45, -46, -4),
  'dry@p80':     (M('Walther PPQ', 'X_18'), 'mech', 1, 0.35, -46, -5),
  # revolver (Smith & Wesson 642 recordings): shots + the full cylinder handling set
  'shot@rv357':  (P('Smith & Wesson 642', 'V_27P'), 'shot', 3, 1.4, -48, -5),
  'far@rv357':   (P('Smith & Wesson 642', 'V_22P'), 'shot', 2, 2.2, -45, -5),
  'cylOpen@rv357':  (M('Smith & Wesson 642', 'V_11'), 'mech', 1, 0.5, -46, -4),
  'cylClose@rv357': (M('Smith & Wesson 642', 'V_12'), 'mech', 1, 0.5, -46, -4),
  'cylFlipOpen@rv357':  (M('Smith & Wesson 642', 'V_9'), 'mech', 1, 0.5, -46, -4),
  'cylFlipClose@rv357': (M('Smith & Wesson 642', 'V_15'), 'mech', 1, 0.5, -46, -4),
  'eject@rv357':  (M('Smith & Wesson 642', 'V_3'), 'mech', 2, 0.9, -48, -4),
  'insert@rv357': (M('Smith & Wesson 642', 'V_18'), 'mech', 2, 0.7, -48, -4),
  'shellIn@rv357': (M('Smith & Wesson 642', 'V_2'), 'mech', 2, 0.4, -46, -4),
  'spin@rv357':   (M('Smith & Wesson 642', 'V_19'), 'mech', 1, 1.2, -50, -5),
  'hammer@rv357': (M('Smith & Wesson 642', 'V_6'), 'mech', 2, 0.3, -46, -6),
  'hammerFall@rv357': (M('Smith & Wesson 642', 'V_8'), 'mech', 1, 0.3, -46, -5),
  'dry@rv357':    (M('Smith & Wesson 642', 'V_5'), 'mech', 1, 0.45, -46, -5),
}
manifest = {}
for key, (src, kind, n, maxlen, tail, pk) in jobs.items():
    x = load(src)
    ev, e, peak = events(x, rel_db=-26 if kind == 'shot' else -22, gap=0.35 if kind == 'shot' else 0.12, minlen=0.02 if kind == 'shot' else 0.002)
    starts = sorted(s for s, _, _ in ev)
    pick = ev if kind == 'shot' else sorted(ev, key=lambda t: -t[2])[:n]
    pick = sorted(pick, key=lambda t: t[0])
    out = []
    for (s, t, p) in pick:
        if len(out) >= n: break
        later = [q for q in starts if q > s + int(0.02 * SR)]
        nxt = later[0] if later else None
        y = cut(x, e, s, maxlen, tail_db=tail, nxt=nxt)
        if len(y) < 0.03 * SR: continue
        name = key.replace('@', '__')
        f = f'{name}_{len(out)}.ogg'
        save(y, f'{OUT}/{f}', peak_db=pk)
        out.append({'file': f, 'dur': round(len(y) / SR, 3)})
    manifest[key] = out
    print(key, [o['dur'] for o in out])
json.dump(manifest, open(f'{OUT}/manifest.json', 'w'), indent=1)

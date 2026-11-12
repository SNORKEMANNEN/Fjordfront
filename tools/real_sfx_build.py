"""
Real-recording bank (Update 35): every sound that used to be synthesised in code (tactical-sprint
gear rattle, bullet impacts per material, the LMG bipod, footsteps on gravel / metal / water,
cloth and gear foley, breathing, bullet whiz, the mortar whistle, burning wrecks, interface and
match stings, radio clicks, gulls and songbirds, and the wind / waves / rain / snow-wind / slide /
helicopter loops) is cut from real recordings here (CC0 / CC BY, see README "Assets and licensing").

  python3 -I tools/real_sfx_build.py <raw dir>   ->  public/assets/sounds/real/*.ogg + manifest.json

<raw dir> holds the source files under their original names, with these prefixes for files that
came from collections with generic names:
  tw_*    Tidewater (dgreenheck/tidewater) Freesound CC0 recordings
  ki_*    Kraken Isles (DanWahlin/kraken-isles) Freesound CC0 recordings; ki_if_* Kenney Interface Sounds
  kj_*    Kenney Music Jingles;  krpg_*  Kenney RPG Audio
Layers use the same renderer as tools/eq_sfx_build.py: (file, start s, length s, ffmpeg filter
chain, gain dB, offset s). Everything is trimmed, filtered, layered, pitched and normalised.
"""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eq_sfx_build as E

SR = E.SR
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'sounds', 'real')
L = E.L
P = lambda r: f'asetrate={int(48000 * r)},aresample=48000'  # pitch/speed by r

GEAR = 'CLOTHMvmt_MovementWithGear_OS_0%d.ogg'
CLOTH = 'CLOTHMvmt_ClothingMovement_OS_0%d.ogg'
SHAKE = '67614__qubodup__metal_shaking_1.flac'
WHIZ = 'ki_ball_whiz.ogg'
BREATH = 'HMNBrth_MaleBreathing_OS_01.ogg'

BANK = {
    # ---------------- movement foley ----------------
    # tactical sprint: the kit bouncing as you break into the sprint (straps, buckles, mag pouches)
    'tac': ([
        [L(GEAR % 1, 0.0, 0.8), L(SHAKE, 0.05, 0.42, 'highpass=f=900', -7, 0.04), L('krpg_belt_handle_2.ogg', 0.1, 0.38, 'highpass=f=600', -7, 0.14)],
        [L(GEAR % 3, 0.06, 0.85), L('krpg_handle_coins_2.ogg', 0.0, 0.34, 'highpass=f=1500', -10, 0.06), L(SHAKE, 0.1, 0.38, 'highpass=f=1100', -8, 0.18)],
        [L(GEAR % 4, 0.42, 0.62), L('krpg_belt_handle_1.ogg', 0.0, 0.28, 'highpass=f=500', -5, 0.08), L(SHAKE, 0.0, 0.5, 'highpass=f=900,' + P(0.9), -9, 0.02)],
        [L(GEAR % 2, 0.02, 0.5), L('krpg_cloth_belt.ogg', 0.04, 0.5, 'highpass=f=400', -4, 0.0), L(SHAKE, 0.15, 0.35, 'highpass=f=1200,' + P(1.12), -9, 0.1)],
    ], {'peak': -2}),
    'cloth': ([
        [L(CLOTH % 1, 0.05, 0.45, 'highpass=f=200')],
        [L(CLOTH % 2, 0.0, 0.42, 'highpass=f=200')],
        [L(CLOTH % 3, 0.2, 0.45, 'highpass=f=200')],
        [L(CLOTH % 4, 0.1, 0.42, 'highpass=f=200')],
    ], {'peak': -3}),
    'adsIn': ([
        [L(CLOTH % 2, 0.05, 0.24, 'highpass=f=350'), L('krpg_handle_small_leather.ogg', 0.0, 0.2, 'highpass=f=900', -9, 0.05)],
        [L(CLOTH % 4, 0.15, 0.24, 'highpass=f=350'), L('krpg_handle_small_leather_2.ogg', 0.0, 0.2, 'highpass=f=900', -9, 0.04)],
    ], {'peak': -4}),
    'adsOut': ([
        [L(CLOTH % 1, 0.15, 0.2, 'highpass=f=400')],
        [L(CLOTH % 3, 0.35, 0.2, 'highpass=f=400')],
    ], {'peak': -6}),
    'jump': ([
        [L(GEAR % 2, 0.04, 0.4, 'highpass=f=250'), L(CLOTH % 2, 0.0, 0.25, '', -6)],
        [L(GEAR % 1, 0.4, 0.4, 'highpass=f=250'), L(CLOTH % 4, 0.1, 0.25, '', -6)],
    ], {'peak': -3}),
    'land': ([
        [L('FEETHmn_ShoeConcreteLand_OS_01.ogg', 0.0, 0.23), L(GEAR % 3, 0.12, 0.35, 'highpass=f=500', -8, 0.02)],
        [L('FEETHmn_ShoeConcreteLand_OS_02.ogg', 0.0, 0.22), L(GEAR % 1, 0.04, 0.35, 'highpass=f=500', -8, 0.02)],
        [L('FEETHmn_ShoeDirtLand_OS_01.ogg', 0.0, 0.4), L(SHAKE, 0.05, 0.3, 'highpass=f=1200', -12, 0.02)],
    ], {'peak': -1}),
    'mantle': ([
        [L(CLOTH % 3, 0.1, 0.4), L('FEETHmn_ShoeConcreteLand_OS_02.ogg', 0.0, 0.22, '', -4, 0.16), L(GEAR % 2, 0.05, 0.35, 'highpass=f=500', -8, 0.05)],
        [L(CLOTH % 1, 0.0, 0.4), L('FEETHmn_ShoeWoodLand_OS_01.ogg', 0.0, 0.25, '', -5, 0.18), L(GEAR % 4, 0.45, 0.35, 'highpass=f=500', -8, 0.02)],
    ], {'peak': -2}),
    # holding breath on a scope: a deep breath in, and letting it go
    'breathIn': ([[L(BREATH, 1.05, 0.5, 'highpass=f=150')], [L(BREATH, 2.12, 0.5, 'highpass=f=150')]], {'peak': -4}),
    'breathOut': ([[L(BREATH, 0.55, 0.52, 'highpass=f=150')], [L(BREATH, 1.58, 0.5, 'highpass=f=150')]], {'peak': -4}),
    # ---------------- weapon extras ----------------
    # LMG bipod legs snapping out / folding: spring lever, latch, leg tips knocking
    'bipod': ([
        [L('MECHLvr_LeverPull_OS_06.ogg', 0.0, 0.55, 'highpass=f=300'), L('krpg_metal_latch.ogg', 0.0, 0.26, '', -2, 0.01), L('67605__qubodup__metal_click_17.flac', 0.0, 0.16, '', -7, 0.27)],
        [L('MECHLvr_LeverPull_OS_04.ogg', 0.1, 0.55, 'highpass=f=300'), L('krpg_metal_latch.ogg', 0.0, 0.26, P(0.92), -2, 0.04), L('METLImpt_MetalObjDrop_OS_02.ogg', 0.0, 0.2, 'lowpass=f=6000', -12, 0.07)],
        [L('krpg_metal_click.ogg', 0.0, 0.42, 'highpass=f=300'), L('MECHLvr_LeverPull_OS_05.ogg', 0.12, 0.4, 'highpass=f=400', -5, 0.0), L(SHAKE, 0.25, 0.2, 'highpass=f=1500', -14, 0.18)],
    ], {'peak': -2}),
    'lowAmmo': ([
        [L('67597__qubodup__metal_click_1.flac', 0.0, 0.08, 'highpass=f=2500'), L('krpg_handle_coins_2.ogg', 0.05, 0.1, 'highpass=f=3000', -10)],
        [L('67608__qubodup__metal_click_4.flac', 0.0, 0.08, 'highpass=f=2500'), L('krpg_handle_coins_2.ogg', 0.16, 0.1, 'highpass=f=3000', -10)],
    ], {'peak': -3}),
    'click': ([[L('krpg_metal_click.ogg', 0.04, 0.16, 'highpass=f=800')], [L('67597__qubodup__metal_click_1.flac', 0.0, 0.1, 'highpass=f=800')]], {'peak': -3}),
    # a round snapping past: real fly-by whizzes, sped up and brightened into a supersonic crack-zip
    'whiz': ([
        [L(WHIZ, 0.1, 0.5, P(1.6) + ',highpass=f=700')],
        [L(WHIZ, 1.33, 0.4, P(1.5) + ',highpass=f=700')],
        [L(WHIZ, 0.1, 0.5, P(1.9) + ',highpass=f=900'), L('WHSH_WhooshSmall_OS_02.ogg', 0.0, 0.14, P(1.4) + ',highpass=f=1500', -8)],
        [L(WHIZ, 1.33, 0.4, P(1.75) + ',highpass=f=900'), L('WHSH_WhooshSmall_OS_01.ogg', 0.0, 0.18, P(1.3) + ',highpass=f=1500', -8)],
    ], {'peak': -1}),
    # ---------------- bullet impacts ----------------
    # each: a sharp strike + the material's body + debris / spray, all real recordings
    'imp_concrete': ([
        [L('impact_mining_000.ogg', 0.0, 0.22, 'highpass=f=500'), L('bfh1_rock_falling_02.ogg', 0.0, 0.42, 'highpass=f=900', -8, 0.02), L('sfx100v2_stones_01.ogg', 0.0, 0.3, 'highpass=f=1500', -12, 0.05)],
        [L('impact_mining_001.ogg', 0.0, 0.22, 'highpass=f=500'), L('bfh1_rock_falling_03.ogg', 0.04, 0.45, 'highpass=f=900', -9, 0.02), L('ki_rock_tumble.ogg', 0.0, 0.3, 'highpass=f=1800', -14, 0.04)],
        [L('impact_mining_002.ogg', 0.0, 0.22, 'highpass=f=500'), L('bfh1_rock_falling_04.ogg', 0.0, 0.3, 'highpass=f=900', -8, 0.02), L('sfx100v2_stones_02.ogg', 0.0, 0.3, 'highpass=f=1500', -12, 0.05)],
        # with a ricochet whine
        [L('impact_mining_003.ogg', 0.0, 0.22, 'highpass=f=500'), L('bfh1_rock_falling_02.ogg', 0.0, 0.3, 'highpass=f=900', -9, 0.02), L(WHIZ, 1.36, 0.36, P(2.4) + ',highpass=f=1800', -9, 0.03)],
    ], {'peak': -1}),
    'imp_metal': ([
        [L('METLImpt_MetalHitSurface_OS_01.ogg', 0.22, 0.5), L('impact_plate_medium_000.ogg', 0.0, 0.18, 'highpass=f=1500', -6)],
        [L('METLImpt_MetalHitSurface_OS_02.ogg', 0.32, 0.5), L('bfh1_metal_hit_04.ogg', 0.0, 0.25, 'highpass=f=1200', -5)],
        [L('METLImpt_MetalHitSurface_OS_03.ogg', 0.04, 0.5), L('impact_plate_medium_001.ogg', 0.0, 0.18, 'highpass=f=1500', -6), L(WHIZ, 0.12, 0.4, P(2.6) + ',highpass=f=2000', -10, 0.03)],
        [L('METLImpt_MetalHitSurface_OS_04.ogg', 0.5, 0.5), L('bfh1_metal_hit_06.ogg', 0.0, 0.25, 'highpass=f=1200', -5)],
    ], {'peak': -1}),
    'imp_wood': ([
        [L('krpg_chop.ogg', 0.02, 0.22), L('bfh1_wood_hit_01.ogg', 0.0, 0.3, 'highpass=f=300', -6), L('ki_timber_hit.ogg', 0.3, 0.25, 'highpass=f=2000', -14, 0.03)],
        [L('krpg_chop.ogg', 0.02, 0.22, P(1.15)), L('bfh1_wood_hit_02.ogg', 0.0, 0.3, 'highpass=f=300', -6), L('ki_timber_hit.ogg', 1.64, 0.25, 'highpass=f=2000', -14, 0.03)],
        [L('sfx100v2_wood_hit_01.ogg', 0.0, 0.25), L('krpg_chop.ogg', 0.02, 0.2, P(0.9), -4), L('ki_timber_hit.ogg', 2.6, 0.25, 'highpass=f=2000', -14, 0.03)],
        [L('bfh1_wood_hit_03.ogg', 0.0, 0.3), L('krpg_chop.ogg', 0.02, 0.2, P(1.25), -3)],
    ], {'peak': -1}),
    'imp_dirt': ([
        [L('FEETHmn_ShoeDirtLand_OS_01.ogg', 0.0, 0.3, 'lowpass=f=5000'), L('impact_soft_heavy_000.ogg', 0.0, 0.2, '', -6), L('sfx100v2_stones_03.ogg', 0.28, 0.25, 'highpass=f=1500', -14, 0.04)],
        [L('FEETHmn_ShoeDirtLand_OS_02.ogg', 0.04, 0.3, 'lowpass=f=5000'), L('impact_soft_heavy_001.ogg', 0.0, 0.2, '', -6), L('ki_rock_tumble.ogg', 0.6, 0.25, 'highpass=f=2000', -16, 0.05)],
        [L('FEETHmn_ShoeDirtRun_OS_01.ogg', 0.0, 0.25), L('impact_soft_heavy_002.ogg', 0.0, 0.2, '', -5), L('sfx100v2_stones_01.ogg', 0.0, 0.2, 'highpass=f=2000', -15, 0.04)],
    ], {'peak': -1}),
    'imp_water': ([
        [L('tw_splash.ogg', 0.08, 0.45, 'highpass=f=250'), L('splash_06.ogg', 0.0, 0.25, P(1.3), -6)],
        [L('tw_splash.ogg', 1.76, 0.45, 'highpass=f=250'), L('splash_03.ogg', 0.0, 0.25, P(1.3), -6)],
        [L('splash_02.ogg', 0.0, 0.4, P(1.2)), L('tw_splash.ogg', 4.05, 0.3, 'highpass=f=600', -6)],
    ], {'peak': -2}),
    'imp_glass': ([
        [L('sfx100v2_glass_01.ogg', 0.0, 0.36), L('impact_glass_medium_000.ogg', 0.0, 0.2, '', -6)],
        [L('sfx100v2_glass_02.ogg', 0.0, 0.4), L('GLASBrk_WindowPaneSmallBreak_OS_01.ogg', 0.0, 0.3, 'highpass=f=1500', -10)],
        [L('sfx100v2_glass_03.ogg', 0.0, 0.4), L('impact_glass_medium_001.ogg', 0.0, 0.2, '', -6)],
    ], {'peak': -2}),
    'imp_flesh': ([
        [L('FGHTImpt_PunchRegular_OS_01.ogg', 0.0, 0.24), L('krpg_knife_slice.ogg', 0.06, 0.18, 'highpass=f=1200', -12), L('splash_06.ogg', 0.0, 0.14, P(1.6) + ',lowpass=f=4000', -16)],
        [L('FGHTImpt_PunchRegular_OS_02.ogg', 0.0, 0.24), L('krpg_knife_slice_2.ogg', 0.04, 0.18, 'highpass=f=1200', -12), L('splash_03.ogg', 0.0, 0.14, P(1.6) + ',lowpass=f=4000', -16)],
        [L('FGHTImpt_PunchRegular_OS_03.ogg', 0.0, 0.24), L('FGHTImpt_Kick_OS_01.ogg', 0.0, 0.2, '', -6)],
    ], {'peak': -7}),
    # ---------------- footsteps ----------------
    'step_metal': ([[L('FEETHmn_ShoeMetalWalk_OS_0%d.ogg' % i, 0.0, 0.32)] for i in (1, 2, 3, 4, 5)] + [[L('FEETHmn_ShoeMetalRun_OS_0%d.ogg' % i, 0.0, 0.28)] for i in (1, 2, 3)], {'peak': -1}),
    'step_gravel': ([
        [L('FEETHmn_ShoeDirtRun_OS_0%d.ogg' % i, 0.0, 0.3), L('sfx100v2_stones_0%d.ogg' % (1 + i % 3), 0.0, 0.18, 'highpass=f=1800', -13)] for i in (1, 2, 3, 4, 5)
    ] + [[L('FEETHmn_ShoeDirtWalk_OS_0%d.ogg' % i, 0.0, 0.34), L('ki_rock_tumble.ogg', 0.3 * i, 0.15, 'highpass=f=2000', -15)] for i in (1, 2, 3)], {'peak': -1}),
    'step_water': ([[L('tw_step_water.ogg', s, n)] for s, n in ((0.08, 0.6), (1.014, 0.6), (1.798, 0.55), (2.502, 0.55), (3.206, 0.6))], {'peak': -1}),
    # ---------------- interface & match stings ----------------
    'uiHover': ([[L('ki_if_tick-001.ogg', 0.0, 0.05, 'highpass=f=1200')], [L('ki_if_tick-002.ogg', 0.0, 0.04, 'highpass=f=1200')]], {'peak': -6}),
    'uiConfirm': ([[L('ki_if_confirmation-003.ogg', 0.0, 0.32), L('UIClick_MetalConfirm_OS_01.ogg', 0.0, 0.3, '', -8)]], {'peak': -3}),
    'uiBack': ([[L('ki_if_back-002.ogg', 0.0, 0.09), L('UIClick_MetalBack_OS_01.ogg', 0.0, 0.25, '', -10)]], {'peak': -4}),
    'uiReady': ([[L('ki_gondola_bell.ogg', 0.0, 1.9)]], {'peak': -3}),
    # match found: an orchestra hit with a bell under it
    'uiHorn': ([[L('kj_hit03.ogg', 0.0, 0.75, P(0.85)), L('ki_gondola_bell.ogg', 0.0, 1.6, P(0.75), -10, 0.02)]], {'peak': -2}),
    'medal': ([[L('UIAlert_Notification_OS_05.ogg', 0.0, 0.24)], [L('UIAlert_Notification_OS_04.ogg', 0.0, 0.2)]], {'peak': -4}),
    # flag taken: a radio squelch and a rising two-tone (the HQ net confirming), no music
    'flagWon': ([[L('67620__qubodup__radio_click_1.flac', 0.0, 0.3, '', -2), L('67619__qubodup__radio_beep_1.flac', 0.0, 0.12, '', 0, 0.07), L('67619__qubodup__radio_beep_1.flac', 0.0, 0.12, P(1.335), 0, 0.22), L('67620__qubodup__radio_click_1.flac', 0.12, 0.18, P(1.1), -6, 0.38)]], {'peak': -3}),
    # flag lost: squelch, a low falling two-tone alert repeated once, the radio closing
    'flagLost': ([[L('67620__qubodup__radio_click_1.flac', 0.0, 0.3, '', -2), L('67619__qubodup__radio_beep_1.flac', 0.0, 0.12, P(0.75), 0, 0.07), L('67619__qubodup__radio_beep_1.flac', 0.0, 0.12, P(0.56), 0, 0.21), L('67619__qubodup__radio_beep_1.flac', 0.0, 0.12, P(0.75), -3, 0.4), L('67619__qubodup__radio_beep_1.flac', 0.0, 0.12, P(0.56), -3, 0.54), L('67620__qubodup__radio_click_1.flac', 0.12, 0.18, P(0.9), -6, 0.72)]], {'peak': -3}),
    'capTick': ([[L('ki_if_tick-004.ogg', 0.0, 0.06, 'highpass=f=1500')]], {'peak': -6}),
    'streak': ([[L('UIMisc_Powerup_OS_02.ogg', 0.0, 1.2)]], {'peak': -3}),
    'radio': ([
        [L('67620__qubodup__radio_click_1.flac', 0.0, 0.3), L('67619__qubodup__radio_beep_1.flac', 0.0, 0.12, '', -8, 0.06)],
        [L('67620__qubodup__radio_click_1.flac', 0.0, 0.3, P(0.9))],
    ], {'peak': -3}),
    'uavPing': ([[L('67619__qubodup__radio_beep_1.flac', 0.0, 0.12), L('UIAlert_Notification_OS_04.ogg', 0.0, 0.2, '', -3, 0.04)]], {'peak': -3}),
    # ---------------- world ----------------
    # a burning wreck: the road-flare burn slowed into a roar, with the crackle on top
    'carFire': ([[
        L('tnt_gunpowder_burning.ogg', 0.0, 1.0, P(0.55) + ',lowpass=f=1800', 0, 0.0),
        L('tnt_gunpowder_burning.ogg', 0.1, 0.9, P(0.6) + ',lowpass=f=1800', -1, 1.5),
        L('tnt_gunpowder_burning.ogg', 0.0, 1.0, 'highpass=f=2500', -9, 0.2),
        L('tnt_gunpowder_burning.ogg', 0.2, 0.8, 'highpass=f=2500,' + P(0.85), -9, 1.25),
        L('tnt_gunpowder_burning.ogg', 0.0, 1.0, 'highpass=f=2500,' + P(1.1), -10, 2.2),
    ]], {'loop': 0.35, 'peak': -3}),
    'gull': ([[L('tw_gull.ogg', s, n, 'highpass=f=500')] for s, n in ((0.08, 1.0), (1.161, 1.4), (2.645, 0.9), (3.629, 1.11), (4.823, 1.04), (5.947, 0.52))], {'peak': -3}),
    'song': ([[L('AMBForst_ForestBirds_OS_0%d.ogg' % f, s, n, 'highpass=f=1200')] for f, s, n in ((1, 0.9, 1.4), (1, 2.0, 1.4), (2, 0.3, 1.5), (2, 2.3, 1.5), (2, 4.85, 1.5), (3, 0.0, 1.5))], {'peak': -4}),
    # ---------------- loops ----------------
    'loop_wind': ([[L('tw_wind.ogg', 2.0, 21.0, 'highpass=f=60')]], {'loop': 1.5, 'peak': -3}),
    'loop_waves': ([[L('tw_pier_lap.ogg', 0.0, 19.0), L('WATRWave_OceanWaves_LOOP_01.ogg', 0.0, 19.0, 'lowpass=f=3000', -9)]], {'loop': 1.5, 'peak': -3}),
    'loop_rain': ([[L('RAIN_CityRain_LOOP_01.ogg', 0.0, 17.0), L('ki_rain_canopy.ogg', 3.0, 17.0, '', -6)]], {'loop': 1.5, 'peak': -1}),
    'loop_snowwind': ([[L('tw_wind.ogg', 28.0, 21.0, P(0.85) + ',lowpass=f=2200'), L('CLOTHFlp_FlagFlapping_LOOP_01.ogg', 0.0, 18.0, 'highpass=f=300,lowpass=f=3000', -14)]], {'loop': 1.5, 'peak': -3}),
    # sliding / zipline: gravel scraping under you, cloth dragging
    'loop_slide': ([[L('ki_rock_tumble.ogg', 0.0, 2.6, 'lowpass=f=3500'), L('ki_rock_tumble.ogg', 1.4, 2.6, 'lowpass=f=3500,' + P(0.9), -3), L(CLOTH % 3, 0.0, 1.2, '', -8, 0.4)]], {'loop': 0.4, 'peak': -3}),
    # helicopter: a big fan slowed into a rotor with a blade-rate chop, a turbine whine above it
    'loop_heli': ([[L('MACHFan_Fan_LOOP_01.ogg', 0.0, 4.5, P(0.45) + ',lowpass=f=1400,tremolo=f=6:d=0.85'),
                    L('VEHCar_CarEngineSlow_LOOP_01.ogg', 0.0, 4.5, P(0.7) + ',lowpass=f=900,tremolo=f=6:d=0.5', -5),
                    L('MACHMisc_MachineHum_LOOP_01.ogg', 0.0, 4.5, P(1.6) + ',highpass=f=1500', -16)]], {'loop': 0.5, 'peak': -3}),
}


def doppler(y, r0, r1):
    """variable-speed playback of a recording (rate gliding r0 -> r1): an incoming shell's falling whistle"""
    n_out = int(len(y) / ((r0 + r1) / 2))
    r = np.linspace(r0, r1, n_out)
    pos = np.cumsum(r)
    pos = pos[pos < len(y) - 1]
    i = pos.astype(int)
    f = pos - i
    return (y[i] * (1 - f) + y[i + 1] * f).astype(np.float32)


def whistle(raw):
    # a fly-by whiz stretched and gliding down an octave as the round drops in
    out = []
    for s, n in ((0.1, 0.55), (1.33, 0.45)):
        y = E.render([L(WHIZ, s, n, 'highpass=f=300')], raw)
        z = doppler(y, 0.62, 0.3)
        out.append(E.fade(z, 0.08, 0.08))
    return out


def main(raw):
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith('.ogg'): os.remove(os.path.join(OUT, f))
    man = {}

    def put(key, i, y, opt):
        if opt.get('loop'): y = E.make_loop(y, opt['loop'])
        else: y = E.fade(y, 0.001, 0.03)
        name = f'{key}_{i}.ogg'
        E.save(y, os.path.join(OUT, name), opt.get('peak', -1.0))
        man.setdefault(key, []).append({'file': name, 'loop': bool(opt.get('loop'))})
        print(f'{name}: {len(y) / SR:.2f}s')

    for key, (variants, opt) in BANK.items():
        for i, layers in enumerate(variants): put(key, i, E.render(layers, raw), opt)
    for i, y in enumerate(whistle(raw)): put('whistle', i, y, {'peak': -2})
    with open(os.path.join(OUT, 'manifest.json'), 'w') as fh:
        json.dump(man, fh, indent=1)
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f'{sum(len(v) for v in man.values())} files, {total / 1024:.0f} KB')


if __name__ == '__main__':
    main(sys.argv[1])

# compose tools/shots/mp7_<act>_<i>.png (12 frames) into one 4x3 sheet
import sys
from PIL import Image, ImageDraw
act = sys.argv[1]
W = Image.new('RGB', (320 * 4, 180 * 3))
for i in range(12):
    im = Image.open(f'tools/shots/mp7_{act}_{i}.png').resize((320, 180))
    ImageDraw.Draw(im).text((6, 6), 't=%.2f' % (i / 11 * 0.98), fill=(255, 255, 0))
    W.paste(im, ((i % 4) * 320, (i // 4) * 180))
W.save(f'tools/shots/mp7_{act}.png')

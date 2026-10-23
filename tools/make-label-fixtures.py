# Makes fake-camera videos (MJPEG) of part labels for tools/e2e-label.mjs.
# Chromium plays them as the camera: --use-file-for-fake-video-capture=<file>.
# Run: python3 tools/make-label-fixtures.py   (needs Pillow)
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
LABELS = {'label-e20': 'E 20', 'label-maintw00015': 'MAINTW00015', 'label-x99': 'X 99'}

for name, text in LABELS.items():
    img = Image.new('RGB', (640, 480), (92, 98, 108))          # grey shelf
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((70, 165, 570, 315), 14, fill=(246, 244, 236))   # white sticker
    font = ImageFont.truetype(FONT, 84 if len(text) < 8 else 62)
    w = d.textlength(text, font=font)
    d.text(((640 - w) / 2, 240), text, font=font, fill=(20, 20, 24), anchor='lm')
    d.text((90, 180), 'MNSB  STORE', font=ImageFont.truetype(FONT, 18), fill=(90, 90, 90))
    img = img.filter(ImageFilter.GaussianBlur(0.8))           # a little camera blur
    with open(f'tests/fixtures/{name}.mjpeg', 'wb') as f:
        for _ in range(3):
            b = BytesIO(); img.save(b, 'JPEG', quality=85); f.write(b.getvalue())
    img.save(f'tests/fixtures/{name}.png')
print('ok')

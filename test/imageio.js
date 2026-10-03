/* JPEG/PNG read + write for Node tests, via Python Pillow (keeps npm deps small). */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function tmp(name) { return path.join(os.tmpdir(), `ph-${process.pid}-${name}`); }

// Returns {w, h, data: Uint8ClampedArray RGBA}, honoring EXIF rotation.
function readImage(file, maxSide) {
  const raw = tmp('in.rgba');
  const py = `
from PIL import Image, ImageOps
im = ImageOps.exif_transpose(Image.open(r'${file}')).convert('RGBA')
m = ${maxSide || 0}
if m and max(im.size) > m:
    s = m / max(im.size); im = im.resize((round(im.size[0]*s), round(im.size[1]*s)), Image.LANCZOS)
open(r'${raw}', 'wb').write(im.tobytes()); print(im.size[0], im.size[1])`;
  const [w, h] = execFileSync('python', ['-c', py]).toString().trim().split(/\s+/).map(Number);
  const data = new Uint8ClampedArray(fs.readFileSync(raw));
  fs.unlinkSync(raw);
  return { w, h, data };
}

function writeJpg(file, w, h, data) {
  const raw = tmp('out.rgba');
  fs.writeFileSync(raw, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  execFileSync('python', ['-c', `from PIL import Image; Image.frombytes('RGBA',(${w},${h}),open(r'${raw}','rb').read()).convert('RGB').save(r'${file}', quality=85)`]);
  fs.unlinkSync(raw);
}

module.exports = { readImage, writeJpg };

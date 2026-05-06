/**
 * Builds a real Windows .ico from a PNG source.
 * `assets/icon.ico` was a PNG misnamed as .ico; rcedit rejects that.
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const toIco = require("to-ico");

function isPng(buf) {
  return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

async function main() {
  const assets = path.join(__dirname, "..", "assets");
  const candidates = ["icon.png", "icon.ico"].map((n) => path.join(assets, n));
  let pngBuf = null;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const b = fs.readFileSync(p);
    if (isPng(b)) {
      pngBuf = b;
      break;
    }
  }
  if (!pngBuf) {
    throw new Error("No PNG found in assets/icon.png or assets/icon.png-as-PNG in icon.ico");
  }

  const sizes = [16, 32, 48, 64, 128, 256];
  const pngLayers = await Promise.all(
    sizes.map((s) => sharp(pngBuf).resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer())
  );
  const ico = await toIco(pngLayers);
  fs.writeFileSync(path.join(assets, "icon.ico"), ico);
  fs.writeFileSync(path.join(assets, "icon.png"), pngBuf);
  console.log("Wrote assets/icon.ico (Windows) and assets/icon.png (tray/UI).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const svgPath = process.argv[2];
const outputs = [
  { width: 256, file: 'src-tauri/icons/variants/wave.png' },
  { width: 64, file: 'src-tauri/icons/variants/wave-tray.png' },
  { width: 256, file: 'public/app-icons/wave.png' },
];

const svg = fs.readFileSync(svgPath);
const root = path.resolve(__dirname, '..');

for (const { width, file } of outputs) {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: 'rgba(0,0,0,0)',
  })
    .render()
    .asPng();
  const out = path.join(root, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  console.log(`wrote ${file} (${width}px, ${png.length} bytes)`);
}

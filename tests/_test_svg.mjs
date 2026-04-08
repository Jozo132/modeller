import { parseSVGGeometry, svgBounds } from '../js/svg/import.js';
import fs from 'fs';

const svg = fs.readFileSync('./tests/samples/test-import.svg', 'utf-8');
const items = parseSVGGeometry(svg);
console.log('Total segments:', items.length);
const b = svgBounds(items);
console.log('Bounds:', JSON.stringify({ w: b.width.toFixed(1), h: b.height.toFixed(1) }));
const types = {};
items.forEach(i => { types[i.type] = (types[i.type] || 0) + 1; });
console.log('Types:', types);
console.log('First 5:');
items.slice(0, 5).forEach((i, n) =>
  console.log(' ', n, i.type, i.x1.toFixed(1) + ',' + i.y1.toFixed(1), '->', i.x2.toFixed(1) + ',' + i.y2.toFixed(1))
);

// Test with the user's actual path snippet (partial)
const userSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10,10 L 50,10 C 50,30 70,50 90,50 L 90,90 Z" />
</svg>`;
const userItems = parseSVGGeometry(userSvg);
console.log('\nUser path test:', userItems.length, 'segments');

// Test arc command
const arcSvg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M 10,80 A 45,45 0 0,0 125,125" /></svg>`;
const arcItems = parseSVGGeometry(arcSvg);
console.log('Arc test:', arcItems.length, 'segments');

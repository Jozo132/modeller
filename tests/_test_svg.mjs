import { parseSVGGeometry, svgBounds } from '../js/svg/import.js';
import fs from 'fs';

const svg = fs.readFileSync('./tests/samples/test-import.svg', 'utf-8');
const items = parseSVGGeometry(svg);
console.log('Total items:', items.length);
const b = svgBounds(items);
console.log('Bounds:', JSON.stringify({ w: b.width.toFixed(1), h: b.height.toFixed(1) }));
const types = {};
items.forEach(i => { types[i.type] = (types[i.type] || 0) + 1; });
console.log('Types:', types);
console.log('First 5:');
items.slice(0, 5).forEach((i, n) => {
  if (i.type === 'line') {
    const x1 = i.x1 != null ? i.x1.toFixed(1) : '?';
    const y1 = i.y1 != null ? i.y1.toFixed(1) : '?';
    const x2 = i.x2 != null ? i.x2.toFixed(1) : '?';
    const y2 = i.y2 != null ? i.y2.toFixed(1) : '?';
    console.log(' ', n, i.type, x1 + ',' + y1, '->', x2 + ',' + y2);
  } else if (i.type === 'cubicBezier') {
    console.log(' ', n, i.type, i.x0.toFixed(1) + ',' + i.y0.toFixed(1), '->', i.x.toFixed(1) + ',' + i.y.toFixed(1));
  } else if (i.type === 'quadBezier') {
    console.log(' ', n, i.type, i.x0.toFixed(1) + ',' + i.y0.toFixed(1), '->', i.x.toFixed(1) + ',' + i.y.toFixed(1));
  }
});

// Test with the user's actual path snippet (partial)
const userSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10,10 L 50,10 C 50,30 70,50 90,50 L 90,90 Z" />
</svg>`;
const userItems = parseSVGGeometry(userSvg);
console.log('\nUser path test:', userItems.length, 'items');
const userTypes = {};
userItems.forEach(i => { userTypes[i.type] = (userTypes[i.type] || 0) + 1; });
console.log('User path types:', userTypes);

// Test arc command
const arcSvg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M 10,80 A 45,45 0 0,0 125,125" /></svg>`;
const arcItems = parseSVGGeometry(arcSvg);
console.log('Arc test:', arcItems.length, 'items');

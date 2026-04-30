const fs = require('fs');
const src = fs.readFileSync('js/cad/BRepChamfer.js','utf8');
let depth=0,line=1,inStr=false,str='',inCmt=false,inLine=false,inRegex=false;
const stack=[];
for(let i=0;i<src.length;i++){
  const c=src[i],n=src[i+1];
  if(c==='\n'){line++; if(inLine){inLine=false;} continue;}
  if(inLine) continue;
  if(inCmt){ if(c==='*'&&n==='/'){inCmt=false;i++;} continue; }
  if(inStr){
    if(c==='\\'){i++;continue;}
    if(str==='`' && c==='$' && n==='{'){ depth++; stack.push(line); i++; continue; }
    if(c===str){inStr=false;}
    continue;
  }
  if(c==='/'&&n==='/'){inLine=true;continue;}
  if(c==='/'&&n==='*'){inCmt=true;i++;continue;}
  if(c==="'"||c==='"'||c==='`'){inStr=true;str=c;continue;}
  if(c==='{'){depth++; stack.push(line);}
  if(c==='}'){depth--; stack.pop(); if(depth<0){console.log('neg at line',line);break;}}
}
console.log('final depth',depth,'last line',line);
console.log('open at lines:', stack.slice(-10));

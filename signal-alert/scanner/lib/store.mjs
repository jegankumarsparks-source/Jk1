import fs from 'node:fs';
export class Store{
  constructor(dir){this.dir=dir;fs.mkdirSync(dir,{recursive:true});}
  p(n){return this.dir+'/'+n+'.json'}
  read(n,d){try{return JSON.parse(fs.readFileSync(this.p(n),'utf8'))}catch{return d}}
  write(n,v){const t=this.p(n)+'.tmp';fs.writeFileSync(t,JSON.stringify(v));fs.renameSync(t,this.p(n));} // atomic
}

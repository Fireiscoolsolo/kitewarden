// The C# compiler that ships with Windows. It writes the time and a random module ID into each program; both are replaced here,
// so that the same sources give the same file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CSC = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');

export function compile(out, args) {
  execFileSync(CSC, ['/nologo', '/warnaserror+', '/optimize+', '/platform:x64', '/target:exe', `/out:${out}`, ...args], { stdio: 'inherit' });
  const b = readFileSync(out);
  const pe = b.readUInt32LE(0x3c);
  b.writeUInt32LE(0, pe + 8); // time
  // PE32+: data directory 14 is the CLI header, which names the metadata. A search would find the one of an embedded program.
  const sections = pe + 24 + b.readUInt16LE(pe + 20);
  const offset = (rva) => {
    for (let s = sections; ; s += 40) if (rva >= b.readUInt32LE(s + 12) && rva < b.readUInt32LE(s + 12) + b.readUInt32LE(s + 16)) return rva - b.readUInt32LE(s + 12) + b.readUInt32LE(s + 20);
  };
  const meta = offset(b.readUInt32LE(offset(b.readUInt32LE(pe + 24 + 112 + 14 * 8)) + 8));
  if (b.toString('latin1', meta, meta + 4) !== 'BSJB') throw new Error(`${out}: no metadata`);
  const version = b.readUInt32LE(meta + 12);
  let at = meta + 16 + version + 4;
  for (let n = b.readUInt16LE(at - 2); n > 0; n--) {
    const name = b.toString('latin1', at + 8, b.indexOf(0, at + 8));
    if (name === '#GUID') {
      const id = meta + b.readUInt32LE(at);
      b.fill(0, id, id + 16);
      createHash('sha256').update(b).digest().copy(b, id, 0, 16);
      writeFileSync(out, b);
      return;
    }
    at += 8 + Math.ceil((name.length + 1) / 4) * 4;
  }
  throw new Error(`${out}: no module ID`);
}

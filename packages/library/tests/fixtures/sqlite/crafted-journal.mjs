// Writes a crafted rollback journal next to a database (R77 C1 probe): a valid hot-journal header
// (nRec 0, database size = its page count) followed by a super-journal record that names `victim`
// by absolute path. Opening the database read-write would make SQLite roll the journal back and
// then delete the "super-journal" — the victim file. The importer must refuse such a journal.
import { readFileSync, writeFileSync } from "node:fs";

export const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

/**
 * @param {string} dbPath
 * @param {{ victim?: string, pageSize?: number, sectorSize?: number }} o
 * @returns {string} the journal path
 */
export function writeCraftedJournal(dbPath, o = {}) {
  const db = readFileSync(dbPath);
  const raw = db.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  const sector = o.sectorSize ?? 512;
  const hdr = Buffer.alloc(512);
  JOURNAL_MAGIC.copy(hdr, 0);
  hdr.writeUInt32BE(0, 8); // nRec
  hdr.writeUInt32BE(0x12345678, 12); // nonce
  hdr.writeUInt32BE(Math.floor(db.length / pageSize), 16); // database size in pages
  hdr.writeUInt32BE(sector >>> 0, 20);
  hdr.writeUInt32BE((o.pageSize ?? pageSize) >>> 0, 24);
  const parts = [hdr];
  if (o.victim) {
    const name = Buffer.from(o.victim, "utf8");
    let cksum = 0;
    for (const c of name) cksum = (cksum + c) >>> 0;
    parts.push(u32(Math.floor(0x40000000 / pageSize) + 1), name, u32(name.length), u32(cksum), JOURNAL_MAGIC);
  }
  const path = `${dbPath}-journal`;
  writeFileSync(path, Buffer.concat(parts));
  return path;
}

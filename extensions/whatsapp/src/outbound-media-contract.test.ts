// Unit tests for the WhatsApp Ogg/Opus vendor-tag patcher. The patcher is what
// makes transcoded voice notes playable on WhatsApp mobile: it rewrites the
// OpusTags vendor to "WhatsApp" while leaving every other page byte-identical.
// These tests cover single-page packets, packets spanning multiple Ogg pages,
// per-page tails, and truncated/invalid streams (which must pass through).
import { describe, expect, it } from "vitest";
import { fixWhatsAppOpusVendor } from "./outbound-media-contract.js";

const POLY = 0x04c11db7;

function buildCrcTable(): number[] {
  return Array.from({ length: 256 }, (_, i) => {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? (((r << 1) >>> 0) ^ POLY) >>> 0 : (r << 1) >>> 0;
    }
    return r >>> 0;
  });
}

const CRC_TABLE = buildCrcTable();

function pageCrc(data: Buffer): number {
  let c = 0;
  for (const byte of data) {
    const idx = ((c >>> 24) ^ byte) & 0xff;
    c = (((c << 8) >>> 0) ^ (CRC_TABLE[idx] ?? 0)) >>> 0;
  }
  return c >>> 0;
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
};

const lace = (blob: Buffer): number[] => {
  const l: number[] = [];
  let rest = blob;
  while (rest.length >= 255) {
    l.push(255);
    rest = rest.subarray(255);
  }
  l.push(rest.length);
  return l;
};

function buildPage(params: {
  htype: number;
  granule: bigint;
  serial: number;
  seq: number;
  body: Buffer;
  laces?: number[];
}): Buffer {
  const laces = params.laces ?? lace(params.body);
  const segTable = Buffer.from(laces);
  const h = Buffer.alloc(27 + segTable.length);
  h.write("OggS", 0, "ascii");
  h[5] = params.htype;
  h.writeBigUInt64LE(params.granule, 6);
  h.writeUInt32LE(params.serial >>> 0, 14);
  h.writeUInt32LE(params.seq >>> 0, 18);
  h[26] = segTable.length;
  segTable.copy(h, 27);
  const full = Buffer.concat([h, params.body]);
  full.writeUInt32LE(pageCrc(full), 22);
  return full;
}

function opusHeadBody(): Buffer {
  const body = Buffer.alloc(19);
  body.write("OpusHead", 0, "ascii");
  body.writeUInt8(1, 8);
  body.writeUInt16LE(2, 9);
  body.writeUInt16LE(0, 11);
  body.writeUInt32LE(48000, 12);
  return body;
}

function opusTagsBody(vendor: string, comments: Array<[string, string]> = []): Buffer {
  const vendorBuf = Buffer.from(vendor);
  const chunks: Buffer[] = [
    Buffer.from("OpusTags"),
    u32(vendorBuf.length),
    vendorBuf,
    u32(comments.length),
  ];
  for (const [k, v] of comments) {
    const kv = Buffer.from(`${k}=${v}`);
    chunks.push(u32(kv.length), kv);
  }
  return Buffer.concat(chunks);
}

type ParsedPage = {
  htype: number;
  granule: bigint;
  serial: number;
  seq: number;
  laces: number[];
  body: Buffer;
  raw: Buffer;
};

function parsePages(buf: Buffer): ParsedPage[] {
  const pages: ParsedPage[] = [];
  let off = 0;
  while (off + 27 <= buf.length && buf.subarray(off, off + 4).toString("ascii") === "OggS") {
    const htype = buf.readUInt8(off + 5);
    const granule = buf.readBigUInt64LE(off + 6);
    const serial = buf.readUInt32LE(off + 14);
    const seq = buf.readUInt32LE(off + 18);
    const nSegs = buf.readUInt8(off + 26);
    const laces = Array.from(buf.subarray(off + 27, off + 27 + nSegs));
    const bodyLen = laces.reduce((a, b) => a + b, 0);
    const body = buf.subarray(off + 27 + nSegs, off + 27 + nSegs + bodyLen);
    pages.push({
      htype,
      granule,
      serial,
      seq,
      laces,
      body,
      raw: buf.subarray(off, off + 27 + nSegs + bodyLen),
    });
    off += 27 + nSegs + bodyLen;
  }
  return pages;
}

function expectValidCrc(page: ParsedPage): void {
  const copy = Buffer.from(page.raw);
  copy.writeUInt32LE(0, 22);
  expect(pageCrc(copy)).toBe(page.raw.readUInt32LE(22));
}

const WHATSAPP_TAGS_BODY = Buffer.concat([
  Buffer.from("OpusTags"),
  u32(8),
  Buffer.from("WhatsApp"),
  u32(0),
]);

describe("fixWhatsAppOpusVendor", () => {
  it("rewrites a single-page OpusTags vendor and keeps all other pages byte-identical", () => {
    const headPage = buildPage({
      htype: 0x02,
      granule: 0n,
      serial: 7,
      seq: 0,
      body: opusHeadBody(),
    });
    const tagsPage = buildPage({
      htype: 0x00,
      granule: 0n,
      serial: 7,
      seq: 1,
      body: opusTagsBody("Lavf62.3.100"),
    });
    const audioPage = buildPage({
      htype: 0x00,
      granule: 960n,
      serial: 7,
      seq: 2,
      body: Buffer.from("AUDIO-DATA"),
    });
    const input = Buffer.concat([headPage, tagsPage, audioPage]);

    const out = fixWhatsAppOpusVendor(input);

    const pages = parsePages(out);
    expect(pages).toHaveLength(3);
    expect(pages[0]?.raw.equals(headPage)).toBe(true);
    expect(pages[1]?.body.equals(WHATSAPP_TAGS_BODY)).toBe(true);
    expect(pages[1]?.htype).toBe(0x00);
    expect(pages[2]?.raw.equals(audioPage)).toBe(true);
    for (const page of pages) {
      expectValidCrc(page);
    }
  });

  it("rewrites an OpusTags packet spanning multiple pages and promotes the per-page tail", () => {
    const headPage = buildPage({
      htype: 0x02,
      granule: 0n,
      serial: 9,
      seq: 0,
      body: opusHeadBody(),
    });
    // A retained metadata comment large enough that ffmpeg splits the OpusTags
    // packet across two Ogg pages (the reported invalid-framing repro).
    const bigTagsBody = opusTagsBody("Lavf62.3.100", [["comment", "x".repeat(700)]]);
    const tagsChunk1 = bigTagsBody.subarray(0, 510); // laces [255, 255] -> packet continues
    const tagsChunk2 = bigTagsBody.subarray(510); // ends the packet on the next page
    const tailAudio = Buffer.from("AUDIO"); // a fresh packet sharing the continuation page
    const nextAudio = Buffer.from("END"); // a fresh packet on the following page
    const tagsContinuationPage = buildPage({
      htype: 0x01,
      granule: 0n,
      serial: 9,
      seq: 2,
      body: Buffer.concat([tagsChunk2, tailAudio]),
      laces: [tagsChunk2.length, tailAudio.length],
    });
    const nextPage = buildPage({ htype: 0x00, granule: 960n, serial: 9, seq: 3, body: nextAudio });
    const input = Buffer.concat([
      headPage,
      buildPage({
        htype: 0x00,
        granule: 0n,
        serial: 9,
        seq: 1,
        body: tagsChunk1,
        laces: [255, 255],
      }),
      tagsContinuationPage,
      nextPage,
    ]);

    const out = fixWhatsAppOpusVendor(input);

    const pages = parsePages(out);
    expect(pages).toHaveLength(4);
    expect(pages[0]?.raw.equals(headPage)).toBe(true);
    expect(pages[1]?.body.equals(WHATSAPP_TAGS_BODY)).toBe(true);
    expect(pages[1]?.htype).toBe(0x00);
    expect(pages[1]?.seq).toBe(1);
    // Old continuation pages are gone; the tail after the terminating lace is
    // promoted to a fresh page that starts the next packet.
    expect(pages[2]?.body.equals(tailAudio)).toBe(true);
    expect(pages[2]?.htype).toBe(0x00);
    expect(pages[2]?.seq).toBe(2);
    expect(pages[2]?.laces).toEqual([5]);
    // A byte-identical page afterwards keeps its original sequence number.
    expect(pages[3]?.raw.equals(nextPage)).toBe(true);
    expect(pages[3]?.seq).toBe(3);
    for (const page of pages) {
      expectValidCrc(page);
    }
  });

  it("returns the input unchanged when the OpusTags packet never terminates", () => {
    const headPage = buildPage({
      htype: 0x02,
      granule: 0n,
      serial: 3,
      seq: 0,
      body: opusHeadBody(),
    });
    const truncatedTags = buildPage({
      htype: 0x00,
      granule: 0n,
      serial: 3,
      seq: 1,
      body: Buffer.alloc(510, 0xee),
      laces: [255, 255],
    });
    const input = Buffer.concat([headPage, truncatedTags]);

    expect(fixWhatsAppOpusVendor(input).equals(input)).toBe(true);
  });

  it("returns the input unchanged when no OpusTags packet exists", () => {
    const headPage = buildPage({
      htype: 0x02,
      granule: 0n,
      serial: 5,
      seq: 0,
      body: opusHeadBody(),
    });
    const audioPage = buildPage({
      htype: 0x00,
      granule: 960n,
      serial: 5,
      seq: 1,
      body: Buffer.from("AUDIO-DATA"),
    });
    const input = Buffer.concat([headPage, audioPage]);

    expect(fixWhatsAppOpusVendor(input).equals(input)).toBe(true);
  });
});

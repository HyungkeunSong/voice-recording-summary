/**
 * Extracts raw AMR-NB audio data from a 3GP/MP4 container file.
 *
 * 3GP/MP4 Box layout:
 *   [4 bytes: size (big-endian uint32)] [4 bytes: type (ASCII)] [payload]
 *
 * Special case – extended size:
 *   If size field == 1, the next 8 bytes are the real 64-bit size (covers
 *   the 16-byte header itself).  Very rare for voice recordings but handled.
 *
 * The mdat box holds the concatenated raw AMR frames.  To make amr-js happy
 * we prepend the 6-byte magic header "#!AMR\n".
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface Box {
  type: string;      // 4-char ASCII box type, e.g. "ftyp", "moov", "mdat"
  start: number;     // byte offset of the first size byte in the buffer
  headerSize: number;// 8 (standard) or 16 (extended size)
  payloadSize: number;// bytes of payload (total box size minus header)
}

// ─── AMR magic header ───────────────────────────────────────────────────────

const AMR_HEADER = Buffer.from('#!AMR\n');  // 6 bytes required by amr-js

// ─── Core implementation ─────────────────────────────────────────────────────

/**
 * Walks the top-level boxes of a 3GP buffer and returns a descriptor for each
 * one.  Does NOT recurse into container boxes (moov, trak, …) – we only need
 * the top-level mdat.
 */
function parseTopLevelBoxes(buffer: Buffer): Box[] {
  const boxes: Box[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    // --- read 4-byte size and 4-byte type -----------------------------------
    const sizeField = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);

    let headerSize: number;
    let totalBoxSize: number; // includes header bytes

    if (sizeField === 0) {
      // size == 0  →  box extends to end of file
      headerSize = 8;
      totalBoxSize = buffer.length - offset;
    } else if (sizeField === 1) {
      // size == 1  →  extended 64-bit size follows in next 8 bytes
      if (offset + 16 > buffer.length) break; // truncated
      // JavaScript numbers lose precision above 2^53, but voice recordings
      // are small enough that the high 32 bits will always be 0.
      const hiWord = buffer.readUInt32BE(offset + 8);
      const loWord = buffer.readUInt32BE(offset + 12);
      if (hiWord !== 0) {
        throw new Error(
          `Box at offset ${offset} has a size > 4 GB – not supported.`
        );
      }
      headerSize = 16;
      totalBoxSize = loWord; // low 32 bits are sufficient
    } else {
      // Normal case: size field is the total box size
      headerSize = 8;
      totalBoxSize = sizeField;
    }

    if (totalBoxSize < headerSize) {
      throw new Error(
        `Malformed box at offset ${offset}: reported size ${totalBoxSize} < header size ${headerSize}`
      );
    }

    boxes.push({
      type,
      start: offset,
      headerSize,
      payloadSize: totalBoxSize - headerSize,
    });

    offset += totalBoxSize;
  }

  return boxes;
}

/**
 * Robust version – properly parses the box structure.
 *
 * Use this when you cannot guarantee that "mdat" does not appear as bytes
 * inside another box's payload (e.g. inside a moov/udta comment field).
 */
export function extract3gpAmrData(buffer: Buffer): Buffer {
  const boxes = parseTopLevelBoxes(buffer);

  const mdatBox = boxes.find((b) => b.type === 'mdat');
  if (!mdatBox) {
    throw new Error('No mdat box found in the supplied buffer.');
  }

  const payloadStart = mdatBox.start + mdatBox.headerSize;
  const payload = buffer.subarray(payloadStart, payloadStart + mdatBox.payloadSize);

  return Buffer.concat([AMR_HEADER, payload]);
}

/**
 * Simple version – scans for the ASCII bytes "mdat" and treats everything
 * after the 8-byte box header as AMR payload.
 *
 * Works perfectly for typical voice-memo 3GP files where:
 *   - mdat is the last box (or at least does not appear as a substring
 *     inside moov metadata before the real mdat box).
 *   - The file uses the standard 4-byte size field (not extended).
 *
 * If you control the recording source (e.g. Android voice recorder, iOS
 * voice memo exported as 3gp) this is safe.  Prefer the robust version when
 * processing arbitrary files.
 */
export function extract3gpAmrDataSimple(buffer: Buffer): Buffer {
  const MDAT = Buffer.from('mdat');

  // indexOf finds the first occurrence of the 4-byte type field.
  // The size field sits 4 bytes *before* the type, so the box starts at idx-4.
  const typeOffset = buffer.indexOf(MDAT);
  if (typeOffset < 4) {
    throw new Error('mdat box not found in the supplied buffer.');
  }

  // The payload starts immediately after the 8-byte header.
  const payloadOffset = typeOffset + 4; // skip the 4-byte type field
  const payload = buffer.subarray(payloadOffset);

  return Buffer.concat([AMR_HEADER, payload]);
}

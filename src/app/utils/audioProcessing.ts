import { extract3gpAmrData } from "./extract3gpAmr";

const WAV_HEADER_SIZE = 44;

export function isAmrFile(buffer: Buffer): boolean {
  return buffer.length >= 6 && buffer.toString("ascii", 0, 6) === "#!AMR\n";
}

export function isMp4Container(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.toString("ascii", 4, 8) === "ftyp";
}

export function convertAmrToWav(amrBuffer: Buffer): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AMR = require("amr-js/library/amrnb");
  const amrData = new Uint8Array(amrBuffer);
  const wavData: Uint8Array | null = AMR.toWAV(amrData);
  if (!wavData) {
    throw new Error("AMR 디코딩 실패");
  }
  return Buffer.from(wavData);
}

export function splitWavIntoChunks(wavBuffer: Buffer, maxChunkSize: number): Buffer[] {
  if (wavBuffer.length <= maxChunkSize) {
    return [wavBuffer];
  }

  const numChannels = wavBuffer.readUInt16LE(22);
  const sampleRate = wavBuffer.readUInt32LE(24);
  const bitsPerSample = wavBuffer.readUInt16LE(34);
  const blockAlign = numChannels * (bitsPerSample / 8);

  const pcmData = wavBuffer.subarray(WAV_HEADER_SIZE);
  const maxPcmPerChunk = Math.floor((maxChunkSize - WAV_HEADER_SIZE) / blockAlign) * blockAlign;

  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < pcmData.length) {
    const chunkPcmSize = Math.min(maxPcmPerChunk, pcmData.length - offset);
    const chunkPcm = pcmData.subarray(offset, offset + chunkPcmSize);

    const header = Buffer.alloc(WAV_HEADER_SIZE);
    const fileSize = WAV_HEADER_SIZE + chunkPcmSize;
    header.write("RIFF", 0);
    header.writeUInt32LE(fileSize - 8, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(chunkPcmSize, 40);

    chunks.push(Buffer.concat([header, chunkPcm]));
    offset += chunkPcmSize;
  }

  return chunks;
}

const MIME_MAP: Record<string, string> = {
  m4a: "audio/mp4", mp3: "audio/mpeg", aac: "audio/aac",
  wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm", flac: "audio/flac",
  mp4: "audio/mp4", mpeg: "audio/mpeg", mpga: "audio/mpeg", oga: "audio/ogg",
};

interface PreparedAudio {
  buffer: Buffer;
  name: string;
  type: string;
}

export function prepareAudioForWhisper(
  inputBuffer: Buffer,
  originalFileName: string,
  log: (msg: string) => void,
): PreparedAudio {
  if (isAmrFile(inputBuffer)) {
    log("AMR detected, converting to WAV...");
    const wavBuffer = convertAmrToWav(inputBuffer);
    log(`WAV conversion done, size: ${wavBuffer.length}`);
    return { buffer: wavBuffer, name: "audio.wav", type: "audio/wav" };
  }

  if (isMp4Container(inputBuffer)) {
    log("MP4/ftyp container detected");
    const is3gp = inputBuffer.toString("ascii", 8, 12).startsWith("3gp");
    if (is3gp) {
      log("3GP brand detected, extracting AMR from mdat...");
      try {
        const amrBuffer = extract3gpAmrData(inputBuffer);
        log(`AMR extracted (${amrBuffer.length} bytes), converting to WAV...`);
        const wavBuffer = convertAmrToWav(amrBuffer);
        log(`WAV conversion done, size: ${wavBuffer.length}`);
        return { buffer: wavBuffer, name: "audio.wav", type: "audio/wav" };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`AMR extraction failed (${msg}), falling back to .mp4 upload`);
        return { buffer: inputBuffer, name: "audio.mp4", type: "audio/mp4" };
      }
    }
    log("Non-3GP MP4 container, sending as .mp4");
    return { buffer: inputBuffer, name: "audio.mp4", type: "audio/mp4" };
  }

  // 기타 파일: 확장자 기반 MIME 매핑
  const ext = originalFileName.toLowerCase().match(/\.(m4a|mp3|aac|wav|ogg|webm|flac|mp4|mpeg|mpga|oga)$/)?.[1] || "mp3";
  return {
    buffer: inputBuffer,
    name: `audio.${ext}`,
    type: MIME_MAP[ext] || "audio/mpeg",
  };
}

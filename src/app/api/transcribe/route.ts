import { NextRequest, NextResponse } from "next/server";
import OpenAI, { toFile } from "openai";
import { extract3gpAmrData } from "@/app/utils/extract3gpAmr";

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

const MAX_SIZE = 25 * 1024 * 1024; // 25MB

function isAmrFile(buffer: Buffer): boolean {
  return buffer.length >= 6 && buffer.toString("ascii", 0, 6) === "#!AMR\n";
}

function isMp4Container(buffer: Buffer): boolean {
  // MP4/M4A/3GP 등 ISO Base Media 형식: offset 4-7이 "ftyp"
  return buffer.length >= 8 && buffer.toString("ascii", 4, 8) === "ftyp";
}

function convertAmrToWav(amrBuffer: Buffer): Buffer {
  // amr-js/library/amrnb.js: 순수 JS(asm.js) AMR-NB 디코더
  // AMR.toWAV(Uint8Array) → Uint8Array (WAV 8kHz 16bit mono)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AMR = require("amr-js/library/amrnb");
  const amrData = new Uint8Array(amrBuffer);
  const wavData: Uint8Array | null = AMR.toWAV(amrData);
  if (!wavData) {
    throw new Error("AMR 디코딩 실패");
  }
  return Buffer.from(wavData);
}

export async function POST(request: NextRequest) {
  let file: File | null = null;
  let magicHex = "";
  try {
    const formData = await request.formData();
    file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "파일이 없습니다." },
        { status: 400 }
      );
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: "파일 크기가 25MB를 초과합니다." },
        { status: 400 }
      );
    }

    console.log(`[DEBUG] original name: ${file.name}, type: ${file.type}, size: ${file.size}`);

    const inputBuffer = Buffer.from(await file.arrayBuffer());
    magicHex = inputBuffer.subarray(0, 16).toString("hex");
    const magicAscii = inputBuffer.subarray(0, 16).toString("ascii").replace(/[^\x20-\x7E]/g, ".");
    console.log(`[DEBUG] magic hex: ${magicHex}`);
    console.log(`[DEBUG] magic ascii: ${magicAscii}`);

    let uploadBuffer: Buffer;
    let uploadName: string;
    let uploadType: string;

    if (isAmrFile(inputBuffer)) {
      // AMR → WAV 변환 (순수 JS 디코더, 네이티브 바이너리 불필요)
      console.log("[DEBUG] AMR detected, converting to WAV...");
      try {
        uploadBuffer = convertAmrToWav(inputBuffer);
        uploadName = "audio.wav";
        uploadType = "audio/wav";
        console.log(`[DEBUG] WAV conversion done, size: ${uploadBuffer.length}`);
      } catch (amrError: unknown) {
        const msg = amrError instanceof Error ? amrError.message : String(amrError);
        return NextResponse.json(
          {
            error: "AMR 파일 변환 실패",
            debug: { originalName: file.name, type: file.type, size: file.size, amrError: msg },
          },
          { status: 422 }
        );
      }
    } else if (isMp4Container(inputBuffer)) {
      // 3GP/3G2 with AMR-NB audio: extract raw AMR frames from the mdat box,
      // prepend "#!AMR\n", then decode to WAV with amr-js.
      // Falls back to forwarding the raw container if AMR extraction fails.
      console.log("[DEBUG] MP4/ftyp container detected");
      const is3gp = inputBuffer.toString("ascii", 8, 12).startsWith("3gp");
      if (is3gp) {
        console.log("[DEBUG] 3GP brand detected, extracting AMR from mdat...");
        try {
          const amrBuffer = extract3gpAmrData(inputBuffer);
          console.log(`[DEBUG] AMR extracted (${amrBuffer.length} bytes), converting to WAV...`);
          uploadBuffer = convertAmrToWav(amrBuffer);
          uploadName = "audio.wav";
          uploadType = "audio/wav";
          console.log(`[DEBUG] WAV conversion done, size: ${uploadBuffer.length}`);
        } catch (extractError: unknown) {
          // Fallback: send the container directly to Whisper
          const msg = extractError instanceof Error ? extractError.message : String(extractError);
          console.warn(`[DEBUG] AMR extraction failed (${msg}), falling back to .mp4 upload`);
          uploadBuffer = inputBuffer;
          uploadName = "audio.mp4";
          uploadType = "audio/mp4";
        }
      } else {
        console.log("[DEBUG] Non-3GP MP4 container, sending as .mp4");
        uploadBuffer = inputBuffer;
        uploadName = "audio.mp4";
        uploadType = "audio/mp4";
      }
    } else {
      // 기타 파일: 확장자 기반 MIME 매핑 후 그대로 전달
      const fileName = file.name.toLowerCase();
      const ext = fileName.match(/\.(m4a|mp3|aac|wav|ogg|webm|flac|mp4|mpeg|mpga|oga)$/)?.[1] || "mp3";
      const MIME_MAP: Record<string, string> = {
        m4a: "audio/mp4", mp3: "audio/mpeg", aac: "audio/aac",
        wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm", flac: "audio/flac",
        mp4: "audio/mp4", mpeg: "audio/mpeg", mpga: "audio/mpeg", oga: "audio/ogg",
      };
      uploadBuffer = inputBuffer;
      uploadName = `audio.${ext}`;
      uploadType = MIME_MAP[ext] || "audio/mpeg";
    }

    // Whisper API
    const uploadFile = await toFile(uploadBuffer, uploadName, { type: uploadType });
    const openai = getOpenAI();
    const transcription = await openai.audio.transcriptions.create({
      file: uploadFile,
      model: "whisper-1",
      language: "ko",
      response_format: "text",
    });

    const transcript = transcription as unknown as string;

    if (!transcript || transcript.trim().length === 0) {
      return NextResponse.json(
        { error: "음성을 인식할 수 없습니다. 녹음 상태를 확인해주세요." },
        { status: 422 }
      );
    }

    // GPT 요약
    const summaryResponse = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: [
        {
          role: "system",
          content: `당신은 산업재해(산재) 사고 관련 통화 녹음을 분석하는 전문가입니다.
통화 내용을 분석하여 아래 형식으로 정리해주세요.
법적으로 중요한 발언, 책임 소재에 관한 내용, 약속이나 합의 사항을 특히 주의 깊게 찾아주세요.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "briefSummary": "3-5줄로 핵심 내용을 요약",
  "participants": "통화에 참여한 사람들과 소속/역할 (파악 가능한 범위에서)",
  "keyPoints": "핵심 내용을 bullet point로 정리",
  "agreements": "약속하거나 합의한 사항 (없으면 '확인된 사항 없음')",
  "legallySignificant": "법적으로 중요한 발언이나 인정 사항 (책임 인정, 과실 언급, 안전 규정 위반 관련 등)",
  "cautions": "주의할 점이나 후속 조치가 필요한 사항"
}`,
        },
        {
          role: "user",
          content: `다음 통화 녹음 텍스트를 분석해주세요:\n\n${transcript}`,
        },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const summaryText = summaryResponse.choices[0]?.message?.content;
    if (!summaryText) {
      return NextResponse.json(
        { error: "요약 생성에 실패했습니다. 다시 시도해주세요." },
        { status: 500 }
      );
    }

    const summary = JSON.parse(summaryText);

    return NextResponse.json({
      transcript,
      summary,
    });
  } catch (error: unknown) {
    console.error("Transcription error:", error);

    if (error instanceof OpenAI.APIError) {
      if (error.status === 413) {
        return NextResponse.json(
          { error: "파일이 너무 큽니다. 25MB 이하 파일을 사용해주세요." },
          { status: 413 }
        );
      }
      return NextResponse.json(
        {
          error: `OpenAI API 오류: ${error.message}`,
          debug: { originalName: file?.name, type: file?.type, size: file?.size, magic: magicHex },
        },
        { status: 502 }
      );
    }

    const errMsg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: "처리 중 오류가 발생했습니다.",
        debug: { originalName: file?.name, type: file?.type, size: file?.size, detail: errMsg },
      },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import OpenAI, { toFile } from "openai";
import { prepareAudioForWhisper, splitWavIntoChunks } from "@/app/utils/audioProcessing";
import { createSummary } from "@/app/utils/summarize";

const isDev = process.env.NODE_ENV === "development";

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const MAX_SIZE = 25 * 1024 * 1024;
const WHISPER_LIMIT = 20 * 1024 * 1024;

const STATUS_MESSAGES: Record<number, string> = {
  400: "요청 형식이 잘못되었습니다.",
  401: "API 인증에 실패했습니다. 관리자에게 문의하세요.",
  404: "AI 모델을 찾을 수 없습니다.",
  413: "파일이 너무 큽니다. 25MB 이하 파일을 사용해주세요.",
  429: "API 사용량이 초과되었습니다. 1-2분 후 다시 시도해주세요.",
  500: "OpenAI 서버 오류입니다. 잠시 후 다시 시도해주세요.",
  502: "OpenAI 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.",
  503: "OpenAI 서비스가 일시적으로 중단되었습니다. 잠시 후 다시 시도해주세요.",
};

function log(msg: string) {
  if (isDev) console.log(`[DEBUG] ${msg}`);
}

async function transcribeBuffer(
  openai: OpenAI,
  buffer: Buffer,
  name: string,
  type: string,
): Promise<string> {
  const uploadFile = await toFile(buffer, name, { type });
  const transcription = await openai.audio.transcriptions.create({
    file: uploadFile,
    model: "whisper-1",
    language: "ko",
    response_format: "text",
  });
  return typeof transcription === "string" ? transcription : String(transcription);
}

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let file: File | null = null;
  try {
    // 1. 입력 검증
    const formData = await request.formData();
    file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "파일이 없습니다." }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: "파일 크기가 25MB를 초과합니다." }, { status: 400 });
    }

    log(`original name: ${file.name}, type: ${file.type}, size: ${file.size}`);

    // 2. 오디오 포맷 변환
    const inputBuffer = Buffer.from(await file.arrayBuffer());
    const audio = prepareAudioForWhisper(inputBuffer, file.name, log);

    // 3. Whisper 전사 (큰 WAV는 청크 분할 + 병렬 처리)
    const openai = getOpenAI();
    let transcript: string;
    let partialFailure: string | undefined;

    if (audio.type === "audio/wav" && audio.buffer.length > WHISPER_LIMIT) {
      const chunks = splitWavIntoChunks(audio.buffer, WHISPER_LIMIT);
      log(`WAV too large (${(audio.buffer.length / 1024 / 1024).toFixed(1)}MB), split into ${chunks.length} chunks`);

      const settled = await Promise.allSettled(
        chunks.map((chunk, i) => {
          log(`Transcribing chunk ${i + 1}/${chunks.length} (${(chunk.length / 1024 / 1024).toFixed(1)}MB)`);
          return transcribeBuffer(openai, chunk, `audio_${i}.wav`, "audio/wav");
        })
      );

      const successResults: string[] = [];
      const failedChunks: number[] = [];
      for (let i = 0; i < settled.length; i++) {
        if (settled[i].status === "fulfilled") {
          const text = (settled[i] as PromiseFulfilledResult<string>).value?.trim() ?? "";
          if (text.length > 0) successResults.push(text);
        } else {
          failedChunks.push(i + 1);
        }
      }

      if (successResults.length === 0) {
        return NextResponse.json({ error: "음성 변환에 실패했습니다. 다시 시도해주세요." }, { status: 502 });
      }

      transcript = successResults.join(" ");
      if (failedChunks.length > 0) {
        partialFailure = `일부 구간(${failedChunks.join(", ")}/${chunks.length})의 변환에 실패했습니다.`;
      }
    } else {
      transcript = await transcribeBuffer(openai, audio.buffer, audio.name, audio.type);
    }

    if (!transcript || transcript.trim().length === 0) {
      return NextResponse.json({ error: "음성을 인식할 수 없습니다. 녹음 상태를 확인해주세요." }, { status: 422 });
    }

    // 4. GPT 요약 (모델 폴백 체인)
    const summary = await createSummary(openai, transcript, log);

    // 5. 응답
    return NextResponse.json({
      transcript,
      summary,
      ...(partialFailure && { partialFailure }),
    });
  } catch (error: unknown) {
    console.error("Transcription error:", error);

    if (error instanceof OpenAI.APIError) {
      const userMessage = STATUS_MESSAGES[error.status ?? 0] || "처리 중 오류가 발생했습니다.";
      return NextResponse.json(
        {
          error: userMessage,
          ...(isDev && { debug: { name: file?.name, type: file?.type, size: file?.size, detail: error.message } }),
        },
        { status: error.status === 413 ? 413 : 502 },
      );
    }

    const errMsg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: errMsg.includes("모든 GPT 모델") ? errMsg : "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
        ...(isDev && { debug: { name: file?.name, type: file?.type, size: file?.size, detail: errMsg } }),
      },
      { status: 500 },
    );
  }
}

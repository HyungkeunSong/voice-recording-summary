import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

const ALLOWED_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/amr",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "video/webm",
  "audio/flac",
];

const MAX_SIZE = 25 * 1024 * 1024; // 25MB

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

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

    // 파일 확장자로도 체크 (모바일에서 MIME type이 부정확할 수 있음)
    const fileName = file.name.toLowerCase();
    const validExtensions = [
      ".m4a", ".mp3", ".aac", ".amr", ".wav", ".ogg", ".webm", ".flac", ".mp4",
    ];
    const hasValidExtension = validExtensions.some((ext) =>
      fileName.endsWith(ext)
    );
    const hasValidType = ALLOWED_TYPES.includes(file.type);

    if (!hasValidExtension && !hasValidType) {
      return NextResponse.json(
        {
          error:
            "지원하지 않는 파일 형식입니다. m4a, mp3, aac, amr, wav, ogg, webm 파일을 업로드해주세요.",
        },
        { status: 400 }
      );
    }

    // Step 1: Whisper API로 음성 → 텍스트
    const openai = getOpenAI();
    const transcription = await openai.audio.transcriptions.create({
      file: file,
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

    // Step 2: GPT로 요약 생성
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
        { error: `OpenAI API 오류: ${error.message}` },
        { status: 502 }
      );
    }

    return NextResponse.json(
      { error: "처리 중 오류가 발생했습니다. 다시 시도해주세요." },
      { status: 500 }
    );
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};

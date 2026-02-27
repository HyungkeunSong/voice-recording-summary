import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createSummary } from "@/app/utils/summarize";

const isDev = process.env.NODE_ENV === "development";

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function log(msg: string) {
  if (isDev) console.log(`[DEBUG] ${msg}`);
}

const STATUS_MESSAGES: Record<number, string> = {
  401: "API 인증에 실패했습니다. 관리자에게 문의하세요.",
  429: "API 사용량이 초과되었습니다. 1-2분 후 다시 시도해주세요.",
  500: "OpenAI 서버 오류입니다. 잠시 후 다시 시도해주세요.",
  502: "OpenAI 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.",
  503: "OpenAI 서비스가 일시적으로 중단되었습니다. 잠시 후 다시 시도해주세요.",
};

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const { transcript } = await request.json();

    if (!transcript || typeof transcript !== "string" || transcript.trim().length === 0) {
      return NextResponse.json({ error: "텍스트가 없습니다." }, { status: 400 });
    }

    log(`Summarizing transcript (${transcript.length} chars)`);

    const openai = getOpenAI();
    const summary = await createSummary(openai, transcript, log);

    return NextResponse.json({ summary });
  } catch (error: unknown) {
    console.error("Summary error:", error);

    if (error instanceof OpenAI.APIError) {
      const userMessage = STATUS_MESSAGES[error.status ?? 0] || "요약 중 오류가 발생했습니다.";
      return NextResponse.json({ error: userMessage }, { status: 502 });
    }

    const errMsg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: errMsg.includes("모든 GPT 모델") ? errMsg : "요약 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
      },
      { status: 500 },
    );
  }
}

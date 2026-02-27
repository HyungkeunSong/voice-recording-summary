import OpenAI from "openai";
import type { Summary } from "@/app/types";

const GPT_MODELS = ["gpt-5.2", "gpt-4o", "gpt-4o-mini"] as const;

const SYSTEM_PROMPT = `당신은 통화 녹음을 분석하는 전문가입니다.
통화 내용을 파악하여 누가 누구와 무슨 이야기를 했는지 명확하게 정리해주세요.

통화 내용에 법적 분쟁, 산업재해, 사고, 수사, 계약, 협상 등의 맥락이 포함된 경우:
- 법적으로 중요한 발언(책임 인정, 과실 언급, 약속, 합의)을 특히 주의 깊게 찾아주세요
- 직접 인용은 「」로 감싸서 원문 그대로 기록해주세요
해당 맥락이 없는 일반 통화의 경우 legallySignificant는 "해당 없음"으로 작성하세요.

반드시 아래 JSON 형식으로만 응답하세요.
각 필드의 텍스트는 항목별로 줄바꿈(\\n)하고 bullet(•)을 사용해 가독성 있게 작성하세요.

{
  "briefSummary": "핵심 내용을 3-5문장으로 요약. 각 문장 사이에 줄바꿈(\\n)을 넣어 구분.",
  "participants": "각 참여자를 줄바꿈으로 구분.\\n예: • 발신자: OOO (소속/역할)\\n• 수신자: OOO (소속/역할)",
  "keyPoints": "각 항목을 bullet(•)으로 구분.\\n예: • 핵심 내용 1\\n• 핵심 내용 2\\n• 핵심 내용 3",
  "agreements": "각 항목을 bullet(•)으로 구분. 약속, 합의, 다음 행동 항목 포함. 없으면 '확인된 사항 없음'",
  "legallySignificant": "법적으로 중요한 발언을 bullet(•)으로 구분. 직접 인용은 「」로 감싸기. 해당 없으면 '해당 없음'",
  "cautions": "각 항목을 bullet(•)으로 구분"
}`;

export async function createSummary(
  openai: OpenAI,
  transcript: string,
  log: (msg: string) => void,
): Promise<Summary> {
  for (const model of GPT_MODELS) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `다음 통화 녹음 텍스트를 분석해주세요:\n\n${transcript}` },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      const summaryText = response.choices[0]?.message?.content;
      if (!summaryText) {
        throw new Error("요약 생성에 실패했습니다.");
      }

      try {
        return JSON.parse(summaryText) as Summary;
      } catch {
        return {
          briefSummary: summaryText,
          participants: "자동 분석 불가",
          keyPoints: summaryText,
          agreements: "확인된 사항 없음",
          legallySignificant: "확인된 사항 없음",
          cautions: "AI 응답 형식 오류로 자동 분석이 불가했습니다. 위 텍스트를 직접 확인해주세요.",
        };
      }
    } catch (err: unknown) {
      if (err instanceof OpenAI.APIError && (err.status === 404 || err.status === 400)) {
        log(`Model ${model} unavailable (${err.status}), trying fallback...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error("모든 GPT 모델을 사용할 수 없습니다. 관리자에게 문의하세요.");
}

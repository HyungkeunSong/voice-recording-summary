"use client";

import { useState, useRef } from "react";

interface Summary {
  briefSummary: string;
  participants: string;
  keyPoints: string;
  agreements: string;
  legallySignificant: string;
  cautions: string;
}

interface Result {
  transcript: string;
  summary: Summary;
}

type ProcessingStep = "idle" | "uploading" | "transcribing" | "summarizing" | "done" | "error";

const STEP_LABELS: Record<ProcessingStep, string> = {
  idle: "",
  uploading: "파일 업로드 중...",
  transcribing: "음성을 텍스트로 변환 중...",
  summarizing: "내용 분석 및 요약 중...",
  done: "완료!",
  error: "오류 발생",
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<ProcessingStep>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      setFile(selected);
      setResult(null);
      setError("");
      setStep("idle");
    }
  };

  const handleSubmit = async () => {
    if (!file) return;

    setError("");
    setResult(null);
    setStep("uploading");

    try {
      const formData = new FormData();
      formData.append("file", file);

      setStep("transcribing");

      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        const debugInfo = data.debug ? `\n[디버그] name: ${data.debug.originalName}, type: ${data.debug.type}, size: ${data.debug.size}` : "";
        throw new Error((data.error || "처리 중 오류가 발생했습니다.") + debugInfo);
      }

      setStep("summarizing");
      const data: Result = await response.json();
      setResult(data);
      setStep("done");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
      setError(message);
      setStep("error");
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      // fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(label);
      setTimeout(() => setCopied(""), 2000);
    }
  };

  const formatDetailedAnalysis = (summary: Summary): string => {
    return `[통화 상대방]
${summary.participants}

[핵심 내용]
${summary.keyPoints}

[약속/합의 사항]
${summary.agreements}

[법적 중요 발언]
${summary.legallySignificant}

[주의할 점]
${summary.cautions}`;
  };

  const isProcessing = step === "uploading" || step === "transcribing" || step === "summarizing";

  return (
    <main className="min-h-screen px-4 py-6 max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-center mb-1">녹음 요약 도구</h1>
      <p className="text-sm text-gray-400 text-center mb-6">삼촌이 깨어나길 기도합니다</p>

      {/* 파일 선택 */}
      <div className="mb-4">
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.m4a,.mp3,.aac,.amr,.wav,.ogg,.webm,.flac"
          onChange={handleFileChange}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessing}
          className="w-full py-4 px-6 bg-white border-2 border-dashed border-gray-300 rounded-2xl text-lg font-medium text-gray-600 active:bg-gray-100 disabled:opacity-50"
        >
          {file ? `${file.name}` : "녹음 파일 선택"}
        </button>
        {file && (
          <p className="mt-2 text-sm text-gray-500 text-center">
            {(file.size / (1024 * 1024)).toFixed(1)}MB
          </p>
        )}
      </div>

      {/* 변환 버튼 */}
      <button
        onClick={handleSubmit}
        disabled={!file || isProcessing}
        className="w-full py-4 px-6 bg-blue-600 text-white text-lg font-bold rounded-2xl active:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 mb-6"
      >
        {isProcessing ? "처리 중..." : "변환 시작"}
      </button>

      {/* 진행 상태 */}
      {isProcessing && (
        <div className="mb-6 p-4 bg-blue-50 rounded-2xl">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-blue-800 font-medium">{STEP_LABELS[step]}</span>
          </div>
          <p className="mt-2 text-sm text-blue-600">
            파일 크기에 따라 1~3분 정도 걸릴 수 있습니다.
          </p>
        </div>
      )}

      {/* 에러 */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 rounded-2xl">
          <p className="text-red-700 font-medium">{error}</p>
        </div>
      )}

      {/* 결과 */}
      {result && (
        <div className="space-y-4">
          {/* 간단 요약 */}
          <ResultSection
            title="간단 요약"
            content={result.summary.briefSummary}
            onCopy={() => copyToClipboard(result.summary.briefSummary, "brief")}
            isCopied={copied === "brief"}
          />

          {/* 상세 분석 */}
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold">상세 분석</h2>
              <CopyButton
                onClick={() => copyToClipboard(formatDetailedAnalysis(result.summary), "detail")}
                isCopied={copied === "detail"}
              />
            </div>

            <DetailItem label="통화 상대방" content={result.summary.participants} />
            <DetailItem label="핵심 내용" content={result.summary.keyPoints} />
            <DetailItem label="약속/합의 사항" content={result.summary.agreements} />
            <DetailItem
              label="법적 중요 발언"
              content={result.summary.legallySignificant}
              highlight
            />
            <DetailItem label="주의할 점" content={result.summary.cautions} />
          </div>

          {/* 전체 텍스트 */}
          <ResultSection
            title="전체 텍스트"
            content={result.transcript}
            onCopy={() => copyToClipboard(result.transcript, "transcript")}
            isCopied={copied === "transcript"}
          />
        </div>
      )}
    </main>
  );
}

function ResultSection({
  title,
  content,
  onCopy,
  isCopied,
}: {
  title: string;
  content: string;
  onCopy: () => void;
  isCopied: boolean;
}) {
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold">{title}</h2>
        <CopyButton onClick={onCopy} isCopied={isCopied} />
      </div>
      <p className="text-gray-700 whitespace-pre-wrap leading-relaxed">{content}</p>
    </div>
  );
}

function DetailItem({
  label,
  content,
  highlight,
}: {
  label: string;
  content: string;
  highlight?: boolean;
}) {
  return (
    <div className={`mb-3 p-3 rounded-xl ${highlight ? "bg-yellow-50 border border-yellow-200" : "bg-gray-50"}`}>
      <h3 className={`text-sm font-bold mb-1 ${highlight ? "text-yellow-800" : "text-gray-500"}`}>
        {label}
      </h3>
      <p className={`whitespace-pre-wrap leading-relaxed ${highlight ? "text-yellow-900" : "text-gray-700"}`}>
        {content}
      </p>
    </div>
  );
}

function CopyButton({ onClick, isCopied }: { onClick: () => void; isCopied: boolean }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-100 text-gray-600 active:bg-gray-200"
    >
      {isCopied ? "복사됨!" : "복사"}
    </button>
  );
}
